import {
  createPairLoopGuard,
  resolvePairLoopGuardSettings,
  type PairLoopGuardConfig,
  type PairLoopGuardResult,
} from "../../plugin-sdk/pair-loop-guard-runtime.js";

export type ChannelBotLoopProtectionFacts = {
  scopeId: string;
  conversationId: string;
  senderId: string;
  receiverId: string;
  eventId?: string;
  config?: PairLoopGuardConfig;
  defaultsConfig?: PairLoopGuardConfig;
  defaultEnabled: boolean;
  nowMs?: number;
};

const channelBotPairLoopGuard = createPairLoopGuard({ pruneIntervalMs: 60_000 });

export function recordChannelBotPairLoopAndCheckSuppression(
  params: ChannelBotLoopProtectionFacts,
): PairLoopGuardResult {
  return channelBotPairLoopGuard.recordAndCheck({
    scopeId: params.scopeId,
    conversationId: params.conversationId,
    senderId: params.senderId,
    receiverId: params.receiverId,
    eventId: params.eventId,
    settings: resolvePairLoopGuardSettings({
      config: params.config,
      defaultsConfig: params.defaultsConfig,
      defaultEnabled: params.defaultEnabled,
    }),
    nowMs: params.nowMs,
  });
}
