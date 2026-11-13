import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { PROFILE_OPTIONS } from "../agents/core-tool-facts.js";
import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import {
  expandToolGroups,
  normalizeToolPolicyName,
  resolveToolProfilePolicy,
} from "../agents/tool-policy-shared.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { computeNextRunAtMs } from "../cron/schedule.js";
import { isDangerousHostEnvVarName } from "../infra/host-env-security.js";
import { isRenderableAvatarImageDataUrl } from "../shared/avatar-limits.js";
import {
  TEMPLATE_BOOTSTRAP_FILE_NAMES,
  TEMPLATE_PACKAGE_SOURCE,
  TEMPLATE_SCHEMA_VERSION,
  type TemplateDiagnostic,
} from "./manifest-contract.js";
import {
  conflictsWithTemplatePath,
  isCanonicalClawHubPackageName,
  isTemplatePackageManagerArtifactPinned,
  isExactSemVer,
  isPortableTemplateAvatar,
  isSafeTemplateRelativePath,
  isValidTemplateTimezone,
  portableTemplatePathKey,
} from "./schema-portability.js";
import {
  isConcreteBundleMcpToolName,
  resolveTemplateToolProfileSnapshot,
} from "./tool-profile-consent.js";

const nonEmptyString = z
  .string()
  .min(1)
  .refine(
    (value) => value.length === value.trim().length && value.length > 0,
    "Value must not have leading or trailing whitespace.",
  );
const optionalString = nonEmptyString.optional();

function isBoundedTemplateToolGrant(value: string): boolean {
  const normalized = normalizeToolPolicyName(value);
  if (
    /[*?[\]{}]/u.test(normalized) ||
    normalized === "group:plugins" ||
    normalized === "bundle-mcp"
  ) {
    return false;
  }
  return !normalized.startsWith("group:") || expandToolGroups([normalized])[0] !== normalized;
}

export function templateManifestWorkspaceConflictsWithPath(
  manifest: TemplateManifest,
  path: string,
): boolean {
  const targets = new Set<string>();
  for (const name of TEMPLATE_BOOTSTRAP_FILE_NAMES) {
    if (manifest.workspace.bootstrapFiles[name]) {
      targets.add(portableTemplatePathKey(name));
    }
  }
  for (const file of manifest.workspace.files) {
    targets.add(portableTemplatePathKey(file.path));
  }
  return conflictsWithTemplatePath(targets, portableTemplatePathKey(path));
}

const agentId = nonEmptyString.regex(
  /^[a-z][a-z0-9_-]{0,63}$/,
  "Agent id must start with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens.",
);
const exactVersion = nonEmptyString.refine(
  isExactSemVer,
  "Package version must be an exact semantic version.",
);
const clawHubPackageName = nonEmptyString.refine(
  isCanonicalClawHubPackageName,
  "ClawHub package references must use their lowercase name.",
);
const portableEnvKey = /^[A-Za-z_][A-Za-z0-9_]*$/;

const packageRelativePath = nonEmptyString
  .refine(isSafeTemplateRelativePath, {
    message: "Path must be package-relative and must not contain traversal segments.",
  })
  .transform((value) => value.replaceAll("\\", "/"));

const identitySchema = z
  .object({
    name: optionalString,
    theme: optionalString,
    emoji: optionalString,
    avatar: nonEmptyString
      .refine(isPortableTemplateAvatar, {
        message:
          "Avatar must be a bounded image data URL or managed workspace-relative image path.",
      })
      .optional(),
  })
  .strict();

const agentIdentitySchema = z
  .object({
    id: agentId,
    name: optionalString,
    description: optionalString,
    identity: identitySchema.optional(),
  })
  .strict();

