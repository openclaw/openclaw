import { readAskUserQuestionId, type ReplyPayload } from "../auto-reply/reply-payload.js";
import type { MessagePresentation } from "../interactive/payload.js";
import { renderMessagePresentationFallbackText } from "../interactive/payload.js";
import { registerQuestionChannelDelivery } from "./question-channel-runtime.js";
// The pre-release named resolver exports were replaced wholesale by this
// runtime object before any tagged release shipped them; no compat aliases.
import {
  resolveQuestionOverGateway,
  type ResolveQuestionOverGatewayParams,
  type ResolveQuestionOverGatewayResult,
} from "./question-gateway-resolver.js";

const QUESTION_REACTION_CHANNEL_DATA_KEY = "openclawQuestionReaction";

const QUESTION_REACTION_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"] as const;

type QuestionReactionBinding = {
  questionId: string;
  optionValues: string[];
};

function readQuestionReactionBinding(
  payload: Pick<ReplyPayload, "channelData">,
): QuestionReactionBinding | undefined {
  const raw = payload.channelData?.[QUESTION_REACTION_CHANNEL_DATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const questionId = (raw as { questionId?: unknown }).questionId;
  const optionValues = (raw as { optionValues?: unknown }).optionValues;
  return typeof questionId === "string" &&
    questionId.length > 0 &&
    Array.isArray(optionValues) &&
    optionValues.length >= 1 &&
    optionValues.length <= QUESTION_REACTION_EMOJIS.length &&
    optionValues.every((value) => typeof value === "string" && value.length > 0)
    ? { questionId, optionValues: [...optionValues] }
    : undefined;
}

function resolveQuestionReactionIndex(reaction: string): number | undefined {
  const index = QUESTION_REACTION_EMOJIS.indexOf(
    reaction as (typeof QUESTION_REACTION_EMOJIS)[number],
  );
  return index >= 0 ? index : undefined;
}

function prepareQuestionReactionPayloadForDelivery(params: {
  payload: ReplyPayload;
  presentation?: MessagePresentation;
}): ReplyPayload | null {
  const questionId = readAskUserQuestionId(params.payload);
  const presentation = params.presentation ?? params.payload.presentation;
  if (!questionId || !presentation) {
    return null;
  }
  const buttonBlocks = presentation.blocks.filter((block) => block.type === "buttons");
  const buttonBlock = buttonBlocks[0];
  if (!buttonBlock || buttonBlocks.length !== 1) {
    return null;
  }
  const optionButtons = buttonBlock.buttons.filter(
    (button) => button.action?.type === "question" && !("intent" in button.action),
  );
  if (optionButtons.length < 1 || optionButtons.length > 4) {
    return null;
  }
  const labels: string[] = [];
  const optionValues: string[] = [];
  for (const button of optionButtons) {
    if (
      button.action?.type !== "question" ||
      button.action.questionId !== questionId ||
      !("optionValue" in button.action) ||
      !button.action.optionValue
    ) {
      return null;
    }
    labels.push(button.label);
    optionValues.push(button.action.optionValue);
  }
  // Keep only the leading question block: the second text block carries
  // tap-oriented option guidance that is wrong for reaction channels, and the
  // reaction hint below re-lists every option.
  const questionBlock = presentation.blocks.find((block) => block.type === "text");
  const textPresentation: MessagePresentation = {
    ...presentation,
    blocks: questionBlock ? [questionBlock] : [],
  };
  const prompt = renderMessagePresentationFallbackText({ presentation: textPresentation });
  const reactionHint = labels
    .map((label, index) => `${QUESTION_REACTION_EMOJIS[index]} ${label}`)
    .join("\n");
  const hasCustomInput = buttonBlock.buttons.some((button) => {
    const action = button.action;
    return action?.type === "question" && "intent" in action && action.intent === "custom-input";
  });
  const customInputHint = hasCustomInput ? "\n\nOr reply with your own answer." : "";
  return {
    ...params.payload,
    text: `${prompt}\n\nReact with:\n${reactionHint}${customInputHint}`,
    presentation: undefined,
    presentationTextMode: undefined,
    channelData: {
      ...params.payload.channelData,
      [QUESTION_REACTION_CHANNEL_DATA_KEY]: { questionId, optionValues },
    },
  };
}

async function resolveQuestionReactionOverGateway(
  params: ResolveQuestionOverGatewayParams,
): Promise<ResolveQuestionOverGatewayResult | null> {
  return await resolveQuestionOverGateway(params);
}

const DEFAULT_QUESTION_REACTION_TARGET_TTL_MS = 24 * 60 * 60 * 1_000;

/** Creates one channel-owned target store for numbered ask_user reactions. */
export function createQuestionReactionTargetStore<TIdentity, TMetadata = undefined>(params: {
  channel: string;
  channelDisplayName: string;
  ttlMs?: number;
  buildKey: (identity: TIdentity) => string | null | undefined;
  identityMatches?: (stored: TMetadata | undefined, incoming: TMetadata | undefined) => boolean;
  registerChannelDelivery?: typeof registerQuestionChannelDelivery;
  resolveReaction?: typeof resolveQuestionReactionOverGateway;
}) {
  type Target = {
    questionId: string;
    optionValues: string[];
    metadata?: TMetadata;
    terminal: boolean;
    expiresAtMs: number;
    cleanupTimer: ReturnType<typeof setTimeout>;
  };

  const ttlMs = params.ttlMs ?? DEFAULT_QUESTION_REACTION_TARGET_TTL_MS;
  const registerChannelDelivery = params.registerChannelDelivery ?? registerQuestionChannelDelivery;
  const resolveReaction = params.resolveReaction ?? resolveQuestionReactionOverGateway;
  const targets = new Map<string, Target>();

  const findTarget = (identities: readonly TIdentity[]): Target | undefined => {
    for (const identity of identities) {
      const key = params.buildKey(identity);
      const target = key ? targets.get(key) : undefined;
      if (target) {
        return target;
      }
    }
    return undefined;
  };

  return {
    register(
      binding: { questionId: string; optionValues: string[] },
      identity: TIdentity,
      metadata?: TMetadata,
    ): boolean {
      const key = params.buildKey(identity);
      if (!key) {
        return false;
      }
      const existing = targets.get(key);
      if (existing) {
        clearTimeout(existing.cleanupTimer);
      }
      const target: Target = {
        ...binding,
        metadata,
        terminal: false,
        expiresAtMs: Date.now() + ttlMs,
        cleanupTimer: setTimeout(() => {
          if (targets.get(key) === target) {
            targets.delete(key);
          }
        }, ttlMs),
      };
      target.cleanupTimer.unref?.();
      targets.set(key, target);
      // Registration can synchronously finalize an already-terminal question.
      registerChannelDelivery({
        questionId: binding.questionId,
        deliveryId: `${params.channel}-reaction:${key}`,
        finalize: () => {
          target.terminal = true;
        },
      });
      return true;
    },

    has(identities: readonly TIdentity[]): boolean {
      return Boolean(findTarget(identities));
    },

    async resolve(resolveParams: {
      identities: readonly TIdentity[];
      optionIndex: number;
      cfg: Parameters<typeof resolveQuestionReactionOverGateway>[0]["cfg"];
      senderId: string;
      gatewayUrl?: string;
      metadata?: TMetadata;
      logDebug?: (message: string) => void;
    }): Promise<boolean> {
      const target = findTarget(resolveParams.identities);
      if (
        !target ||
        (params.identityMatches && !params.identityMatches(target.metadata, resolveParams.metadata))
      ) {
        return false;
      }
      if (target.expiresAtMs <= Date.now() || target.terminal) {
        target.terminal = true;
        resolveParams.logDebug?.(
          `${params.channel}: stale question reaction ignored id=${target.questionId}`,
        );
        return true;
      }
      const optionValue = target.optionValues[resolveParams.optionIndex];
      if (!optionValue) {
        resolveParams.logDebug?.(
          `${params.channel}: out-of-range question reaction ignored id=${target.questionId}`,
        );
        return true;
      }
      try {
        const result = await resolveReaction({
          cfg: resolveParams.cfg,
          questionId: target.questionId,
          optionValue,
          senderId: resolveParams.senderId,
          gatewayUrl: resolveParams.gatewayUrl,
          clientDisplayName: `${params.channelDisplayName} question (${resolveParams.senderId})`,
        });
        target.terminal = result?.status === "answered" || result?.status === "already-terminal";
        if (result?.status === "already-terminal") {
          resolveParams.logDebug?.(
            `${params.channel}: stale question reaction ignored id=${target.questionId}`,
          );
        }
      } catch (error) {
        resolveParams.logDebug?.(
          `${params.channel}: question reaction failed id=${target.questionId}: ${String(error)}`,
        );
      }
      return true;
    },
  };
}

export const questionGatewayRuntime = {
  resolveOption: resolveQuestionOverGateway,
  reactionEmojis: QUESTION_REACTION_EMOJIS,
  prepareReactionPayloadForDelivery: prepareQuestionReactionPayloadForDelivery,
  readAskUserQuestionId,
  readReactionBinding: readQuestionReactionBinding,
  resolveReactionIndex: resolveQuestionReactionIndex,
  resolveReaction: resolveQuestionReactionOverGateway,
  registerChannelDelivery: registerQuestionChannelDelivery,
};
