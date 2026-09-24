import type { Result } from "@openclaw/normalization-core/result";
import type {
  ErrorShape,
  HumanMention,
  MentionsListResult,
  UsersMentionableParams,
  UsersMentionableResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "./server-methods/client-types.js";

export type MentionCommittedInput = {
  sourceId: string;
  committedSource: { generation: string; sequence: number; timestamp: number };
  sessionKey: string;
  agentId?: string;
  sessionId: string;
  messageId: string;
  senderProfileId: string;
  recipientProfileIds: readonly string[];
  /** Committed source text; the Inbox redacts before retaining any excerpt. */
  excerpt?: string;
  mentions?: readonly HumanMention[];
};

/** Keep the Gateway context independent of its context-consuming Inbox implementation. */
export type MentionInbox = {
  mentionable: (
    client: GatewayClient | null,
    input: UsersMentionableParams,
    publish: (result: Result<UsersMentionableResult, ErrorShape>) => undefined,
  ) => Promise<void>;
  validateRecipients: (
    client: GatewayClient | null,
    input: UsersMentionableParams,
    profileIds: readonly string[],
  ) => Promise<Result<readonly string[], ErrorShape>>;
  list: (
    client: GatewayClient | null,
    publish: (result: Result<MentionsListResult, ErrorShape>) => void,
  ) => Promise<void>;
  dismiss: (
    client: GatewayClient | null,
    ids: readonly string[],
    publish: (result: Result<MentionsListResult, ErrorShape>) => void,
  ) => Promise<void>;
  recordCommittedInput: (input: MentionCommittedInput) => Promise<void>;
  invalidate: (sessionKey?: string) => Promise<void>;
  dispose: () => Promise<void>;
};
