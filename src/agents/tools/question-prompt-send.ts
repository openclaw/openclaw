/** Shared prompt delivery for embedded tool-start handlers and self-publishing harnesses. */
import type { QuestionRequestQuestion } from "../../../packages/gateway-protocol/src/index.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveControlUiSessionLinkBase } from "../../config/control-ui-link-base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveProactiveDeliveryTarget } from "../../infra/outbound/targets.js";
import { runWithQuestionChannelDeliveries } from "../../infra/question-channel-runtime.js";
import { resolveConversationQuestionInputMode } from "../conversation-capability-profile.js";
import { buildAgentHarnessQuestionPromptPayload } from "../harness/user-input-bridge.js";
import type { AgentHarnessUserInputQuestion } from "../harness/user-input-types.js";
import { type QuestionPromptRoute, sendQuestionPromptToRoute } from "./question-prompt-route.js";

/** Tools whose call opens a question a person must answer before the turn continues. */
export type QuestionPromptToolName = "ask_user" | "secrets";

/** Publishes one prompt into the originating conversation. */
export type QuestionPromptSend = (
  payload: ReplyPayload,
  options?: { signal?: AbortSignal },
) => void | Promise<void>;

/** A run's own way to show a question prompt. */
export type QuestionPromptDelivery =
  | ConversationQuestionPromptDelivery
  | OwnerQuestionPromptDelivery;

/** Publishes into the conversation the turn came from, shown in `messageChannel`. */
export type ConversationQuestionPromptDelivery = {
  audience?: "conversation";
  send: QuestionPromptSend;
  messageChannel?: string;
};

/** Host-generated capability guidance that is safe to return to the model. */
export class QuestionPromptUnavailableError extends Error {}

/**
 * The turn's sender is a bot, so nobody in its conversation can answer: the
 * prompt goes to the agent's owner on the route proactive delivery uses,
 * `commands.ownerAllowFrom` and then a channel's own `allowFrom`, read from
 * the live config when the prompt is sent.
 */
export type OwnerQuestionPromptDelivery = {
  audience: "owner";
  agentId?: string;
};

/**
 * The prompt delivery for a turn: the owner route when its sender is a bot,
 * otherwise the conversation's own delivery.
 */
export function resolveQuestionPromptDelivery<
  T extends QuestionPromptDelivery | undefined,
>(params: {
  senderIsBot?: boolean;
  agentId?: string;
  conversation: () => T;
}): T | OwnerQuestionPromptDelivery {
  return params.senderIsBot === true
    ? { audience: "owner", agentId: params.agentId }
    : params.conversation();
}

/**
 * Publishes the prompt for an already-committed gateway question record.
 *
 * Rejects when the question cannot become answerable where it was asked, which is
 * what tells the caller to cancel the pending record instead of waiting it out.
 */
