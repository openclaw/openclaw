import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Capture only the current Slack turn's native channel ID under explicit trace consent. */
export function resolveDiagnosticMessageOrigin(
  config: OpenClawConfig | null | undefined,
  channel: string | undefined,
  channelId: string | undefined,
): { channelId: string } | undefined {
  const diagnostics = config?.diagnostics;
  const otel = diagnostics?.otel;
  if (
    diagnostics?.enabled === false ||
    otel?.enabled !== true ||
    otel.traces === false ||
    otel.captureMessageOrigin !== true ||
    channel?.trim().toLowerCase() !== "slack" ||
    !channelId
  ) {
    return undefined;
  }
  return { channelId };
}
