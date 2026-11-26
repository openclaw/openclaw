import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatConfigPatchPath } from "../../../../src/config/patch-replace-paths.js";
import { copyWithPathPatch } from "../config-form-utils.ts";

type ConfigPath = Array<string | number>;

function patchedCopy(source: unknown, path: ConfigPath, value: unknown): unknown {
  const patched = copyWithPathPatch(source, path, value);
  if (!patched.ok) {
    throw new Error(
      "Couldn’t save this setting at its current location. Check its location in the config file.",
    );
  }
  return patched.value;
}

function hasItem(list: unknown, index: string | number): boolean {
  return Array.isArray(list) && typeof index === "number" && index < list.length;
}

const sameValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/**
 * A secret inside a list takes its row from the form, which shows the draft, while the patch
 * rewrites the saved list. They agree only when the draft's list is the saved one or only adds
 * rows after it; otherwise the value could land on another row.
 */
export function secretRowMatchesSavedList(params: {
  base: Record<string, unknown>;
  draft: Record<string, unknown> | null | undefined;
  path: ConfigPath;
}): boolean {
  let base: unknown = params.base;
  let draft: unknown = params.draft ?? params.base;
  for (const [index, segment] of params.path.entries()) {
    if (Array.isArray(base) || Array.isArray(draft)) {
      // A list only the draft has goes out whole from the draft, so its rows are the form's.
      if (!Array.isArray(base) || sameValue(base, draft)) {
        return true;
      }
      const saved = base;
      return (
        typeof segment === "number" &&
        Array.isArray(draft) &&
        draft.length > saved.length &&
        saved.every((item, row) => sameValue(item, (draft as unknown[])[row]))
      );
    }
    if (index === params.path.length - 1) {
      return true;
    }
    base = isRecord(base) ? base[String(segment)] : undefined;
    draft = isRecord(draft) ? draft[String(segment)] : undefined;
  }
  return true;
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