const agentSettingsSchema = z
  .object({
    groupChat: z
      .object({ mentionPatterns: z.array(nonEmptyString).min(1).optional() })
      .strict()
      .optional(),
    sandbox: z
      .object({
        mode: z.enum(["off", "non-main", "all"]).optional(),
        scope: z.enum(["session", "agent", "shared"]).optional(),
        workspaceAccess: z.enum(["none", "ro", "rw"]).optional(),
      })
      .strict()
      .optional(),
    tools: z
      .object({
        profile: z.enum(PROFILE_OPTIONS.map(({ id }) => id)).optional(),
        allow: z
          .array(nonEmptyString.refine(isBoundedTemplateToolGrant, "Tool grants must be bounded."))
          .min(1)
          .optional(),
        alsoAllow: z
          .array(nonEmptyString.refine(isBoundedTemplateToolGrant, "Tool grants must be bounded."))
          .min(1)
          .optional(),
        deny: z.array(nonEmptyString).min(1).optional(),
        fs: z
          .object({ workspaceOnly: z.literal(true).optional() })
          .strict()
          .optional(),
      })
      .strict()
      .superRefine((tools, ctx) => {
        if (tools.profile === "full" && !tools.allow) {
          ctx.addIssue({
            code: "custom",
            path: ["profile"],
            message: "The full tool profile requires a bounded explicit allowlist.",
          });
        }
        if (tools.profile && tools.profile !== "full" && tools.allow) {
          const profileAllow = expandToolGroups(resolveToolProfilePolicy(tools.profile)?.allow);
          if (
            tools.allow.some(
              (grant) =>
                !profileAllow.some((tool) => isToolAllowedByPolicyName(tool, { allow: [grant] })) &&
                !(profileAllow.includes("bundle-mcp") && isConcreteBundleMcpToolName(grant)),
            )
          ) {
            ctx.addIssue({
              code: "custom",
              path: ["allow"],
              message: "Every agent tools allow grant must overlap the selected profile.",
            });
          }
        }
        if (
          tools.profile &&
          resolveTemplateToolProfileSnapshot(tools)?.allow.includes("bundle-mcp")
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["allow"],
            message:
              "Profiles containing bundle-mcp require a bounded allowlist of concrete tool names.",
          });
        }
        if (tools.alsoAllow && !tools.profile) {
          ctx.addIssue({
            code: "custom",
            path: ["alsoAllow"],
            message: "Agent tools can set alsoAllow only when a bounded profile is selected.",
          });
        }
        if (tools.allow && tools.alsoAllow) {
          ctx.addIssue({
            code: "custom",
            path: ["alsoAllow"],
            message:
              "Agent tools cannot set both allow and alsoAllow; use allow alone or profile with alsoAllow.",
          });
        }
      })
      .optional(),
    memory: z
      .object({
        search: z
          .object({
            enabled: z.boolean().optional(),
            rememberAcrossConversations: z.boolean().optional(),
            sources: z
              .array(z.enum(["memory", "sessions"]))
              .min(1)
              .optional(),
          })
          .strict()
          .superRefine((search, ctx) => {
            if (
              search.sources?.includes("sessions") &&
              search.rememberAcrossConversations !== true
            ) {
              ctx.addIssue({
                code: "custom",
                path: ["rememberAcrossConversations"],
                message:
                  "The sessions source requires rememberAcrossConversations: true in agent.memory.search.",
              });
            }
          })
          .optional(),
      })
      .strict()
      .optional(),
    heartbeat: z
      .object({
        every: nonEmptyString
          .refine((value) => {
            try {
              parseDurationMs(value, { defaultUnit: "m" });
              return true;
            } catch {
              return false;
            }
          }, "Invalid heartbeat duration.")
          .optional(),
        activeHours: z
          .object({
            start: nonEmptyString.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
            end: nonEmptyString.regex(/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/).optional(),
            timezone: nonEmptyString
              .refine(isValidTemplateTimezone, "Invalid IANA timezone.")
              .optional(),
          })
          .strict()
          .optional(),
        lightContext: z.boolean().optional(),
        isolatedSession: z.boolean().optional(),
        timeoutSeconds: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    humanDelay: z
      .object({
        mode: z.enum(["off", "natural", "custom"]).optional(),
        minMs: z.number().int().nonnegative().optional(),
        maxMs: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const agentSchema = agentIdentitySchema.extend(agentSettingsSchema.shape);

const workspaceSourceSchema = z.object({ source: packageRelativePath }).strict();
const bootstrapFilesSchema = z
  .object(
    Object.fromEntries(
      TEMPLATE_BOOTSTRAP_FILE_NAMES.map((name) => [name, workspaceSourceSchema.optional()]),
    ) as Record<
      (typeof TEMPLATE_BOOTSTRAP_FILE_NAMES)[number],
      z.ZodOptional<typeof workspaceSourceSchema>
    >,
  )
  .partial()
  .strict();

const workspaceFileSchema = z
  .object({ source: packageRelativePath, path: packageRelativePath })
  .strict();

const workspaceSchema = z
  .object({
    bootstrapFiles: bootstrapFilesSchema.optional().default({}),
    files: z.array(workspaceFileSchema).optional().default([]),
  })
  .strict()
  .default({ bootstrapFiles: {}, files: [] });

const dependencyReferenceSchema = z
  .object({
    ref: clawHubPackageName,
    version: exactVersion,
  })
  .strict();

const bundledDependencySchema = z.object({ path: packageRelativePath }).strict();
const dependencySchema = z.unknown().transform((value, ctx) => {
  const schema =
    isRecord(value) && Object.hasOwn(value, "path")
      ? bundledDependencySchema
      : dependencyReferenceSchema;
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  for (const issue of parsed.error.issues) {
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
  return z.NEVER;
});

const environmentReference = nonEmptyString.regex(
  /^\$\{[A-Z_][A-Z0-9_]*\}$/,
  "MCP environment values must be unresolved ${ENV_VAR} references.",
);

const mcpToolFilterSchema = z
  .object({
    include: z.array(nonEmptyString).min(1).optional(),
    exclude: z.array(nonEmptyString).min(1).optional(),
  })
  .strict()
  .superRefine((filter, ctx) => {
    for (const field of ["include", "exclude"] as const) {
      const seen = new Set<string>();
      for (const [index, value] of (filter[field] ?? []).entries()) {
        if (value.includes("?") || value.includes("[") || value.includes("]")) {
          ctx.addIssue({
            code: "custom",
            path: [field, index],
            message: "Tool filters support only exact names and * wildcards.",
          });
        }
        if (seen.has(value)) {
          ctx.addIssue({
            code: "custom",
            path: [field, index],
            message: "Tool filter entries must be unique.",
          });
        }
        seen.add(value);
      }
    }
  });

const mcpServerCommonShape = {
  toolFilter: mcpToolFilterSchema.optional(),
  timeout: z.number().finite().positive().optional(),
  connectTimeout: z.number().finite().positive().optional(),
};

const stdioMcpServerSchema = z
  .object({
    command: nonEmptyString,
    transport: z.literal("stdio").optional(),
    args: z.array(nonEmptyString).optional(),
    env: z
      .record(
        nonEmptyString.regex(portableEnvKey, "Invalid portable environment key."),
        environmentReference,
      )
      .optional(),
    ...mcpServerCommonShape,
  })
  .strict()
  .superRefine((server, ctx) => {
    if (isTemplatePackageManagerArtifactPinned(server.command, server.args ?? []) === false) {
      ctx.addIssue({
        code: "custom",
        path: ["args"],
        message: "Package-manager MCP commands must select one exact immutable package version.",
      });
    }
    for (const key of Object.keys(server.env ?? {})) {
      if (isDangerousHostEnvVarName(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["env", key],
          message: "Environment key is blocked by the spawned-process safety policy.",
        });
      }
    }
  });

const remoteMcpServerSchema = z
  .object({
    url: nonEmptyString.url(),
    transport: z.enum(["sse", "streamable-http"]),
    auth: z.literal("oauth").optional(),
    ...mcpServerCommonShape,
  })
  .strict()
  .superRefine((server, ctx) => {
    const url = new URL(server.url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "Remote MCP URLs must use HTTPS, except HTTP on an exact loopback host.",
      });
    }
    if (url.username || url.password || url.hash) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "Remote MCP URLs must not contain user information or fragments.",
      });
    }
  });

