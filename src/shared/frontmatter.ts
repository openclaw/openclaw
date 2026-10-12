// Shared frontmatter helpers parse Markdown frontmatter blocks and body text.
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeCsvOrLooseStringList } from "@openclaw/normalization-core/string-normalization";
import JSON5 from "json5";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import type { Requirements } from "./requirements.js";

/** Reads a frontmatter field only when it is represented as a string value. */
export function getFrontmatterString(
  frontmatter: Record<string, unknown>,
  key: string,
): string | undefined {
  return readStringValue(frontmatter[key]);
}

/** Parses boolean frontmatter strings while preserving the caller's default for missing values. */
export function parseFrontmatterBool(value: string | undefined, fallback: boolean): boolean {
  const parsed = parseBooleanValue(value);
  return parsed === undefined ? fallback : parsed;
}

/** Parses the JSON5 OpenClaw manifest block embedded inside a string frontmatter field. */
export function resolveOpenClawManifestBlock(params: {
  frontmatter: Record<string, unknown>;
  key?: string;
}): Record<string, unknown> | undefined {
  const raw = getFrontmatterString(params.frontmatter, params.key ?? "metadata");
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = asOptionalObjectRecord(parseJsonWithJson5Fallback(raw, JSON5));
    if (!parsed) {
      return undefined;
    }

    return asOptionalObjectRecord(parsed[MANIFEST_KEY]);
  } catch {
    return undefined;
  }
}

/** Extracts normalized runtime requirement lists from an OpenClaw manifest block. */
export function resolveOpenClawManifestRequires(
  metadataObj: Record<string, unknown>,
): Omit<Requirements, "os"> | undefined {
  const requiresRaw = asOptionalObjectRecord(metadataObj.requires);
  if (!requiresRaw) {
    return undefined;
  }
  return {
    bins: normalizeCsvOrLooseStringList(requiresRaw.bins),
    anyBins: normalizeCsvOrLooseStringList(requiresRaw.anyBins),
    env: normalizeCsvOrLooseStringList(requiresRaw.env),
    config: normalizeCsvOrLooseStringList(requiresRaw.config),
  };
}

/** Parses manifest install entries with a caller-owned parser and drops unsupported specs. */
export function resolveOpenClawManifestInstall<T>(
  metadataObj: Record<string, unknown>,
  parseInstallSpec: (input: unknown) => T | undefined,
): T[] {
  const installRaw = Array.isArray(metadataObj.install)
    ? (metadataObj.install as unknown[])
    : metadataObj.install && typeof metadataObj.install === "object"
      ? [metadataObj.install]
      : [];
  return installRaw
    .map((entry) => parseInstallSpec(entry))
    .filter((entry): entry is T => Boolean(entry));
}

/** Extracts normalized OS allowlist entries from an OpenClaw manifest block. */
export function resolveOpenClawManifestOs(metadataObj: Record<string, unknown>): string[] {
  return normalizeCsvOrLooseStringList(metadataObj.os);
}

type ParsedOpenClawManifestInstallBase = {
  /** Original install entry for caller-specific parsing. */
  raw: Record<string, unknown>;
  /** Normalized install kind accepted by the caller. */
  kind: string;
  /** Optional stable package/tool id from the manifest entry. */
  id?: string;
  /** Optional human-facing package/tool label. */
  label?: string;
  /** Optional binaries expected after installation. */
  bins?: string[];
};

/** Parses kind/type plus common install fields shared by package-manager install specs. */
export function parseOpenClawManifestInstallBase(
  input: unknown,
  allowedKinds: readonly string[],
): ParsedOpenClawManifestInstallBase | undefined {
  const raw = asOptionalObjectRecord(input);
  if (!raw) {
    return undefined;
  }
  const kindRaw =
    typeof raw.kind === "string" ? raw.kind : typeof raw.type === "string" ? raw.type : "";
  const kind = normalizeOptionalLowercaseString(kindRaw) ?? "";
  if (!allowedKinds.includes(kind)) {
    return undefined;
  }

  const common = {
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    ...(typeof raw.label === "string" ? { label: raw.label } : {}),
  };
  const bins = normalizeCsvOrLooseStringList(raw.bins);
  return { raw, kind, ...common, ...(bins.length > 0 ? { bins } : {}) };
}

/** Copies optional common install fields onto a caller-specific install spec object. */
export function applyOpenClawManifestInstallCommonFields<
  T extends { id?: string; label?: string; bins?: string[] },
>(spec: T, parsed: Pick<ParsedOpenClawManifestInstallBase, "id" | "label" | "bins">): T {
  if (parsed.id) {
    spec.id = parsed.id;
  }
  if (parsed.label) {
    spec.label = parsed.label;
  }
  if (parsed.bins) {
    spec.bins = parsed.bins;
  }
  return spec;
}