export async function sendQuestionToolPrompt(params: {
  toolName: QuestionPromptToolName;
  questionId: string;
  questions: readonly QuestionRequestQuestion[];
  config?: OpenClawConfig;
  delivery: QuestionPromptDelivery;
  signal?: AbortSignal;
  /** Rechecked before an owner prompt is sent, so a question that ended is never published. */
  isCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
  const { questionId, questions, delivery } = params;
  const harnessQuestions = questions.map(({ questionId: id, ...question }) =>
    Object.assign(question, { id }),
  );
  if (delivery.audience === "owner" && params.toolName === "ask_user") {
    await publishOwnerQuestionPrompt({
      agentId: delivery.agentId,
      questionId,
      questions: harnessQuestions,
      signal: params.signal,
      isCurrent: params.isCurrent,
    });
    return;
  }
  const publish: QuestionPromptSend =
    delivery.audience === "owner"
      ? async (payload) => {
          const owner = await resolveCurrentOwnerRoute(delivery.agentId);
          owner.assertCurrent();
          await sendQuestionPromptToRoute({
            ...owner.route,
            payload,
            signal: params.signal,
            handoff: owner.handoff(params.isCurrent),
          });
        }
      : (payload) =>
          params.signal
            ? delivery.send(payload, { signal: params.signal })
            : delivery.send(payload);
  const send: QuestionPromptSend = (payload) =>
    runWithQuestionChannelDeliveries([questionId], () => publish(payload));
  if (params.toolName === "secrets") {
    const binding = questions[0]?.secretStore;
    if (!binding) {
      return;
    }
    const controlUiBase = resolveControlUiSessionLinkBase(params.config);
    const text = controlUiBase
      ? `🔑 Agent requests credential ${binding.name} (${binding.kind}). Reply is disabled for secrets — open to provide it: ${controlUiBase}/ask/${encodeURIComponent(questionId)}`
      : "Credential request unavailable here: no reachable Control UI link. Open a trusted Control UI or native app and retry, or ask the operator to enable Control UI and configure gateway.publicOrigin. Never send credentials in chat.";
    // Correlation keeps this durable without adding answer controls or a plaintext claim.
    await send({ text, channelData: { askUser: { questionId } } });
    if (!controlUiBase) {
      // A visible blocker is not a delivered entry form; cancel the pending wait.
      throw new QuestionPromptUnavailableError(text);
    }
    return;
  }
  await send(
    buildAgentHarnessQuestionPromptPayload({
      questionId,
      questions: harnessQuestions,
      options: { intro: "Question for you:" },
    }),
  );
}

/**
 * Publishes a question asked on a bot sender's turn to the agent's owner. The
 * owner's typed reply cannot answer it, so the prompt links to the question's
 * Control UI page, where every answer form works, and keeps the option
 * buttons the owner's channel renders. Without a reachable Control UI page or
 * an owner route it rejects, and the question is cancelled. Right before the
 * send it confirms the question is still current and the owner route still
 * comes from the live config, so a question that ended, or an owner who was
 * removed, is never sent the prompt.
 */
export async function publishOwnerQuestionPrompt(params: {
  agentId?: string;
  questionId: string;
  questions: readonly AgentHarnessUserInputQuestion[];
  signal?: AbortSignal;
  isCurrent?: () => boolean | Promise<boolean>;
}): Promise<void> {
  const owner = await resolveCurrentOwnerRoute(params.agentId);
  const controlUiBase = resolveControlUiSessionLinkBase(owner.route.cfg);
  if (!controlUiBase) {
    throw new Error(
      "a question for the owner needs its Control UI answer page: configure gateway.publicOrigin",
    );
  }
  if (params.isCurrent && !(await params.isCurrent())) {
    return;
  }
  params.signal?.throwIfAborted();
  owner.assertCurrent();
  const payload = buildAgentHarnessQuestionPromptPayload({
    questionId: params.questionId,
    questions: params.questions,
    options: {
      intro: "Question for you:",
      ownerAnswer: {
        buttons:
          resolveConversationQuestionInputMode({ messageChannel: owner.route.channel }) ===
          "buttons",
        url: `${controlUiBase}/ask/${encodeURIComponent(params.questionId)}`,
      },
    },
  });
  await runWithQuestionChannelDeliveries([params.questionId], () =>
    sendQuestionPromptToRoute({
      ...owner.route,
      payload,
      signal: params.signal,
      handoff: owner.handoff(params.isCurrent),
    }),
  );
}

/**
 * The agent owner's direct route under the live config, with a check that the
 * config is unchanged since: a change after the route resolved may have
 * removed that owner, so the send is rejected and the question cancelled.
 * The check runs before delivery and again at its final handoff, together
 * with the question's own currency, so neither a replaced owner nor an ended
 * question reaches the channel.
 */
async function resolveCurrentOwnerRoute(agentId: string | undefined) {
  const cfg = getRuntimeConfig();
  const route = await resolveOwnerQuestionRoute(cfg, agentId);
  const assertCurrent = () => {
    if (getRuntimeConfig() !== cfg) {
      throw new Error("the owner configuration changed before the question was sent");
    }
  };
  return {
    route,
    assertCurrent,
    handoff: (isCurrent?: () => boolean | Promise<boolean>) => ({
      assertCurrent,
      confirmCurrent: async () => {
        if (isCurrent && !(await isCurrent())) {
          throw new Error("the question ended before its prompt was sent");
        }
        assertCurrent();
      },
    }),
  };
}

/** The agent owner's direct route, or a rejection that cancels the question. */
async function resolveOwnerQuestionRoute(
  cfg: OpenClawConfig,
  agentId: string | undefined,
): Promise<QuestionPromptRoute> {
  const target = await resolveProactiveDeliveryTarget({
    cfg,
    agentId,
    policy: { target: "owner" },
  });
  if (target.channel === "none" || !target.to) {
    throw new Error(
      "a question asked while answering a bot has no owner route: set commands.ownerAllowFrom",
    );
  }
  return {
    cfg,
    channel: target.channel,
    to: target.to,
    accountId: target.accountId,
    threadId: target.threadId,
  };
}
