import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import {
  isSensitiveLeafValue,
  REDACTED_SENTINEL,
  removePathValue,
  setPathValue,
} from "../config-form-utils.ts";

export function replayConfigDraftEdits(
  submitted: Record<string, unknown> | null,
  current: Record<string, unknown> | null,
  acknowledgedConfig: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!submitted || !current) {
    return null;
  }
  const draft = structuredClone(acknowledgedConfig);
  const replay = (
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    canonical: Record<string, unknown>,
    path: string[],
  ) => {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const nextPath = [...path, key];
      if (!Object.hasOwn(after, key)) {
        removePathValue(draft, nextPath);
      } else if (isRecord(before[key]) && isRecord(after[key]) && isRecord(canonical[key])) {
        replay(before[key], after[key], canonical[key], nextPath);
      } else if (stableStringify(before[key]) !== stableStringify(after[key])) {
        setPathValue(draft, nextPath, structuredClone(after[key]));
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
): boolean {
  const before = projectConfigContent(original, canonical);
  const draft = projectConfigContent(current, canonical);
  return (
    stableStringify(replayConfigDraftEdits(before, canonical, draft)) !== stableStringify(draft)
  );
}

export function configFormContentConflicts(
  original: Record<string, unknown>,
  current: Record<string, unknown>,
  canonical: Record<string, unknown>,
): boolean {
  const before = projectConfigContent(original, canonical);
  const draft = projectConfigContent(current, canonical);
  return (
    stableStringify(replayConfigDraftEdits(before, draft, canonical)) !==
    stableStringify(replayConfigDraftEdits(before, canonical, draft))
  );
}
