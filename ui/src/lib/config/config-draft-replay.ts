import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import {
  copyWithPathPatch,
  isSensitiveLeafValue,
  REDACTED_SENTINEL,
} from "../config-form-utils.ts";

export function replayConfigDraftEdits(
  submitted: Record<string, unknown> | null,
  current: Record<string, unknown> | null,
  acknowledgedConfig: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!submitted || !current) {
    return null;
  }
  // Keep unchanged acknowledgement branches shared for subsequent form edits.
  let draft = acknowledgedConfig;
  const replay = (
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    canonical: Record<string, unknown>,
    path: string[],
  ) => {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const present = Object.hasOwn(after, key);
      if (present && before[key] === after[key]) {
        continue;
      }
      const nextPath = [...path, key];
      if (
        present &&
        (isRecord(before[key]) || !Object.hasOwn(before, key)) &&
        isRecord(after[key]) &&
        isRecord(canonical[key])
      ) {
        // Separate fields can be added under the same previously absent object.
        replay(isRecord(before[key]) ? before[key] : {}, after[key], canonical[key], nextPath);
      } else if (!present || stableStringify(before[key]) !== stableStringify(after[key])) {
        const patched = copyWithPathPatch(
          draft,
          nextPath,
          present ? after[key] : undefined,
          present ? "copy-set" : "copy",
        );
        if (patched.ok && isRecord(patched.value)) {
          draft = patched.value;
        }
      }
    }
  };
  replay(submitted, current, acknowledgedConfig, []);
  return draft;
}

// Redacted receipt values describe visibility, not a change to the stored secret.
function projectConfigContent(
  config: Record<string, unknown>,
  canonical: Record<string, unknown>,
): Record<string, unknown> {
  const project = (value: unknown, visible: unknown): unknown => {
    if (visible === REDACTED_SENTINEL && isSensitiveLeafValue(value)) {
      return REDACTED_SENTINEL;
    }
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        project(item, Array.isArray(visible) ? visible[index] : undefined),
      );
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          project(item, isRecord(visible) ? visible[key] : undefined),
        ]),
      );
    }
    return value;
  };
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, project(value, canonical[key])]),
  );
}

export function configContentConflicts(
  original: Record<string, unknown>,
  current: Record<string, unknown>,
  canonical: Record<string, unknown>,
  mode: "content" | "form" = "content",
): boolean {
  const before = projectConfigContent(original, canonical);
  const draft = projectConfigContent(current, canonical);
  return mode === "form"
    ? stableStringify(replayConfigDraftEdits(before, draft, canonical)) !==
        stableStringify(replayConfigDraftEdits(before, canonical, draft))
    : stableStringify(replayConfigDraftEdits(before, canonical, draft)) !== stableStringify(draft);
}
