/**
 * Fan-Out Coordinator — Sequential Turn-Taking for Multi-Agent Channels
 *
 * When a message arrives in a fan-out channel, each bot receives the Discord
 * event independently. The coordinator collects these registrations, then
 * releases agents one at a time so each sees the accumulated conversation.
 */

import { isSilentReplyText } from "../../auto-reply/tokens.js";
import { logVerbose } from "../../globals.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";

const AGENT_COLLECTION_WINDOW_MS = 1500;
const AGENT_RESPONSE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ROUNDS = 20;

const FANOUT_GUIDANCE =
  "> Shared agent conversation. Respond only if addressed, the topic is in your domain, or you have useful input. Otherwise NO_REPLY.";

// ── Types ──

type AgentRegistration = {
  accountId: string;
  botUserId: string;
  ctx: DiscordMessagePreflightContext;
  processMessage: (ctx: DiscordMessagePreflightContext) => Promise<void>;
};

type PendingRound = {
  triggerMessageId: string;
  triggerAccountId: string | undefined; // accountId of the bot that sent the trigger (for self-exclusion)
  registrations: AgentRegistration[];
  collectionTimer: ReturnType<typeof setTimeout> | null;
  mentionedBotIds: string[];
};

type RoundResult = {
  accountId: string;
  botUserId: string;
  responded: boolean; // true = sent content (non-NO_REPLY)
  responseText?: string;
};

type ChannelState = {
  currentRound: number;
  isProcessing: boolean;
  pendingRound: PendingRound | null;
  previousRoundResponders: Set<string>; // accountIds that responded in previous round
  roundLimit: number;
  /** Track pending response callbacks per accountId */
  responseCallbacks: Map<string, (responseText: string | undefined) => void>;
};

// ── Singleton state ──

const channelStates = new Map<string, ChannelState>();

function getOrCreateChannelState(channelId: string, maxRounds?: number): ChannelState {
  let state = channelStates.get(channelId);
  if (!state) {
    state = {
      currentRound: 0,
      isProcessing: false,
      pendingRound: null,
      previousRoundResponders: new Set(),
      roundLimit: maxRounds ?? DEFAULT_MAX_ROUNDS,
      responseCallbacks: new Map(),
    };
    channelStates.set(channelId, state);
  }
  if (maxRounds !== undefined) {
    state.roundLimit = maxRounds;
  }
  return state;
}

// ── Public API ──

/**
 * Register an agent to participate in a fan-out round for a message.
 * Called from each bot's message handler when a fan-out message is detected.
 *
 * Returns true if the coordinator will handle processing (caller should NOT process).
 * Returns false if fan-out coordination is not applicable (caller should process normally).
 */
export function registerFanOutAgent(params: {
  channelId: string;
  messageId: string;
  accountId: string;
  botUserId: string;
  triggerBotUserId?: string; // botUserId of message author (for self-exclusion)
  mentionedUserIds: string[];
  ctx: DiscordMessagePreflightContext;
  processMessage: (ctx: DiscordMessagePreflightContext) => Promise<void>;
  maxRounds?: number;
}): boolean {
  const { channelId, messageId, accountId, botUserId, ctx, processMessage, maxRounds } = params;
  const state = getOrCreateChannelState(channelId, maxRounds);

  // Self-exclusion: if this bot sent the triggering message, skip
  if (params.triggerBotUserId && params.triggerBotUserId === botUserId) {
    logVerbose(`fanout: skip self-delivery for ${accountId} in ${channelId}`);
    return true; // coordinator handles it (by skipping)
  }

  // If we're in the middle of processing a round and this is a NEW message
  // (not the one being processed), queue it for after the current round.
  if (state.isProcessing && state.pendingRound?.triggerMessageId !== messageId) {
    // This is a new message arriving while a round is in progress.
    // Start collecting for a new round.
    startNewPendingRound(state, messageId, params);
    return true;
  }

  // If there's already a pending round for a DIFFERENT message, start fresh
  if (state.pendingRound && state.pendingRound.triggerMessageId !== messageId) {
    // Cancel old collection, start new
    if (state.pendingRound.collectionTimer) {
      clearTimeout(state.pendingRound.collectionTimer);
    }
    state.pendingRound = null;
  }

  if (!state.pendingRound) {
    startNewPendingRound(state, messageId, params);
  } else {
    // Add to existing pending round
    addRegistration(state.pendingRound, { accountId, botUserId, ctx, processMessage });
  }

  return true;
}

