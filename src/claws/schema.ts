// Zod schema and parser for openclaw.claw.v1 manifests.
import { z } from "zod";
import {
  CLAW_SCHEMA_VERSION,
  type ClawDiagnostic,
  type ClawEntry,
  type ClawManifest,
  type ClawReadResult,
  type ClawUnknownEntry,
} from "./types.js";

const nonEmptyString = z.string().trim().min(1);
const optionalString = z.string().trim().min(1).optional();

const entryBaseSchema = z
  .object({
    id: nonEmptyString,
    required: z.boolean().optional(),
    description: optionalString,
  })
  .strict();

const packageEntrySchema = entryBaseSchema
  .extend({
    kind: z.enum(["skill", "plugin", "mcpServer", "connector"]),
    selector: nonEmptyString,
  })
  .strict();

const fileEntrySchema = entryBaseSchema
  .extend({
    kind: z.enum(["workspaceFile", "persona"]),
    path: nonEmptyString,
    source: nonEmptyString,
  })
  .strict();

const automationEntrySchema = entryBaseSchema
  .extend({
    kind: z.enum(["heartbeat", "schedule", "automation"]),
    source: nonEmptyString,
    enableDefault: z.boolean().optional(),
  })
  .strict();

const knownEntrySchema = z.union([packageEntrySchema, fileEntrySchema, automationEntrySchema]);

type KnownEntrySchema =
  | typeof packageEntrySchema
  | typeof fileEntrySchema
  | typeof automationEntrySchema;

function schemaForKnownEntryKind(kind: string): KnownEntrySchema | undefined {
  if (["skill", "plugin", "mcpServer", "connector"].includes(kind)) {
    return packageEntrySchema;
  }
  if (["workspaceFile", "persona"].includes(kind)) {
    return fileEntrySchema;
  }
  if (["heartbeat", "schedule", "automation"].includes(kind)) {
    return automationEntrySchema;
  }
  return undefined;
}

const KNOWN_ENTRY_KINDS = new Set([
  "skill",
  "plugin",
  "mcpServer",
  "connector",
  "workspaceFile",
  "persona",
  "heartbeat",
  "schedule",
  "automation",
]);

const topLevelManifestSchema = z
  .object({
    schemaVersion: z.literal(CLAW_SCHEMA_VERSION),
    id: nonEmptyString,
    name: nonEmptyString,
    version: nonEmptyString,
    publisher: optionalString,
    description: optionalString,
    compatibility: z
      .object({
        minHostVersion: optionalString,
        surfaces: z.array(nonEmptyString).optional(),
      })
      .strict()
      .optional(),
    update: z
      .object({
        mode: z.enum(["pinned", "latest"]).optional(),
      })
      .strict()
      .optional(),
    entries: z.array(z.unknown()).min(1),
  })
  .strict();

const entryKindProbeSchema = z
  .object({
    kind: nonEmptyString,
  })
  .passthrough();

const unknownEntryProbeSchema = z.object({
  kind: nonEmptyString,
  id: optionalString,
  required: z.boolean().optional(),
  description: optionalString,
});

function formatIssuePath(path: PropertyKey[]): string {
  if (path.length === 0) {
    return "$";
  }
  return `$${path
    .map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`))
    .join("")}`;
}

function diagnosticsFromZodError(error: z.ZodError, pathPrefix = "$"): ClawDiagnostic[] {
  return error.issues.map((issue) => ({
    level: "error",
    code: "invalid_manifest",
    path:
      pathPrefix === "$"
        ? formatIssuePath(issue.path)
        : `${pathPrefix}${issue.path.length ? formatIssuePath(issue.path).slice(1) : ""}`,
    message: issue.message,
  }));
}

function normalizeKnownEntry(value: z.infer<typeof knownEntrySchema>): ClawEntry {
  return {
    ...value,
    required: value.required ?? true,
  } as ClawEntry;
}

function parseEntry(
  value: unknown,
  index: number,
): { entry?: ClawEntry; unknown?: ClawUnknownEntry; diagnostics: ClawDiagnostic[] } {
  const kindProbe = entryKindProbeSchema.safeParse(value);
  const knownKindSchema = kindProbe.success
    ? schemaForKnownEntryKind(kindProbe.data.kind)
    : undefined;

  if (knownKindSchema) {
    const parsed = knownKindSchema.safeParse(value);
    if (parsed.success) {
      return { entry: normalizeKnownEntry(parsed.data), diagnostics: [] };
    }
    return { diagnostics: diagnosticsFromZodError(parsed.error, `$.entries[${index}]`) };
  }

  const parsed = knownEntrySchema.safeParse(value);
  if (parsed.success) {
    return { entry: normalizeKnownEntry(parsed.data), diagnostics: [] };
  }

  const probed = unknownEntryProbeSchema.safeParse(value);
  if (
    probed.success &&
    probed.data.required === false &&
    !KNOWN_ENTRY_KINDS.has(probed.data.kind)
  ) {
    return {
      unknown: probed.data,
      diagnostics: [
        {
          level: "warning",
          code: "unsupported_optional_entry",
          path: `$.entries[${index}]`,
          message: `Optional claw entry kind ${JSON.stringify(probed.data.kind)} is not supported by this OpenClaw version.`,
        },
      ],
    };
  }

  return { diagnostics: diagnosticsFromZodError(parsed.error, `$.entries[${index}]`) };
}

export function parseClawManifest(value: unknown): ClawReadResult {
  const topLevel = topLevelManifestSchema.safeParse(value);
  if (!topLevel.success) {
    return { ok: false, diagnostics: diagnosticsFromZodError(topLevel.error) };
  }

  const entries: ClawEntry[] = [];
  const optionalUnknownEntries: ClawUnknownEntry[] = [];
  const diagnostics: ClawDiagnostic[] = [];

  topLevel.data.entries.forEach((entryValue, index) => {
    const result = parseEntry(entryValue, index);
    diagnostics.push(...result.diagnostics);
    if (result.entry) {
      entries.push(result.entry);
    }
    if (result.unknown) {
      optionalUnknownEntries.push(result.unknown);
    }
  });

  if (diagnostics.some((diagnostic) => diagnostic.level === "error")) {
    return { ok: false, diagnostics };
  }

  const manifest: ClawManifest = {
    schemaVersion: topLevel.data.schemaVersion,
    id: topLevel.data.id,
    name: topLevel.data.name,
    version: topLevel.data.version,
    ...(topLevel.data.publisher ? { publisher: topLevel.data.publisher } : {}),
    ...(topLevel.data.description ? { description: topLevel.data.description } : {}),
    ...(topLevel.data.compatibility ? { compatibility: topLevel.data.compatibility } : {}),
    ...(topLevel.data.update ? { update: topLevel.data.update } : {}),
    entries,
    optionalUnknownEntries,
  };

  return { ok: true, manifest, diagnostics };
}

export { CLAW_SCHEMA_VERSION };
