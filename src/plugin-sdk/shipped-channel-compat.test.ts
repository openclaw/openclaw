import { expect, expectTypeOf, it } from "vitest";
import type { ChannelProgressDraftCompositorSnapshot } from "../channels/progress-draft-compositor.types.js";
import * as schemas from "./bundled-channel-config-schema.js";
import type { ChannelInboundEnvelopeInput as EnvelopeInput } from "./channel-inbound.js";
import type { inspectConversationBinding } from "./conversation-binding-inspection-runtime.js";
import type { ReplyDispatchRuntimeInfo } from "./reply-runtime.js";
import type { PluginRuntime } from "./runtime-store.js";
import type {
  SessionBindingRecord as Binding,
  SessionBindingService as Bindings,
} from "./session-binding-runtime.js";
import type { readSessionUpdatedAt, readSessionUpdatedAtAsync } from "./session-store-runtime.js";
import {
  createLegacyCompatChannelDmPolicy,
  promptLegacyChannelAllowFromForAccount,
} from "./setup-runtime.js";
import type {
  AccountScopedConversationBindingManager as BindingManager,
  AccountScopedConversationBindingRecord as AccountBinding,
} from "./thread-bindings-runtime.js";

type Session = PluginRuntime["channel"]["session"];
type Inbound = typeof import("./channel-inbound.js");
type ChannelBuilder = Inbound["createChannelInboundEnvelopeBuilder"];
type Envelope = typeof import("./inbound-envelope.js");
type Timestamp = number | undefined;
type TimestampCallback = (params: { storePath: string; sessionKey: string }) => Timestamp;
type EnvelopeBuilder = (input: EnvelopeInput) => string;
type BuiltEnvelope = { storePath: string; body: string };

it("retains the synchronous binding selectors shipped in 2026.9.8", () => {
  expectTypeOf<Bindings["listBySession"]>().toEqualTypeOf<
    (targetSessionKey: string) => Binding[]
  >();
  expectTypeOf<Bindings["resolveByConversation"]>().returns.toEqualTypeOf<Binding | null>();
  expectTypeOf<BindingManager["getByConversationId"]>().toEqualTypeOf<
    (conversationId: string) => AccountBinding | undefined
  >();
  expectTypeOf<typeof inspectConversationBinding>().returns.toEqualTypeOf<
    { status: "available"; binding: Binding | null } | { status: "unavailable" }
  >();
});

it("retains synchronous envelope results and timestamp callbacks shipped in 2026.9.8", () => {
  type Builder = Envelope["createInboundEnvelopeBuilder"];
  type Route = Envelope["resolveInboundRouteEnvelopeBuilder"];
  type RuntimeRoute = Envelope["resolveInboundRouteEnvelopeBuilderWithRuntime"];
  type ChannelRoute = Inbound["resolveChannelInboundRouteEnvelope"];
  expectTypeOf<typeof readSessionUpdatedAt>().returns.toEqualTypeOf<Timestamp>();
  expectTypeOf<Session["readSessionUpdatedAt"]>().returns.toEqualTypeOf<Timestamp>();
  expectTypeOf<ChannelBuilder>().returns.toEqualTypeOf<EnvelopeBuilder>();
  expectTypeOf<ReturnType<ChannelRoute>["buildEnvelope"]>().toEqualTypeOf<EnvelopeBuilder>();
  expectTypeOf<
    ReturnType<Inbound["resolveInboundSessionEnvelopeContext"]>["previousTimestamp"]
  >().toEqualTypeOf<Timestamp>();
  expectTypeOf<Parameters<Builder>[0]["readSessionUpdatedAt"]>().toEqualTypeOf<TimestampCallback>();
  expectTypeOf<ReturnType<Builder>>().returns.toEqualTypeOf<BuiltEnvelope>();
  expectTypeOf<ReturnType<Route>["buildEnvelope"]>().returns.toEqualTypeOf<BuiltEnvelope>();
  type RuntimeTimestampCallback =
    Parameters<RuntimeRoute>[0]["runtime"]["session"]["readSessionUpdatedAt"];
  expectTypeOf<RuntimeTimestampCallback>().toEqualTypeOf<TimestampCallback>();
  expectTypeOf<ReturnType<RuntimeRoute>["buildEnvelope"]>().returns.toEqualTypeOf<BuiltEnvelope>();
});

it("adds awaited timestamp preparation without changing released input shapes", () => {
  type Read = typeof readSessionUpdatedAt;
  type ReadAsync = typeof readSessionUpdatedAtAsync;
  type AsyncBuilder = Inbound["createChannelInboundEnvelopeBuilderAsync"];
  type AsyncContext = Inbound["resolveInboundSessionEnvelopeContextAsync"];
  type Context = Inbound["resolveInboundSessionEnvelopeContext"];
  expectTypeOf<ReadAsync>().returns.toEqualTypeOf<Promise<Timestamp>>();
  expectTypeOf<Parameters<ReadAsync>>().toEqualTypeOf<Parameters<Read>>();
  expectTypeOf<Session["readSessionUpdatedAtAsync"]>().returns.toEqualTypeOf<Promise<Timestamp>>();
  expectTypeOf<Parameters<Session["readSessionUpdatedAtAsync"]>>().toEqualTypeOf<
    Parameters<Session["readSessionUpdatedAt"]>
  >();
  expectTypeOf<Parameters<AsyncBuilder>>().toEqualTypeOf<Parameters<ChannelBuilder>>();
  expectTypeOf<AsyncBuilder>().returns.toEqualTypeOf<Promise<EnvelopeBuilder>>();
  expectTypeOf<Parameters<AsyncContext>>().toEqualTypeOf<Parameters<Context>>();
  expectTypeOf<AsyncContext>().returns.toEqualTypeOf<Promise<ReturnType<Context>>>();
});

it("retains named config schema exports used by published channel packages", () => {
  for (const schema of [
    schemas.SlackConfigSchema,
    schemas.DiscordConfigSchema,
    schemas.SignalConfigSchema,
    schemas.MSTeamsConfigSchema,
  ]) {
    expect(schema.safeParse({ legacySetting: true })).toMatchObject({ success: true });
    expect(schema.toJSONSchema({ target: "draft-07" })).toMatchObject({ type: "object" });
  }
});

it("retains setup helpers used by published Slack and Discord packages", () => {
  expect(createLegacyCompatChannelDmPolicy).toBeTypeOf("function");
  expect(promptLegacyChannelAllowFromForAccount).toBeTypeOf("function");
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