/**
 * Notify the coordinator that an agent has responded in a fan-out channel.
 * Called from reply delivery when a message is sent in a fan-out channel.
 */
export function notifyFanOutResponse(params: {
  channelId: string;
  accountId: string;
  responseText: string | undefined;
}): void {
  const state = channelStates.get(params.channelId);
  if (!state) {
    return;
  }

  const callback = state.responseCallbacks.get(params.accountId);
  if (callback) {
    state.responseCallbacks.delete(params.accountId);
    callback(params.responseText);
  }
}

/**
 * Check if a channel is currently in a fan-out round (for use in preflight gating).
 */
export function isFanOutRoundActive(channelId: string): boolean {
  const state = channelStates.get(channelId);
  return Boolean(state?.isProcessing);
}

// ── Internal ──

function startNewPendingRound(
  state: ChannelState,
  messageId: string,
  params: {
    accountId: string;
    botUserId: string;
    triggerBotUserId?: string;
    mentionedUserIds: string[];
    ctx: DiscordMessagePreflightContext;
    processMessage: (ctx: DiscordMessagePreflightContext) => Promise<void>;
  },
): void {
  const pending: PendingRound = {
    triggerMessageId: messageId,
    triggerAccountId: params.triggerBotUserId
      ? undefined // We use botUserId for self-exclusion, not accountId
      : undefined,
    registrations: [],
    collectionTimer: null,
    mentionedBotIds: params.mentionedUserIds,
  };

  addRegistration(pending, {
    accountId: params.accountId,
    botUserId: params.botUserId,
    ctx: params.ctx,
    processMessage: params.processMessage,
  });

  state.pendingRound = pending;

  // Start collection window — wait for other bots to register
  pending.collectionTimer = setTimeout(() => {
    pending.collectionTimer = null;
    void executeRound(state, pending);
  }, AGENT_COLLECTION_WINDOW_MS);
}

function addRegistration(pending: PendingRound, reg: AgentRegistration): void {
  // Deduplicate by accountId
  if (!pending.registrations.some((r) => r.accountId === reg.accountId)) {
    pending.registrations.push(reg);
  }
}

function orderAgents(
  registrations: AgentRegistration[],
  mentionedBotIds: string[],
  previousResponders: Set<string>,
  isFirstRound: boolean,
): AgentRegistration[] {
  if (isFirstRound) {
    // Mentioned agents first (in mention order), then rest random
    const mentioned: AgentRegistration[] = [];
    const rest: AgentRegistration[] = [];

    for (const reg of registrations) {
      if (mentionedBotIds.includes(reg.botUserId)) {
        mentioned.push(reg);
      } else {
        rest.push(reg);
      }
    }

    // Sort mentioned by their position in mentionedBotIds
    mentioned.sort(
      (a, b) => mentionedBotIds.indexOf(a.botUserId) - mentionedBotIds.indexOf(b.botUserId),
    );

    // Shuffle rest
    shuffleArray(rest);

    return [...mentioned, ...rest];
  } else {
    // Chained round: previous responders first, then rest random
    const responders: AgentRegistration[] = [];
    const rest: AgentRegistration[] = [];

    for (const reg of registrations) {
      if (previousResponders.has(reg.accountId)) {
        responders.push(reg);
      } else {
        rest.push(reg);
      }
    }

    shuffleArray(responders);
    shuffleArray(rest);

    return [...responders, ...rest];
  }
}

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

