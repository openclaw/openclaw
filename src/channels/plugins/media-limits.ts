import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAccountId } from "../../routing/session-key.js";

const MB = 1024 * 1024;

/** Resolves channel media limit bytes from account-specific config or agent defaults. */
export function resolveChannelMediaMaxBytes(params: {
  cfg: OpenClawConfig;
  // Channel-specific config lives under different keys; keep this helper generic
  // so shared plugin helpers don't need channel-id branching.
  resolveChannelLimitMb: (params: { cfg: OpenClawConfig; accountId: string }) => number | undefined;
  accountId?: string | null;
}): number | undefined {
  const accountId = normalizeAccountId(params.accountId);
  const channelLimit = params.resolveChannelLimitMb({
    cfg: params.cfg,
    accountId,
  });
  const limitMb = channelLimit || params.cfg.agents?.defaults?.mediaMaxMb;
  return limitMb ? limitMb * MB : undefined;
}