export const mcpServerSchema = z.union([stdioMcpServerSchema, remoteMcpServerSchema]);

export const cronJobSchema = z
  .object({
    id: agentId,
    name: optionalString,
    enabled: z.boolean().optional(),
    schedule: z.object({ cron: nonEmptyString, timezone: nonEmptyString }).strict(),
    session: z.enum(["main", "isolated"]),
    message: nonEmptyString,
    delivery: z
      .object({
        mode: z.enum(["none", "announce"]),
        channel: z.literal("last").optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((job, ctx) => {
    if (job.schedule.cron.trim().split(/\s+/).length !== 5) {
      ctx.addIssue({
        code: "custom",
        path: ["schedule", "cron"],
        message: "Cron schedule must use exactly five fields.",
      });
    }
    if (
      (job.delivery?.mode === "none" && job.delivery.channel !== undefined) ||
      (job.delivery?.mode === "announce" && job.delivery.channel !== "last")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["delivery"],
        message: 'Delivery must be { mode: "none" } or { mode: "announce", channel: "last" }.',
      });
    }
    try {
      computeNextRunAtMs(
        { kind: "cron", expr: job.schedule.cron, tz: job.schedule.timezone },
        Date.now(),
      );
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["schedule", "cron"],
        message: "Invalid cron expression or timezone.",
      });
    }
  });

