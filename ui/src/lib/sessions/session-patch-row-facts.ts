import { deriveSessionUnread } from "../../../../src/shared/session-unread.ts";
import type { SessionPatch, SessionPatchResult } from "./patch.ts";
import { projectSessionArchiveFields } from "./session-archive-state.ts";
import type { SessionPatchRowFact } from "./session-pending-rows.ts";

/** Translate a committed patch receipt into the row fields its write confirmed. */
export function projectSessionPatchRowFields(
  patch: SessionPatch,
  result: SessionPatchResult,
): SessionPatchRowFact["fields"][] {
  const { entry } = result;
  const fields: SessionPatchRowFact["fields"][] = [];
  if (Object.hasOwn(patch, "model") && result.resolved) {
    fields.push({
      ...result.resolved,
      ...(entry.modelOverrideSource !== undefined
        ? {
            modelOverrideSource:
              entry.modelOverrideSource === "default" ? null : entry.modelOverrideSource,
          }
        : {}),
    });
  }
  for (const [key, choices] of [
    ["thinkingLevel", "thinkingLevels"],
    ["contextWindow", "contextWindows"],
  ] as const) {
    if (patch[key] !== undefined) {
      fields.push({
        [key]:
          result.resolved && Object.hasOwn(result.resolved, key)
            ? result.resolved[key]
            : entry[key],
        ...(result.resolved?.[choices] !== undefined
          ? { [choices]: result.resolved[choices] }
          : {}),
      });
    }
  }
  if (patch.fastMode !== undefined) {
    fields.push({ fastMode: entry.fastMode });
  }
  if (typeof patch.archived === "boolean") {
    fields.push(projectSessionArchiveFields(patch.archived, entry));
  }
  for (const key of ["category", "boardPresentation", "boardFace"] as const) {
    if (patch[key] !== undefined) {
      fields.push({ [key]: entry[key] });
    }
  }
  if (patch.pinned !== undefined || patch.unread === false) {
    const pin = { pinned: entry.pinnedAt !== undefined, pinnedAt: entry.pinnedAt };
    const read = {
      unread: deriveSessionUnread(entry),
      lastReadAt: entry.lastReadAt,
      markedUnreadAt: entry.markedUnreadAt,
    };
    fields.push(
      patch.pinned === undefined ? read : patch.unread === false ? { ...pin, ...read } : pin,
    );
  }
  return fields;
}
