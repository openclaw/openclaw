import {
  createPairLoopGuard,
  resolvePairLoopGuardSettings,
  type PairLoopGuardConfig,
  type PairLoopGuardResult,
  type PairLoopGuardSnapshotEntry,
} from "../../plugin-sdk/pair-loop-guard-runtime.js";

/** Facts used to detect repeated bot-to-bot channel reply loops. */
export type ChannelBotLoopProtectionFacts = {
  /** Channel/account scope that owns the loop guard bucket. */
  scopeId: string;
  /** Conversation-level id shared by both bot participants. */
  conversationId: string;
  /** Bot sender id for the current inbound event. */
  senderId: string;
  /** Bot receiver id that would respond to the current event. */
  receiverId: string;
  /** Channel-specific loop guard override. */
  config?: PairLoopGuardConfig;
  /** Product or plugin defaults used when no channel override is set. */
  defaultsConfig?: PairLoopGuardConfig;
  /** Default enabled state when both config layers omit it. */
  defaultEnabled: boolean;
  /** Optional clock override for deterministic tests. */
  nowMs?: number;
};

// One process-local guard is shared across channel turns; scopeId keeps accounts/conversations
// isolated while periodic pruning prevents stale pairs from growing for the gateway lifetime.
const channelBotPairLoopGuard = createPairLoopGuard({ pruneIntervalMs: 60_000 });

/** Records a bot pair interaction and returns whether the loop guard should suppress it. */
export function recordChannelBotPairLoopAndCheckSuppression(
  params: ChannelBotLoopProtectionFacts,
): PairLoopGuardResult {
  return channelBotPairLoopGuard.recordAndCheck({
    scopeId: params.scopeId,
    conversationId: params.conversationId,
    senderId: params.senderId,
    receiverId: params.receiverId,
    settings: resolvePairLoopGuardSettings({
      config: params.config,
      defaultsConfig: params.defaultsConfig,
      defaultEnabled: params.defaultEnabled,
    }),
    nowMs: params.nowMs,
  });
}

/** Clears channel bot-loop state for isolated tests. */
export function clearChannelBotPairLoopGuardForTests(): void {
  channelBotPairLoopGuard.clear();
}

/** Lists tracked bot-loop pairs for isolated tests. */
export function listTrackedChannelBotPairsForTests(): PairLoopGuardSnapshotEntry[] {
  return channelBotPairLoopGuard.snapshot();
}
