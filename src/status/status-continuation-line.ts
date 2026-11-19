import { getVolitionalCompactionCount } from "../agents/tools/request-compaction-tool.js";
import { resolveContinuationRuntimeConfig } from "../auto-reply/continuation/config.js";
import { stagedPostCompactionDelegateCount } from "../auto-reply/continuation/delegate-store-post-compaction.js";
import { pendingDelegateCount } from "../auto-reply/continuation/delegate-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export function formatStatusTextContinuationLine(params: {
  maxChainLength: number;
  chainCount: number;
  pending: number;
  staged: number;
  volitional: number;
}): string | undefined {
  const { maxChainLength, chainCount, pending, staged, volitional } = params;
  if (chainCount === 0 && pending === 0 && staged === 0 && volitional === 0) {
    return undefined;
  }
  const parts = [`chain ${chainCount}/${maxChainLength}`];
  if (pending > 0) {
    parts.push(`${pending} delegates pending`);
  }
  if (staged > 0) {
    parts.push(`${staged} post-compaction staged`);
  }
  if (volitional > 0) {
    parts.push(`volitional: ${volitional}`);
  }
  return `🔄 Continuation: ${parts.join(" | ")}`;
}

/** The session's continuation status line; undefined while continuation is off or idle. */
export function resolveStatusTextContinuationLine(
  cfg: OpenClawConfig,
  sessionKey: string,
  chainCount = 0,
): string | undefined {
  if (!cfg.agents?.defaults?.continuation?.enabled || !sessionKey) {
    return undefined;
  }
  return formatStatusTextContinuationLine({
    maxChainLength: resolveContinuationRuntimeConfig(cfg).maxChainLength,
    chainCount,
    pending: pendingDelegateCount(sessionKey),
    staged: stagedPostCompactionDelegateCount(sessionKey),
    volitional: getVolitionalCompactionCount(sessionKey),
  });
}
