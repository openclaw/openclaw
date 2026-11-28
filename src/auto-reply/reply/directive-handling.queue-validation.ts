import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyPayload } from "../types.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { withOptions } from "./directive-handling.shared.js";
import { resolveQueueSettingsCore } from "./queue/settings.js";

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
    return {
      text: withOptions(
        `Current queue settings: mode=${settings.mode}, debounce=${debounceLabel}, cap=${capLabel}, drop=${settings.dropPolicy ?? "default"}.`,
        "modes steer, followup, collect, interrupt; debounce:<ms|s|m>, cap:<n>, drop:old|new|summarize",
      ),
    };
  }

  const errors = [
    !directives.queueMode && !directives.queueReset && directives.rawQueueMode
      ? `Unrecognized queue mode "${directives.rawQueueMode}". Valid modes: steer, followup, collect, interrupt.`
      : undefined,
    directives.rawDebounce !== undefined && typeof directives.debounceMs !== "number"
      ? `Invalid debounce "${directives.rawDebounce ?? ""}". Use ms/s/m (e.g. debounce:1500ms, debounce:2s).`
      : undefined,
    directives.rawCap !== undefined && typeof directives.cap !== "number"
      ? `Invalid cap "${directives.rawCap ?? ""}". Use a positive integer (e.g. cap:10).`
      : undefined,
    directives.rawDrop !== undefined && !directives.dropPolicy
      ? `Invalid drop policy "${directives.rawDrop ?? ""}". Use drop:old, drop:new, or drop:summarize.`
      : undefined,
  ].filter(Boolean);
  return errors.length ? { text: errors.join(" ") } : undefined;
}
