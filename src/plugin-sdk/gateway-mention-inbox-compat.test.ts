import type { Result } from "@openclaw/normalization-core/result";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { expectTypeOf, it } from "vitest";
import type { ErrorShape, MentionsListResult } from "../../packages/gateway-protocol/src/index.js";

it("accepts the synchronous Mention Inbox caller contract released in v2026.9.8", () => {
  type Client = GatewayRequestHandlerOptions["client"];
  type Inbox = NonNullable<GatewayRequestHandlerOptions["context"]["mentionInbox"]>;
  type InboxResult = Result<MentionsListResult, ErrorShape>;
  type ReleasedInbox = {
    list: (client: Client) => InboxResult;
    dismiss: (client: Client, ids: readonly string[]) => InboxResult;
    recordCommittedInput: (input: {
      sourceId: string;
      committedSource: { generation: string; sequence: number; timestamp: number };
      sessionKey: string;
      agentId?: string;
      sessionId: string;
      messageId: string;
      senderProfileId: string;
      recipientProfileIds: readonly string[];
      excerpt?: string;
    }) => void;
    invalidate: (sessionKey?: string) => void;
  };
  expectTypeOf<Inbox>().toExtend<ReleasedInbox>();
  expectTypeOf<Inbox["list"]>().returns.toEqualTypeOf<InboxResult>();
  expectTypeOf<Inbox["dismiss"]>().returns.toEqualTypeOf<InboxResult>();
  expectTypeOf<Inbox["recordCommittedInput"]>().toEqualTypeOf<
    ReleasedInbox["recordCommittedInput"]
  >();
  expectTypeOf<Inbox["invalidate"]>().toEqualTypeOf<ReleasedInbox["invalidate"]>();
});
