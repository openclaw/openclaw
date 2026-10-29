import type { Result } from "@openclaw/normalization-core/result";
import type {
  ErrorShape,
  MentionsListResult,
  UsersMentionableParams,
  UsersMentionableResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { MentionCommittedInput } from "./mention-inbox-input.js";
import type { GatewayClient } from "./server-methods/client-types.js";

/** Keep the Gateway context independent of its context-consuming Inbox implementation. */
export type MentionInbox = {
  mentionable: (
    client: GatewayClient | null,
    input: UsersMentionableParams,
    publish: (result: Result<UsersMentionableResult, ErrorShape>) => undefined,
  ) => Promise<void>;
  /** @deprecated Await validateRecipientsAsync. Removed in a later release after stable deprecation. */
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
  /** @deprecated Await listAsync and publish its current result. The synchronous adapter rejects calls; its signature is removed in a later release after stable deprecation. */
  list: (client: GatewayClient | null) => Result<MentionsListResult, ErrorShape>;
  /** @deprecated Await dismissAsync and publish its current result. The synchronous adapter rejects calls; its signature is removed in a later release after stable deprecation. */
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
  /** @deprecated Queues recording; await recordCommittedInputAsync for completion. */
  recordCommittedInput: (input: MentionCommittedInput) => void;
  /** @deprecated Await invalidateAsync. The synchronous adapter rejects calls; its signature is removed in a later release after stable deprecation. */
  invalidate: (sessionKey?: string) => void;
  recordCommittedInputAsync: (input: MentionCommittedInput) => Promise<void>;
  invalidateAsync: (sessionKey?: string) => Promise<void>;
  dispose: () => Promise<void>;
};