const manifestSchema = z
  .object({
    schemaVersion: z.literal(TEMPLATE_SCHEMA_VERSION),
    agent: agentSchema,
    categories: z
      .array(nonEmptyString.regex(/^[a-z][a-z0-9-]*$/, "Category must be a lowercase slug."))
      .min(1)
      .max(3)
      .refine((categories) => new Set(categories).size === categories.length, {
        message: "Categories must be unique.",
      })
      .optional(),
    metadata: z.record(nonEmptyString, z.string()).optional().default({}),
    workspace: workspaceSchema.optional().default({ bootstrapFiles: {}, files: [] }),
    skills: z.array(dependencySchema).optional().default([]),
    plugins: z.array(dependencySchema).optional().default([]),
    mcpServers: z
      .record(
        nonEmptyString.regex(/^[a-z][a-z0-9_-]{0,63}$/, "Invalid MCP server name."),
        mcpServerSchema,
      )
      .optional()
      .default({}),
    automations: z.array(cronJobSchema).optional().default([]),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const workspaceTargets = new Set<string>();
    const nativeBootstrapTarget = new Set([portableTemplatePathKey("BOOTSTRAP.md")]);
    for (const name of TEMPLATE_BOOTSTRAP_FILE_NAMES) {
      if (manifest.workspace.bootstrapFiles[name]) {
        workspaceTargets.add(portableTemplatePathKey(name));
      }
    }
    manifest.workspace.files.forEach((file, index) => {
      const destinationKey = portableTemplatePathKey(file.path);
      if (conflictsWithTemplatePath(nativeBootstrapTarget, destinationKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["workspace", "files", index, "path"],
          message:
            "Package-root BOOTSTRAP.md uses the native seed-once lifecycle and cannot be a managed workspace destination.",
        });
      }
      if (conflictsWithTemplatePath(workspaceTargets, destinationKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["workspace", "files", index, "path"],
          message: `Workspace destination ${JSON.stringify(file.path)} is declared more than once.`,
        });
      }
      workspaceTargets.add(destinationKey);
    });

    const bundledPaths = new Set<string>();
    for (const kind of ["skills", "plugins"] as const) {
      const refs = new Set<string>();
      manifest[kind].forEach((dependency, index) => {
        if ("path" in dependency) {
          const key = portableTemplatePathKey(dependency.path);
          if (conflictsWithTemplatePath(bundledPaths, key)) {
            ctx.addIssue({
              code: "custom",
              path: [kind, index, "path"],
              message: "Bundled dependency directories must not overlap.",
            });
          }
          bundledPaths.add(key);
        } else {
          if (refs.has(dependency.ref)) {
            ctx.addIssue({
              code: "custom",
              path: [kind, index, "ref"],
              message: `Dependency ${JSON.stringify(dependency.ref)} is declared more than once in ${kind}.`,
            });
          }
          refs.add(dependency.ref);
        }
      });
    }

    const managedPaths = new Set(
      manifest.workspace.files.map((file) => portableTemplatePathKey(file.path)),
    );
    const avatar = manifest.agent.identity?.avatar;
    if (
      avatar &&
      !isRenderableAvatarImageDataUrl(avatar) &&
      !managedPaths.has(portableTemplatePathKey(avatar))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["agent", "identity", "avatar"],
        message: "Workspace-relative avatar must match a workspace.files destination.",
      });
    }

    const cronIds = new Set<string>();
    manifest.automations.forEach((job, index) => {
      if (cronIds.has(job.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["automations", index, "id"],
          message: `Cron job id ${JSON.stringify(job.id)} is declared more than once.`,
        });
      }
      cronIds.add(job.id);
    });
  });

