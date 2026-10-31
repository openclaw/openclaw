import type { SessionHistorySubagentFacts } from "../config/sessions/session-history-types.js";
import type {
  ChatDisplayProjectionOptions,
  prepareChatHistoryRecoveryFacts,
  projectChatDisplayMessagesWithState,
} from "./chat-display-projection.core.js";

type ChatDisplayWorkerOptions = Omit<
  ChatDisplayProjectionOptions,
  "subagentCoordination" | "resolveCronJobName" | "resolveCurrentUserProfileDisplay"
>;

type DeliveryDirectiveMessage = {
  role: "assistant";
  content: Array<Record<string, unknown>>;
  openclawDelivery?: unknown;
};

export type ChatTextWorkerInput =
  | {
      kind: "display";
      messages: unknown[];
      options: ChatDisplayWorkerOptions;
      subagentCoordination: boolean;
      cronNames: boolean;
    }
  | { kind: "recovery"; messages: unknown[]; options: ChatDisplayWorkerOptions }
  | { kind: "recovery-facts"; messages: unknown[]; options: ChatDisplayWorkerOptions }
  | { kind: "tts-supplement-marker"; text: string }
  | { kind: "reply-context"; message: unknown }
  | { kind: "media-sources"; message: unknown }
  | { kind: "delivery-directives"; message: DeliveryDirectiveMessage };

export type ChatTextWorkerResult =
  | { kind: "display"; value: ReturnType<typeof projectChatDisplayMessagesWithState> }
  | { kind: "recovery"; value: unknown[] }
  | { kind: "recovery-facts"; value: ReturnType<typeof prepareChatHistoryRecoveryFacts> }
  | { kind: "tts-supplement-marker"; value: { textSha256: string } }
  | { kind: "reply-context"; value: { body: string; assistant: boolean } | undefined }
  | { kind: "media-sources"; value: string[] }
  | { kind: "delivery-directives"; value: DeliveryDirectiveMessage };

export type ChatTextWorkerQuery =
  | { kind: "coordination"; messages: unknown[] }
  | { kind: "cron"; ids: string[] };

export type ChatTextWorkerFacts =
  | { kind: "coordination"; value: SessionHistorySubagentFacts }
  | { kind: "cron"; value: Array<[string, string | undefined]> };
