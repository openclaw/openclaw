import { expect, expectTypeOf, it } from "vitest";
import type { ChannelProgressDraftCompositorSnapshot } from "../channels/progress-draft-compositor.types.js";
import * as schemas from "./bundled-channel-config-schema.js";
import type { ReplyDispatchRuntimeInfo } from "./reply-runtime.js";
import type { PluginRuntime } from "./runtime-store.js";
import type * as Store from "./session-store-runtime.js";

type Session = PluginRuntime["channel"]["session"];
type Inbound = typeof import("./channel-inbound.js");
type ChannelBuilder = Inbound["createChannelInboundEnvelopeBuilder"];
type Timestamp = number | undefined;
type Read = typeof Store.readSessionUpdatedAt;
type ReadAsync = typeof Store.readSessionUpdatedAtAsync;
type AsyncVersion<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => Promise<ReturnType<T>>;

it("adds awaited timestamp preparation without changing released input shapes", () => {
  type AsyncBuilder = Inbound["createChannelInboundEnvelopeBuilderAsync"];
  type AsyncContext = Inbound["resolveInboundSessionEnvelopeContextAsync"];
  type Context = Inbound["resolveInboundSessionEnvelopeContext"];
  expectTypeOf<Session["readSessionUpdatedAt"]>().returns.toEqualTypeOf<Timestamp>();
  expectTypeOf<ReadAsync>().toEqualTypeOf<AsyncVersion<Read>>();
  expectTypeOf<Session["readSessionUpdatedAtAsync"]>().toEqualTypeOf<
    AsyncVersion<Session["readSessionUpdatedAt"]>
  >();
  expectTypeOf<AsyncBuilder>().toEqualTypeOf<AsyncVersion<ChannelBuilder>>();
  expectTypeOf<AsyncContext>().toEqualTypeOf<AsyncVersion<Context>>();
});

it("retains passthrough behavior of legacy channel schemas", () => {
  const schema = schemas.SlackConfigSchema;
  expect(schema.safeParse({ legacySetting: true })).toMatchObject({ success: true });
  expect(schema.toJSONSchema({ target: "draft-07" })).toMatchObject({ type: "object" });
});

it("keeps the 2026.9.8 receipt progress handoff source-compatible", () => {
  type ReleasedReceipt = {
    channel: string;
    accountId?: string;
    to: string;
    threadId?: string | number;
    messageId: string;
    text: string;
    snapshot: ChannelProgressDraftCompositorSnapshot;
  };
  expectTypeOf<ReplyDispatchRuntimeInfo["adoptProgressContinuation"]>().toEqualTypeOf<
    ((this: void, receipt: ReleasedReceipt) => Promise<boolean>) | undefined
  >();
});
