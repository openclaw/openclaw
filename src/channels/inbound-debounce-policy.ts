import type { CommandNormalizeOptions } from "../auto-reply/commands-registry.js";
import type { OpenClawConfig } from "../config/types.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
  type InboundDebounceCreateParams,
} from "../auto-reply/inbound-debounce.js";

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
  const { cfg: _cfg, channel: _channel, debounceMsOverride: _override, ...rest } = params;
  const debouncer = createInboundDebouncer<T>({
    debounceMs,
    ...rest,
  });
  return { debounceMs, debouncer };
}
