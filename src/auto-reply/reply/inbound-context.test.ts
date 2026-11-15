import { expect, it } from "vitest";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { MsgContext } from "../templating.js";
import { appendChannelPromptContext } from "./channel-prompt-context.js";
import { markInboundContextLabel } from "./inbound-context-marker.js";
import { finalizeInboundContext, finalizeInboundContextForSdk } from "./inbound-context.js";
import { buildInboundUserContextPrefix } from "./inbound-meta.js";

const rawContext = () => [{ label: "raw", payload: { ok: true } }];
const finalize = (fields: MsgContext) => finalizeInboundContext({ Body: "hello", ...fields });

const replyRoute = {
  OriginatingChannel: "telegram",
  OriginatingTo: "chat:123",
  MessageThreadId: "456",
  InputProvenance: { kind: "internal_system", sourceTool: "existing-source" },
} satisfies Partial<MsgContext>;
it.each([
  ["heartbeat", "heartbeat", true],
  ["exec-event", "exec", true],
  ["cron-event", "cron", false],
  [undefined, "exec", false],
] as const)(
  "normalizes wake source %s without inventing a transport",
  (provider, source, routed) => {
    const fields = {
      Provider: provider,
      Surface: provider,
      InternalTurnSource: provider ? undefined : source,
      ...(routed ? replyRoute : { OriginatingChannel: provider }),
    };
    const ctx = provider ? finalizeInboundContextForSdk(fields) : finalize(fields);
    expect(ctx).toMatchObject({
      InternalTurnSource: source,
      ...(routed ? replyRoute : {}),
    });
    expect([ctx.Provider, ctx.Surface]).toEqual([undefined, undefined]);
    expect(ctx.OriginatingChannel).toBe(routed ? "telegram" : undefined);
  },
);

it("finalizes the group text and conversation contract", () => {
  const ctx = finalize({
    ChatType: "group",
    From: "test:123",
    Body: "[Test] hello",
    RawBody: "hello",
    GroupSubject: "Room",
  });

  expect(ctx).toMatchObject({
    Body: "[Test] hello",
    BodyForAgent: "hello",
    BodyForCommands: "hello",
    ConversationLabel: "Room id:123",
    CommandAuthorized: false,
  });
});
it("keeps suppressed text command input literal across repeated finalization", () => {
  const body = "/new keep this as task text";
  const ctx = finalize({
    Body: body,
    RawBody: body,
    CommandBody: body,
    BodyForCommands: body,
    commandText: body,
    CommandInterpretationSuppressed: true,
    CommandAuthorized: true,
    CommandSource: "text",
    CommandTargetSessionKey: "agent:other:main",
    CommandTurn: {
      kind: "text-slash",
      source: "text",
      authorized: true,
      commandName: "new",
      body,
    },
  });

  const expected = {
    agentText: body,
    rawText: body,
    BodyForAgent: body,
    commandText: "",
    BodyForCommands: "",
    CommandAuthorized: false,
    CommandSource: undefined,
    CommandTurn: { kind: "normal", source: "message", authorized: false, body: "" },
  };
  expect(ctx).toMatchObject(expected);
  expect(resolveCommandTurnTargetSessionKey(ctx)).toBeUndefined();
  expect(finalizeInboundContext(ctx, { forceBodyForCommands: true })).toMatchObject(expected);
});

it("preserves an explicitly empty raw projection", () => {
  const ctx = finalize({ Body: "fallback body", BodyForCommands: "/new payload", RawBody: "" });

  expect(ctx).toMatchObject({ commandText: "/new payload", agentText: "", rawText: "" });
});
it("restores legacy media projections only for the shipped SDK adapter", () => {
  const legacy = {
    MediaPath: "/tmp/photo.jpg",
    MediaUrl: "file:///tmp/photo.jpg",
    MediaType: "image/jpeg",
    MediaDir: "/tmp/media",
    MediaWorkspaceDir: "/tmp/workspace",
    MediaStaged: true,
  };
  const ctx = finalizeInboundContextForSdk({ Body: "hello", ...legacy });
  expect(ctx).toMatchObject({
    ...legacy,
    MediaPaths: [legacy.MediaPath],
    MediaUrls: [legacy.MediaUrl],
    MediaTypes: [legacy.MediaType],
  });
});

