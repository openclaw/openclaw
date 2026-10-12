import type { Result } from "@openclaw/normalization-core/result";
import type {
  ErrorShape,
  MentionsListResult,
  UsersMentionableParams,
  UsersMentionableResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import type { MentionCommittedInput } from "./mention-inbox-input.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { GatewayClient } from "./server-methods/client-types.js";

export type { MentionCommittedInput } from "./mention-inbox-input.js";

type MentionNotification = {
  id: string;
  recipientProfileId: string;
  sessionKey: string;
  agentId: string;
  senderLabel: string;
  sessionTitle: string;
  prepare: () => Promise<void>;
  isCurrent: () => boolean;
};

export type MentionInboxOptions = {
  scheduler: GatewayScheduler;
  gatewayInstanceId: string;
  getRuntimeConfig: () => OpenClawConfig;
  getClients: () => Iterable<GatewayClient>;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  onMentionCreated?: (notification: MentionNotification) => void;
};

/** Keep the Gateway context independent of its context-consuming Inbox implementation. */
export type MentionInbox = {
  mentionable: (
    client: GatewayClient | null,
    input: UsersMentionableParams,
    publish: (result: Result<UsersMentionableResult, ErrorShape>) => undefined,
  ) => Promise<void>;
  /** @deprecated Await validateRecipientsAsync. Removed in the next Plugin SDK major. */
  validateRecipients: (
    client: GatewayClient | null,
    input: UsersMentionableParams,
    profileIds: readonly string[],
  ) => Result<readonly string[], ErrorShape>;
  validateRecipientsAsync: (
    client: GatewayClient | null,
    input: UsersMentionableParams,
    profileIds: readonly string[],
  ) => Promise<Result<readonly string[], ErrorShape>>;
  /** @deprecated Await listAsync and publish its current result. Removed in the next Plugin SDK major. */
  list: (client: GatewayClient | null) => Result<MentionsListResult, ErrorShape>;
  /** @deprecated Await dismissAsync and publish its current result. Removed in the next Plugin SDK major. */
  dismiss: (
    client: GatewayClient | null,
    ids: readonly string[],
  ) => Result<MentionsListResult, ErrorShape>;
  listAsync: (
    client: GatewayClient | null,
    publish: (result: Result<MentionsListResult, ErrorShape>) => undefined,
  ) => Promise<void>;
  dismissAsync: (
    client: GatewayClient | null,
    ids: readonly string[],
    publish: (result: Result<MentionsListResult, ErrorShape>) => undefined,
  ) => Promise<void>;
  /** @deprecated Await recordCommittedInputAsync. Removed in the next Plugin SDK major. */
  recordCommittedInput: (input: MentionCommittedInput) => void;
  /** @deprecated Await invalidateAsync. Removed in the next Plugin SDK major. */
  invalidate: (sessionKey?: string) => void;
  recordCommittedInputAsync: (input: MentionCommittedInput) => Promise<void>;
  invalidateAsync: (sessionKey?: string) => Promise<void>;
  dispose: () => Promise<void>;
};
