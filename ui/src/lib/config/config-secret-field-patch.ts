import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatConfigPatchPath } from "../../../../src/config/patch-replace-paths.js";
import { copyWithPathPatch } from "../config-form-utils.ts";

type ConfigPath = Array<string | number>;

function patchedCopy(source: unknown, path: ConfigPath, value: unknown): unknown {
  const patched = copyWithPathPatch(source, path, value);
  if (!patched.ok) {
    throw new Error("This setting can't be saved at its current location.");
  }
  return patched.value;
}

function hasItem(list: unknown, index: string | number): boolean {
  return Array.isArray(list) && typeof index === "number" && index < list.length;
}

/**
 * A merge patch carrying one field and nothing else from the saved config.
 * Whatever the saved config doesn't hold yet comes from the draft, so a new entry
 * reaches the Gateway whole; arrays only merge whole, so they are replaced.
 */
export function buildSecretFieldPatch(params: {
  base: Record<string, unknown>;
  draft: Record<string, unknown> | null | undefined;
  path: ConfigPath;
  value: unknown;
}): { patch: Record<string, unknown>; replacePaths: string[] } {
  const { path, value } = params;
  const patch: Record<string, unknown> = {};
  const replacePaths: string[] = [];
  let target = patch;
  let base: unknown = params.base;
  let draft: unknown = params.draft;
  let patchPath: string | undefined;
  for (const [index, segment] of path.entries()) {
    const key = String(segment);
    const rest = path.slice(index + 1);
    const baseChild = isRecord(base) ? base[key] : undefined;
    const draftChild = isRecord(draft) ? draft[key] : undefined;
    patchPath = formatConfigPatchPath(patchPath, key);
    if (rest.length === 0) {
      target[key] = value === undefined ? null : value;
      break;
    }
    if (Array.isArray(baseChild) || Array.isArray(draftChild)) {
      const source = hasItem(baseChild, rest[0]!) ? baseChild : (draftChild ?? []);
      target[key] = patchedCopy(source, rest, value);
      if (Array.isArray(baseChild)) {
        replacePaths.push(patchPath);
      }
      break;
    }
    if (!isRecord(baseChild)) {
      target[key] = patchedCopy(isRecord(draftChild) ? draftChild : {}, rest, value);
      break;
    }
    const next: Record<string, unknown> = {};
    target[key] = next;
    target = next;
    base = baseChild;
    draft = draftChild;
  }
  return { patch, replacePaths };
}