it("keeps a singular legacy MediaUrl off the second inbound attachment slot", () => {
  const ctx = finalize({
    MediaPaths: ["/tmp/a.png", "/tmp/b.png"],
    MediaUrls: ["file:///tmp/a.png"],
    MediaUrl: "file:///tmp/a.png",
  });

  expect(ctx.media).toMatchObject([
    { path: "/tmp/a.png", url: "file:///tmp/a.png" },
    { path: "/tmp/b.png", url: undefined },
  ]);
});
it("projects supplemental facts into legacy context fields", () => {
  const ctx = finalize({
    SupplementalContext: {
      quote: {
        id: "reply-1",
        fullId: "room/reply-1",
        body: "quoted",
        sender: "Alice",
        isQuote: true,
      },
      forwarded: { from: "Bob", fromType: "user", fromId: "bob", date: 1_700_000_000 },
      thread: { starterBody: "starter", historyBody: "history", label: "thread label" },
      groupSystemPrompt: "group prompt",
      channelStructuredContext: rawContext(),
    },
  });

  expect(ctx).toMatchObject({
    ReplyToId: "reply-1",
    ReplyToIdFull: "room/reply-1",
    ReplyToBody: "quoted",
    ReplyToSender: "Alice",
    ReplyToIsQuote: true,
    ForwardedFrom: "Bob",
    ForwardedFromType: "user",
    ForwardedFromId: "bob",
    ForwardedDate: 1_700_000_000,
    ThreadStarterBody: "starter",
    ThreadHistoryBody: "history",
    ThreadLabel: "thread label",
    GroupSystemPrompt: "group prompt",
    ChannelStructuredContext: rawContext(),
  });
  expect(Object.hasOwn(ctx, "SupplementalContext")).toBe(false);
});

it("folds the deprecated supplemental structured-context key", () => {
  const supplemental: NonNullable<MsgContext["SupplementalContext"]> = {
    untrustedContext: rawContext(),
  };
  const ctx = finalize({ SupplementalContext: supplemental });

  expect(ctx.ChannelStructuredContext).toEqual(rawContext());
  expect(supplemental.channelStructuredContext).toEqual(rawContext());
  expect(Object.hasOwn(supplemental, "untrustedContext")).toBe(false);
});
it("folds deprecated UntrustedStructuredContext before prompt rendering", () => {
  const entry = {
    label: "Channel metadata",
    source: "test",
    type: "channel_metadata",
    payload: { value: "same bytes" },
  };
  const deprecated = finalize({ UntrustedStructuredContext: [entry] });
  const canonical = finalize({ ChannelStructuredContext: [entry] });

  expect(buildInboundUserContextPrefix(deprecated)).toBe(buildInboundUserContextPrefix(canonical));
  expect(deprecated.ChannelStructuredContext).toEqual([entry]);
  expect(Object.hasOwn(deprecated, "UntrustedStructuredContext")).toBe(false);
});

it("folds deprecated UntrustedContext before prompt rendering", () => {
  const deprecated = finalize({ UntrustedContext: ["Channel metadata (src)\r\nvalue"] });
  const canonical = finalize({ ChannelPromptContext: ["Channel metadata (src)\r\nvalue"] });

  const rendered = appendChannelPromptContext("hello", deprecated.ChannelPromptContext);
  expect(rendered).toBe(appendChannelPromptContext("hello", canonical.ChannelPromptContext));
  expect(rendered).toContain(markInboundContextLabel("Context:"));
  expect(deprecated.ChannelPromptContext).toEqual(["Channel metadata (src)\nvalue"]);
  expect(Object.hasOwn(deprecated, "UntrustedContext")).toBe(false);
});
