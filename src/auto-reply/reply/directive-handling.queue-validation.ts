/** Validation and status handling for /queue directives. */
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyPayload } from "../types.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { formatDirectiveAck, withOptions } from "./directive-handling.shared.js";
import { resolveQueueSettingsCore } from "./queue/settings.js";

/** Validates `/queue` directives and returns immediate status/error replies. */
export function maybeHandleQueueDirective(params: {
  directives: InlineDirectives;
  cfg: OpenClawConfig;
  channel: string;
  sessionEntry?: SessionEntry;
}): ReplyPayload | undefined {
  const { directives } = params;
  if (!directives.hasQueueDirective) {
    return undefined;
  }

  const wantsStatus =
    !directives.queueMode &&
    !directives.queueReset &&
    !directives.hasQueueOptions &&
    directives.rawQueueMode === undefined &&
    directives.rawDebounce === undefined &&
    directives.rawCap === undefined &&
    directives.rawDrop === undefined;
  if (wantsStatus) {
    // Bare `/queue` is status, not mutation.
    const settings = resolveQueueSettingsCore({
      cfg: params.cfg,
      channel: params.channel,
      sessionEntry: params.sessionEntry,
    });
    const debounceLabel =
      typeof settings.debounceMs === "number" ? `${settings.debounceMs}ms` : "default";
    const capLabel = typeof settings.cap === "number" ? String(settings.cap) : "default";
    const dropLabel = settings.dropPolicy ?? "default";
    return {
      text: withOptions(
        `Current queue settings: mode=${settings.mode}, debounce=${debounceLabel}, cap=${capLabel}, drop=${dropLabel}.`,
        "modes steer, followup, collect, interrupt; debounce:<ms|s|m>, cap:<n>, drop:old|new|summarize",
      ),
    };
  }

  const queueModeInvalid =
    !directives.queueMode && !directives.queueReset && Boolean(directives.rawQueueMode);
  const queueDebounceInvalid =
    directives.rawDebounce !== undefined && typeof directives.debounceMs !== "number";
  const queueCapInvalid = directives.rawCap !== undefined && typeof directives.cap !== "number";
  const queueDropInvalid = directives.rawDrop !== undefined && !directives.dropPolicy;

  if (queueModeInvalid || queueDebounceInvalid || queueCapInvalid || queueDropInvalid) {
    const errors: string[] = [];
    if (queueModeInvalid) {
      errors.push(
        `Unrecognized queue mode "${directives.rawQueueMode ?? ""}". Valid modes: steer, followup, collect, interrupt.`,
      );
    }
    if (queueDebounceInvalid) {
      errors.push(
        `Invalid debounce "${directives.rawDebounce ?? ""}". Use ms/s/m (e.g. debounce:1500ms, debounce:2s).`,
      );
    }
    if (queueCapInvalid) {
      errors.push(
        `Invalid cap "${directives.rawCap ?? ""}". Use a positive integer (e.g. cap:10).`,
      );
    }
    if (queueDropInvalid) {
      errors.push(
        `Invalid drop policy "${directives.rawDrop ?? ""}". Use drop:old, drop:new, or drop:summarize.`,
      );
    }
    return { text: errors.join(" ") };
  }

  return undefined;
}

/** Formats acknowledgements after queue settings have been accepted. */
export function formatQueueDirectiveAcknowledgements(
  directives: InlineDirectives,
  resumedQueuedWork: boolean,
): string[] {
  const parts: string[] = [];
  if (directives.hasQueueDirective && directives.queueMode) {
    parts.push(formatDirectiveAck(`Queue mode set to ${directives.queueMode}.`));
  } else if (directives.hasQueueDirective && directives.queueReset) {
    parts.push(formatDirectiveAck("Queue mode reset to default."));
  }
  if (directives.hasQueueDirective && typeof directives.debounceMs === "number") {
    parts.push(formatDirectiveAck(`Queue debounce set to ${directives.debounceMs}ms.`));
  }
  if (directives.hasQueueDirective && typeof directives.cap === "number") {
    parts.push(formatDirectiveAck(`Queue cap set to ${directives.cap}.`));
  }
  if (directives.hasQueueDirective && directives.dropPolicy) {
    parts.push(formatDirectiveAck(`Queue drop set to ${directives.dropPolicy}.`));
  }
  if (resumedQueuedWork) {
    parts.push(formatDirectiveAck("Retained queued messages will retry."));
  }
  return parts;
}

/** Compares the explicit directive result before concurrent persistence can adopt other edits. */
export function didQueueChange(
  directives: InlineDirectives,
  before: SessionEntry,
  after: SessionEntry,
): boolean {
  return (
    directives.hasQueueDirective &&
    (directives.queueReset ||
      before.queueMode !== after.queueMode ||
      before.queueDebounceMs !== after.queueDebounceMs ||
      before.queueCap !== after.queueCap ||
      before.queueDrop !== after.queueDrop)
  );
}
