import { hasControlCommand } from "../auto-reply/command-detection.js";
import type { CommandNormalizeOptions } from "../auto-reply/commands-registry.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
  type InboundDebounceCreateParams,
} from "../auto-reply/inbound-debounce.js";
import type { OpenClawConfig } from "../config/types.js";
import { createSmartDebounceResolver, type SmartDebounceConfig } from "./smart-debounce.js";

// Re-export SmartDebounceConfig for consumers
export type { SmartDebounceConfig } from "./smart-debounce.js";

export function shouldDebounceTextInbound(params: {
  text: string | null | undefined;
  cfg: OpenClawConfig;
  hasMedia?: boolean;
  commandOptions?: CommandNormalizeOptions;
  allowDebounce?: boolean;
}): boolean {
  if (params.allowDebounce === false) {
    return false;
  }
  if (params.hasMedia) {
    return false;
  }
  const text = params.text?.trim() ?? "";
  if (!text) {
    return false;
  }
  return !hasControlCommand(text, params.cfg, params.commandOptions);
}

export function createChannelInboundDebouncer<T>(
  params: Omit<InboundDebounceCreateParams<T>, "debounceMs"> & {
    cfg: OpenClawConfig;
    channel: string;
    debounceMsOverride?: number;
    /** Smart debounce configuration for dynamic debounce times */
    smartDebounce?: SmartDebounceConfig;
    /** Function to extract text from item for smart debounce analysis */
    extractText?: (item: T) => string;
  },
): {
  debounceMs: number;
  debouncer: ReturnType<typeof createInboundDebouncer<T>>;
} {
  const debounceMs = resolveInboundDebounceMs({
    cfg: params.cfg,
    channel: params.channel,
    overrideMs: params.debounceMsOverride,
  });
  const {
    cfg: _cfg,
    channel: _channel,
    debounceMsOverride: _override,
    smartDebounce,
    extractText,
    ...rest
  } = params;

  // Create smart debounce resolver if enabled
  const resolveDebounceMs =
    smartDebounce?.enabled === true
      ? createSmartDebounceResolver<T>(debounceMs, smartDebounce, extractText)
      : undefined;

  const debouncer = createInboundDebouncer<T>({
    debounceMs,
    resolveDebounceMs,
    ...rest,
  });
  return { debounceMs, debouncer };
}