async function executeRound(state: ChannelState, pending: PendingRound): Promise<void> {
  if (state.isProcessing) {
    // Already processing — this pending round will be picked up after
    return;
  }

  state.isProcessing = true;
  state.pendingRound = null;
  state.currentRound++;

  const isFirstRound = state.currentRound === 1;
  const ordered = orderAgents(
    pending.registrations,
    pending.mentionedBotIds,
    state.previousRoundResponders,
    isFirstRound,
  );

  logVerbose(
    `fanout: round ${state.currentRound} starting with ${ordered.length} agents in channel (msg=${pending.triggerMessageId})`,
  );

  const results: RoundResult[] = [];
  const accumulatedResponses: string[] = [];

  for (const reg of ordered) {
    logVerbose(`fanout: round ${state.currentRound} → agent ${reg.accountId}`);

    // Build modified context with accumulated responses
    const modifiedCtx = buildAccumulatedContext(reg.ctx, accumulatedResponses, state.currentRound);

    // Create response promise
    const responsePromise = new Promise<string | undefined>((resolve) => {
      state.responseCallbacks.set(reg.accountId, resolve);

      // Timeout
      setTimeout(() => {
        if (state.responseCallbacks.has(reg.accountId)) {
          state.responseCallbacks.delete(reg.accountId);
          logVerbose(`fanout: agent ${reg.accountId} timed out in round ${state.currentRound}`);
          resolve(undefined);
        }
      }, AGENT_RESPONSE_TIMEOUT_MS);
    });

    // Process the message for this agent
    try {
      await reg.processMessage(modifiedCtx);
    } catch (err) {
      logVerbose(`fanout: agent ${reg.accountId} processing error: ${String(err)}`);
    }

    // Wait for response
    const responseText = await responsePromise;
    const responded = Boolean(responseText && !isSilentReplyText(responseText));

    results.push({
      accountId: reg.accountId,
      botUserId: reg.botUserId,
      responded,
      responseText: responded ? responseText : undefined,
    });

    if (responded && responseText) {
      accumulatedResponses.push(responseText);
    }
  }

  // Round complete
  const anyResponded = results.some((r) => r.responded);
  state.previousRoundResponders = new Set(
    results.filter((r) => r.responded).map((r) => r.accountId),
  );

  logVerbose(
    `fanout: round ${state.currentRound} complete. ${results.filter((r) => r.responded).length}/${results.length} agents responded.`,
  );

  state.isProcessing = false;

  // Round chaining: if any agent responded and we haven't hit the limit, trigger another round
  if (anyResponded && state.currentRound < state.roundLimit) {
    // Check if a new pending round arrived while we were processing
    if (state.pendingRound) {
      void executeRound(state, state.pendingRound);
    }
    // Otherwise, chained rounds are triggered by the bot messages arriving in Discord
    // (each bot's response is a new Discord message that goes through preflight again)
  } else {
    if (state.currentRound >= state.roundLimit) {
      logVerbose(`fanout: round limit (${state.roundLimit}) reached in channel`);
    }
    // Reset round counter — next external message starts fresh
    state.currentRound = 0;
    state.previousRoundResponders.clear();
  }
}

function buildAccumulatedContext(
  ctx: DiscordMessagePreflightContext,
  accumulatedResponses: string[],
  roundNumber: number,
): DiscordMessagePreflightContext {
  if (accumulatedResponses.length === 0) {
    // First agent in round — just add guidance
    const modifiedCtx = { ...ctx };
    // The guidance is already added for fan-out bot messages in process.ts
    // For human messages, we add it here
    if (!ctx.isFanOutBotMessage) {
      // We'll let process.ts handle the body construction, but store round info
      (modifiedCtx as DiscordMessagePreflightContext & { _fanOutRound?: number })._fanOutRound =
        roundNumber;
      (
        modifiedCtx as DiscordMessagePreflightContext & { _fanOutAccumulatedResponses?: string[] }
      )._fanOutAccumulatedResponses = [];
    }
    return modifiedCtx;
  }

  // Subsequent agents — include accumulated context
  const modifiedCtx = { ...ctx };
  (modifiedCtx as DiscordMessagePreflightContext & { _fanOutRound?: number })._fanOutRound =
    roundNumber;
  (
    modifiedCtx as DiscordMessagePreflightContext & { _fanOutAccumulatedResponses?: string[] }
  )._fanOutAccumulatedResponses = [...accumulatedResponses];

  return modifiedCtx;
}

/**
 * Get the fan-out round metadata from a context, if present.
 */
export function getFanOutRoundInfo(ctx: DiscordMessagePreflightContext): {
  round: number;
  accumulatedResponses: string[];
} | null {
  const round = (ctx as DiscordMessagePreflightContext & { _fanOutRound?: number })._fanOutRound;
  if (round === undefined) {
    return null;
  }

  const responses = (
    ctx as DiscordMessagePreflightContext & { _fanOutAccumulatedResponses?: string[] }
  )._fanOutAccumulatedResponses;

  return {
    round,
    accumulatedResponses: responses ?? [],
  };
}

export { FANOUT_GUIDANCE };
