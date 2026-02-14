import JSON5 from "json5";
import { LEGACY_MANIFEST_KEYS, MANIFEST_KEY } from "../compat/legacy-names.js";
import { parseBooleanValue } from "../utils/boolean.js";

export function normalizeStringList(input: unknown): string[] {
  if (!input) {
    return [];
  }
  if (Array.isArray(input)) {
    return input.map((value) => String(value).trim()).filter(Boolean);
  }
  if (typeof input === "string") {
    return input
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return [];
}

export function getFrontmatterString(
  frontmatter: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = frontmatter[key];
  return typeof raw === "string" ? raw : undefined;
}

export function parseFrontmatterBool(value: string | undefined, fallback: boolean): boolean {
  const parsed = parseBooleanValue(value);
  return parsed === undefined ? fallback : parsed;
}

export function resolveOpenClawManifestBlock(params: {
  frontmatter: Record<string, unknown>;
  key?: string;
}): Record<string, unknown> | undefined {
  const raw = getFrontmatterString(params.frontmatter, params.key ?? "metadata");
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON5.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }

    const manifestKeys = [MANIFEST_KEY, ...LEGACY_MANIFEST_KEYS];
    for (const key of manifestKeys) {
      const candidate = (parsed as Record<string, unknown>)[key];
      if (candidate && typeof candidate === "object") {
        return candidate as Record<string, unknown>;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
