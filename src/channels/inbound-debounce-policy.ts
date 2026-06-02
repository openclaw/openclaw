import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isControlCommandMessage } from "../auto-reply/command-detection.js";
import type { CommandNormalizeOptions } from "../auto-reply/commands-registry.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
  type InboundDebounceCreateParams,
} from "../auto-reply/inbound-debounce.js";
import type { OpenClawConfig } from "../config/types.js";

/** Returns whether an inbound text event may be debounced before agent dispatch. */
export function shouldDebounceTextInbound(params: {
  /** Raw text or command body from the inbound event. */
  text: string | null | undefined;
  /** Config used for command detection and debounce duration. */
  cfg: OpenClawConfig;
  /** Media-bearing events bypass debounce so attachments are processed promptly. */
  hasMedia?: boolean;
  /** Command parser options used to detect control commands. */
  commandOptions?: CommandNormalizeOptions;
  /** Explicit per-channel opt-out. */
  allowDebounce?: boolean;
}): boolean {
  if (params.allowDebounce === false) {
    return false;
  }
  if (params.hasMedia) {
    // Media events can carry upload/download side effects; dispatch them
    // immediately so attachment processing is not delayed behind text batching.
    return false;
  }
  const text = normalizeOptionalString(params.text) ?? "";
  if (!text) {
    return false;
  }
  // Control commands must run immediately; debouncing them can reorder operator actions.
  return !isControlCommandMessage(text, params.cfg, params.commandOptions);
}

/** Creates a channel-specific inbound debouncer using config-derived timing. */
export function createChannelInboundDebouncer<T>(
  params: Omit<InboundDebounceCreateParams<T>, "debounceMs"> & {
    /** Config used to resolve channel debounce settings. */
    cfg: OpenClawConfig;
    /** Channel id whose debounce settings should be applied. */
    channel: string;
    /** Test/runtime override that bypasses config-derived debounce duration. */
    debounceMsOverride?: number;
  },
): {
  /** Resolved debounce duration passed into the debouncer. */
  debounceMs: number;
  /** Debouncer instance scoped to the channel. */
  debouncer: ReturnType<typeof createInboundDebouncer<T>>;
} {
  const debounceMs = resolveInboundDebounceMs({
    cfg: params.cfg,
    channel: params.channel,
    overrideMs: params.debounceMsOverride,
  });
  // Resolve timing once when the channel monitor is created; per-message checks
  // only decide whether an event is debounceable, not what timer to use.
  const { cfg: _cfg, channel: _channel, debounceMsOverride: _override, ...rest } = params;
  const debouncer = createInboundDebouncer<T>({
    debounceMs,
    ...rest,
  });
  return { debounceMs, debouncer };
}
