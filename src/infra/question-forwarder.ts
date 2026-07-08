import { formatAgentHarnessUserInputPrompt } from "../agents/harness/user-input-bridge.js";
// Forwards pending ask_user_question prompts to the originating turn-source chat
// so options appear as native buttons (Telegram inline keyboard / Slack Block Kit)
// without the user having to notice the text stream. Reuses the durable outbound
// delivery path (sendDurableMessageBatch); it does not invent a new send route.
//
// Button contract: each option runs `/answer <n>` and a free-text Other runs
// `/answer`. Telegram needs a command-type action (native-command callback),
// while Slack restricts command-type buttons to exec-approval commands, so Slack
// uses a callback-value action (resolved by the Slack block-action handler). This
// module builds the portable presentation core-side (core cannot import extension
// modules) and each channel's native presentation renderer converts it on delivery.
import type { ReplyPayload } from "../auto-reply/types.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { QuestionRecord } from "../gateway/question-manager.js";
import type { MessagePresentation, MessagePresentationButton } from "../interactive/payload.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";

const log = createSubsystemLogger("gateway/questions");

type DeliverQuestionPayloads =
  typeof import("../channels/message/runtime.js").sendDurableMessageBatch;

export type QuestionForwarderDeps = {
  getConfig?: () => OpenClawConfig;
  deliver?: DeliverQuestionPayloads;
};

export type QuestionForwarder = {
  onPending: (record: QuestionRecord) => void;
  onResolved: (record: QuestionRecord) => void;
  onExpired: (record: QuestionRecord) => void;
  stop: () => void;
};

type ResolvedTarget = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
};

/** Builds the deliverable turn-source target from a record, or null when undeliverable. */
export function resolveQuestionTarget(record: QuestionRecord): ResolvedTarget | null {
  const channel = record.turnSourceChannel
    ? (normalizeMessageChannel(record.turnSourceChannel) ?? undefined)
    : undefined;
  const to = record.turnSourceTo?.trim();
  if (!channel || !to || !isDeliverableMessageChannel(channel)) {
    return null;
  }
  return {
    channel,
    to,
    ...(record.turnSourceAccountId ? { accountId: record.turnSourceAccountId } : {}),
    ...(record.turnSourceThreadId != null ? { threadId: record.turnSourceThreadId } : {}),
  };
}

function answerButton(channel: string, label: string, command: string): MessagePresentationButton {
  // Telegram routes command-type button actions through the native-command
  // callback path; Slack only renders command buttons for exec-approval commands,
  // so /answer travels as a callback value there.
  return channel === "slack"
    ? { label, action: { type: "callback", value: command } }
    : { label, action: { type: "command", command }, value: command };
}

/** Builds the option-button presentation for a single-question prompt, else undefined. */
export function buildQuestionPresentation(
  record: QuestionRecord,
  channel: string,
): MessagePresentation | undefined {
  if (record.questions.length !== 1) {
    return undefined;
  }
  const question = record.questions[0];
  const options = question?.options ?? [];
  const buttons: MessagePresentationButton[] = options.map((option, index) =>
    answerButton(channel, option.label, `/answer ${index + 1}`),
  );
  if (question?.isOther !== false) {
    buttons.push(answerButton(channel, "✏️ Other", "/answer"));
  }
  return buttons.length > 0 ? { blocks: [{ type: "buttons", buttons }] } : undefined;
}

/** Builds the outbound reply payload (text + option buttons) for a pending question. */
export function buildQuestionForwardPayload(record: QuestionRecord, channel: string): ReplyPayload {
  const text = formatAgentHarnessUserInputPrompt(record.questions, {
    intro: "The agent has a question:",
  });
  const presentation = buildQuestionPresentation(record, channel);
  return presentation ? { text, presentation } : { text };
}

/**
 * Creates a QuestionManager-emitter-shaped forwarder that pushes each pending
 * question to its turn-source chat exactly once (deduped by record id, so a
 * reconnect/replay does not re-push), and clears the dedupe entry on resolve/expiry.
 */
export function createQuestionForwarder(deps: QuestionForwarderDeps = {}): QuestionForwarder {
  const getConfig = deps.getConfig ?? getRuntimeConfig;
  const deliver =
    deps.deliver ??
    (async (params) => {
      const { sendDurableMessageBatch } = await import("../channels/message/runtime.js");
      return sendDurableMessageBatch(params);
    });
  const pushed = new Set<string>();

  const onPending = (record: QuestionRecord): void => {
    if (pushed.has(record.id)) {
      return;
    }
    const target = resolveQuestionTarget(record);
    if (!target) {
      return;
    }
    pushed.add(record.id);
    const payload = buildQuestionForwardPayload(record, target.channel);
    void (async () => {
      const result = await deliver({
        cfg: getConfig(),
        channel: target.channel,
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
        payloads: [payload],
      });
      if (result.status === "failed" || result.status === "partial_failed") {
        throw result.error;
      }
    })().catch((err: unknown) => {
      log.error(`questions: failed to forward ${record.id} to ${target.channel}: ${String(err)}`);
    });
  };

  const clear = (record: QuestionRecord): void => {
    pushed.delete(record.id);
  };

  return {
    onPending,
    onResolved: clear,
    onExpired: clear,
    stop: () => pushed.clear(),
  };
}
