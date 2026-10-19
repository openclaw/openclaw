import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isSensitiveConfigPath } from "../../../../src/config/sensitive-paths.js";
import type { ConfigUiHints } from "../../api/types.ts";
import { hasSensitiveConfigData, hintForPath } from "../../components/config-form.shared.ts";
import { isJson5Warm, parseJson5Text } from "../../lib/json5-runtime.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ConfigDiffEntry, ConfigDiffPath, ConfigViewState } from "./view-types.ts";

const MAX_CONFIG_DIFF_DEPTH = 64;
const MAX_CONFIG_DIFF_NODES = 20_000;
const MAX_CONFIG_DIFF_CHANGES = 1_000;
const MAX_CONFIG_DIFF_ARRAY_COMPARE_ITEMS = 2_000;
const MAX_RAW_DIFF_CHARS = 200_000;

export function formatConfigDiffPath(path: ConfigDiffPath): string {
  return path.length > 0 ? path.join(".") : t("configView.root");
}

function computeDiff(
  original: Record<string, unknown>,
  current: Record<string, unknown>,
): ConfigDiffEntry[] {
  const changes: ConfigDiffEntry[] = [];
  let visited = 0;

  function pushChange(path: ConfigDiffPath, from: unknown, to: unknown) {
    if (changes.length < MAX_CONFIG_DIFF_CHANGES) {
      changes.push({ path, from, to });
    }
  }

  function arrayValuesDiffer(orig: unknown[], curr: unknown[], depth: number): boolean {
    if (orig.length !== curr.length || orig.length > MAX_CONFIG_DIFF_ARRAY_COMPARE_ITEMS) {
      return true;
    }
    for (let index = 0; index < orig.length; index += 1) {
      if (compare(orig[index], curr[index], null, depth + 1)) {
        return true;
      }
    }
    return false;
  }

  // A null path compares array contents without emitting their individual fields.
  function compare(
    orig: unknown,
    curr: unknown,
    path: ConfigDiffPath | null,
    depth: number,
  ): boolean {
    visited += 1;
    if (visited > MAX_CONFIG_DIFF_NODES || depth > MAX_CONFIG_DIFF_DEPTH) {
      return path === null;
    }
    if ((path !== null && changes.length >= MAX_CONFIG_DIFF_CHANGES) || orig === curr) {
      return false;
    }
    let differs = true;
    if (typeof orig === typeof curr && typeof orig === "object" && orig !== null && curr !== null) {
      if (Array.isArray(orig) || Array.isArray(curr)) {
        differs =
          !Array.isArray(orig) || !Array.isArray(curr) || arrayValuesDiffer(orig, curr, depth + 1);
      } else {
        const origObj = orig as Record<string, unknown>;
        const currObj = curr as Record<string, unknown>;
        const origKeys = Object.keys(origObj);
        const currKeys = Object.keys(currObj);
        if (path === null) {
          return (
            origKeys.length !== currKeys.length ||
            origKeys.some(
              (key) =>
                !Object.hasOwn(currObj, key) ||
                compare(origObj[key], currObj[key], null, depth + 2),
            )
          );
        }
        for (const key of new Set([...origKeys, ...currKeys])) {
          compare(origObj[key], currObj[key], [...path, key], depth + 1);
        }
        return false;
      }
    }
    if (differs && path !== null) {
      pushChange(path, orig, curr);
    }
    return differs;
  }

  compare(original, current, [], 0);
  return changes;
}

export function computeRawDiff(
  viewState: ConfigViewState,
  original: string,
  current: string,
): ConfigDiffEntry[] {
  if (viewState.rawDiffCache?.original === original && viewState.rawDiffCache.current === current) {
    return viewState.rawDiffCache.diff;
  }
  if (original.length > MAX_RAW_DIFF_CHARS || current.length > MAX_RAW_DIFF_CHARS) {
    viewState.rawDiffCache = { original, current, diff: [] };
    return viewState.rawDiffCache.diff;
  }
  try {
    const originalValue = asNullableRecord(parseJson5Text(original));
    const currentValue = asNullableRecord(parseJson5Text(current));
    if (!originalValue || !currentValue) {
      viewState.rawDiffCache = { original, current, diff: [] };
      return [];
    }
    const diff = computeDiff(originalValue, currentValue);
    viewState.rawDiffCache = { original, current, diff };
    return diff;
  } catch {
    // While the lazy JSON5 parser is still loading, a parse failure may be
    // transient; skip the cache so the next render retries instead of pinning
    // an empty diff for this text pair.
    if (isJson5Warm()) {
      viewState.rawDiffCache = { original, current, diff: [] };
    }
    return [];
  }
}

function truncateValue(value: unknown): string {
  const maxLen = 40;
  if (Array.isArray(value)) {
    return t(value.length === 1 ? "configView.itemCount" : "configView.itemCountPlural", {
      count: String(value.length),
    });
  }
  let str: string;
  try {
    const json = JSON.stringify(value);
    str = json ?? String(value);
  } catch {
    str = String(value);
  }
  return str.length <= maxLen ? str : truncateUtf16Safe(str, maxLen - 3) + "...";
}

function hintKeyMatchesPathPrefix(hintKey: string, path: ConfigDiffPath): boolean {
  const hintSegments = hintKey.split(".");
  if (hintSegments.length !== path.length) {
    return false;
  }
  return hintSegments.every((segment, index) => segment === "*" || segment === path[index]);
}

function hasSensitiveHintForPathPrefix(path: ConfigDiffPath, uiHints: ConfigUiHints): boolean {
  return Object.entries(uiHints).some(
    ([hintKey, hint]) => Boolean(hint.sensitive) && hintKeyMatchesPathPrefix(hintKey, path),
  );
}

function isSensitiveDiffPath(path: ConfigDiffPath, uiHints: ConfigUiHints): boolean {
  for (let index = 1; index <= path.length; index += 1) {
    const prefix = path.slice(0, index);
    const key = formatConfigDiffPath(prefix);
    if (
      (hintForPath(prefix, uiHints)?.sensitive ?? false) ||
      hasSensitiveHintForPathPrefix(prefix, uiHints) ||
      isSensitiveConfigPath(key)
    ) {
      return true;
    }
  }
  return false;
}

export function renderRawDiffValue(
  path: ConfigDiffPath,
  value: unknown,
  uiHints: ConfigUiHints,
  rawRevealed: boolean,
): string {
  const hasSensitiveValue = hasSensitiveConfigData(value, path, uiHints);
  if (!rawRevealed && value != null && (isSensitiveDiffPath(path, uiHints) || hasSensitiveValue)) {
    return t("configForm.redactedPlaceholder");
  }
  return truncateValue(value);
}
