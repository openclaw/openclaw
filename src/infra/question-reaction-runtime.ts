// Converts eligible portable question buttons into numbered reaction choices.
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { MessagePresentation } from "../interactive/payload.js";
import { renderMessagePresentationFallbackText } from "../interactive/payload.js";
import {
  resolveQuestionOverGateway,
  type ResolveQuestionOverGatewayParams,
  type ResolveQuestionOverGatewayResult,
} from "./question-gateway-resolver.js";

const QUESTION_REACTION_CHANNEL_DATA_KEY = "openclawQuestionReaction";

export const QUESTION_REACTION_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"] as const;

export type QuestionReactionBinding = {
  questionId: string;
  optionCount: number;
};

export function readAskUserQuestionId(
  payload: Pick<ReplyPayload, "channelData">,
): string | undefined {
  const askUser = payload.channelData?.askUser;
  if (!askUser || typeof askUser !== "object" || Array.isArray(askUser)) {
    return undefined;
  }
  const questionId = (askUser as { questionId?: unknown }).questionId;
  return typeof questionId === "string" && questionId ? questionId : undefined;
}

export function readQuestionReactionBinding(
  payload: Pick<ReplyPayload, "channelData">,
): QuestionReactionBinding | undefined {
  const raw = payload.channelData?.[QUESTION_REACTION_CHANNEL_DATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const questionId = (raw as { questionId?: unknown }).questionId;
  const optionCount = (raw as { optionCount?: unknown }).optionCount;
  return typeof questionId === "string" &&
    questionId.length > 0 &&
    Number.isInteger(optionCount) &&
    Number(optionCount) >= 1 &&
    Number(optionCount) <= QUESTION_REACTION_EMOJIS.length
    ? { questionId, optionCount: Number(optionCount) }
    : undefined;
}

export function resolveQuestionReactionIndex(reaction: string): number | undefined {
  const index = QUESTION_REACTION_EMOJIS.indexOf(
    reaction as (typeof QUESTION_REACTION_EMOJIS)[number],
  );
  return index >= 0 ? index : undefined;
}

export function prepareQuestionReactionPayloadForDelivery(params: {
  payload: ReplyPayload;
  presentation?: MessagePresentation;
}): ReplyPayload | null {
  const questionId = readAskUserQuestionId(params.payload);
  const presentation = params.presentation ?? params.payload.presentation;
  if (!questionId || !presentation) {
    return null;
  }
  const buttonBlocks = presentation.blocks.filter((block) => block.type === "buttons");
  if (buttonBlocks.length !== 1) {
    return null;
  }
  const [buttonBlock] = buttonBlocks;
  if (!buttonBlock || buttonBlock.buttons.length < 1 || buttonBlock.buttons.length > 4) {
    return null;
  }
  const labels: string[] = [];
  for (const button of buttonBlock.buttons) {
    if (
      button.action?.type !== "question" ||
      button.action.questionId !== questionId ||
      button.action.optionValue !== button.label
    ) {
      return null;
    }
    labels.push(button.label);
  }
  const textPresentation: MessagePresentation = {
    ...presentation,
    blocks: presentation.blocks.filter((block) => block.type !== "buttons"),
  };
  const prompt = renderMessagePresentationFallbackText({ presentation: textPresentation });
  const reactionHint = labels
    .map((label, index) => `${QUESTION_REACTION_EMOJIS[index]} ${label}`)
    .join("\n");
  return {
    ...params.payload,
    text: `${prompt}\n\nReact with:\n${reactionHint}`,
    presentation: undefined,
    presentationTextMode: undefined,
    channelData: {
      ...params.payload.channelData,
      [QUESTION_REACTION_CHANNEL_DATA_KEY]: { questionId, optionCount: labels.length },
    },
  };
}

export async function resolveQuestionReactionOverGateway(
  params: Omit<ResolveQuestionOverGatewayParams, "optionIndex"> & { reaction: string },
): Promise<ResolveQuestionOverGatewayResult | null> {
  const optionIndex = resolveQuestionReactionIndex(params.reaction);
  if (optionIndex === undefined) {
    return null;
  }
  return await resolveQuestionOverGateway({ ...params, optionIndex });
}
