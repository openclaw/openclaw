import type { OpenClawConfig } from "../../config/config.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { resolveFirstVisibleWarnMs } from "../../logging/diagnostic.js";
import { isRoutableChannel } from "./route-reply.js";

export type FirstVisibleWatchdogStrategy =
  | {
      mode: "disabled";
      reason: "diagnostics_disabled" | "non_routable_channel";
    }
  | {
      mode: "diagnose_only";
      thresholdMs: number;
    };

export function resolveFirstVisibleWatchdogStrategy(params: {
  cfg: OpenClawConfig;
  channel: string;
}): FirstVisibleWatchdogStrategy {
  if (!isDiagnosticsEnabled(params.cfg)) {
    return {
      mode: "disabled",
      reason: "diagnostics_disabled",
    };
  }

  if (!isRoutableChannel(params.channel)) {
    return {
      mode: "disabled",
      reason: "non_routable_channel",
    };
  }

  return {
    mode: "diagnose_only",
    thresholdMs: resolveFirstVisibleWarnMs(params.cfg),
  };
}