type TemplateDependencyReference = z.output<typeof dependencyReferenceSchema>;
export type TemplateBundledDependency = {
  kind: "skill" | "plugin";
  source: "bundled";
  path: string;
  /** Derived from the validated source entrypoint; never authored in CLAW.md. */
  name?: string;
};
export type TemplateDependency = TemplatePackage | TemplateBundledDependency;
export type TemplatePackage = TemplateDependencyReference & {
  kind: "skill" | "plugin";
  source: typeof TEMPLATE_PACKAGE_SOURCE;
};
export type TemplateMcpServer = z.output<typeof mcpServerSchema>;
export type TemplateCronJob = z.output<typeof cronJobSchema>;
export type TemplateManifest = Omit<z.output<typeof manifestSchema>, "metadata"> & {
  metadata?: Record<string, string>;
};

function formatIssuePath(path: PropertyKey[]): string {
  if (path.length === 0) {
    return "$";
  }
  return `$${path
    .map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`))
    .join("")}`;
}

function diagnosticsFromZodError(error: z.ZodError): TemplateDiagnostic[] {
  return error.issues.map((issue) => ({
    level: "error",
    code: "invalid_manifest",
    phase: "schema",
    path: formatIssuePath(issue.path),
    message: issue.message,
  }));
}

export function parseTemplateManifest(
  value: unknown,
):
  | { ok: true; manifest: TemplateManifest; diagnostics: TemplateDiagnostic[] }
  | { ok: false; diagnostics: TemplateDiagnostic[] } {
  if (isRecord(value)) {
    const retired = ["packages", "profiles", "cronJobs"].filter((key) => Object.hasOwn(value, key));
    const profilePointer =
      isRecord(value.metadata) && Object.hasOwn(value.metadata, "openclaw.config");
    if (retired.length || profilePointer) {
      return {
        ok: false,
        diagnostics: [
          {
            level: "error",
            code: "retired_template_configuration",
            phase: "schema",
            path: profilePointer ? "$.metadata.openclaw.config" : `$.${retired[0]}`,
            message:
              "Move native settings into CLAW.md agent and exact ClawHub references into skills/plugins. Use automations for scheduled work; remove packages, profiles, cronJobs, and metadata.openclaw.config; keep schemaVersion: 1.",
          },
        ],
      };
    }
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, diagnostics: diagnosticsFromZodError(parsed.error) };
  }
  return { ok: true, manifest: parsed.data, diagnostics: [] };
}
