import { expect, it } from "vitest";
import { finalizeInboundContextForSdk } from "../auto-reply/reply/inbound-context.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  buildCanonicalSentMessageHookContext,
  deriveInboundMessageHookContext,
  toPluginInboundClaimPair,
  toInternalMessagePreprocessedContext,
  toInternalMessageReceivedContext,
  toInternalMessageSentContext,
  toInternalMessageTranscribedContext,
  toPluginMessageContext,
  toPluginMessageReceivedEvent,
  toPluginMessageSentEvent,
} from "./message-hook-mappers.js";

const audio = { path: "/tmp/a.ogg", url: "https://cdn.test/a.ogg", contentType: "audio/ogg" };
const photo = {
  path: "/tmp/p.jpg",
  url: "/tmp/p.jpg",
  contentType: "image/jpeg",
  workspaceDir: "/tmp",
};
const inboundRouting = {
  channelId: "demo-chat",
  accountId: "acc-1",
  conversationId: "demo-chat:chat:456",
};
const message = { from: "demo-chat:user:123", content: "commands-body", timestamp: 1710000000 };
const inboundTurn = { sessionKey: "session-1", runId: "run-1", messageId: "msg-1" };

function makeInboundCtx(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    From: "demo-chat:user:123",
    To: "demo-chat:chat:456",
    Body: "body",
    BodyForCommands: "commands-body",
    Transcript: "hello transcript",
    Timestamp: 1710000000,
    Provider: "demo-chat",
    Surface: "demo-chat",
    OriginatingChannel: "demo-chat",
    OriginatingTo: "demo-chat:chat:456",
    SessionKey: "session-1",
    AccountId: "acc-1",
    MessageSid: "msg-1",
    SenderId: "sender-1",
    SenderName: "User One",
    SenderUsername: "userone",
    SenderE164: "+15551234567",
    MessageThreadId: 42,
    media: [audio],
    GroupSubject: "ops",
    GroupChannel: "ops-room",
    ...overrides,
  } as FinalizedMsgContext;
}

function makeCanonicalInbound(overrides: Partial<FinalizedMsgContext> = {}) {
  return deriveInboundMessageHookContext(makeInboundCtx(overrides));
}

const expectedMedia = [
  { ...audio, kind: "audio" },
  { ...photo, kind: "image" },
];
const expectedMediaMetadata = {
  mediaPath: "/tmp/a.ogg",
  mediaUrl: "https://cdn.test/a.ogg",
  mediaType: "audio/ogg",
  mediaPaths: ["/tmp/a.ogg", "/tmp/p.jpg"],
  mediaUrls: ["https://cdn.test/a.ogg", "/tmp/p.jpg"],
  mediaTypes: ["audio/ogg", "image/jpeg"],
};

it("uses the session key as the Control UI conversation id", () => {
  const canonical = makeCanonicalInbound({
    From: undefined,
    To: undefined,
    OriginatingTo: undefined,
    Provider: "webchat",
    Surface: "webchat",
    OriginatingChannel: "webchat",
    SessionKey: "agent:main:adopted",
  });

  expect(canonical).toMatchObject({ channelId: "webchat", conversationId: "agent:main:adopted" });
});

it.each([true, false])(
  "projects reply fields without leaking undefined keys (present=%s)",
  (present) => {
    const canonical = makeCanonicalInbound(
      present
        ? {
            ReplyToId: "discord-message-42",
            ReplyToIdFull: "discord:channel-1:discord-message-42",
            ReplyToBody: "quoted Discord reply body",
            ReplyToSender: "Ada",
            ReplyToIsQuote: true,
          }
        : {},
    );
    const fields = {
      replyToId: present ? "discord-message-42" : undefined,
      replyToIdFull: present ? "discord:channel-1:discord-message-42" : undefined,
      replyToBody: present ? "quoted Discord reply body" : undefined,
      replyToSender: present ? "Ada" : undefined,
      replyToIsQuote: present ? true : undefined,
    };
    const { context, event } = toPluginInboundClaimPair(canonical);
    const received = toPluginMessageReceivedEvent(canonical);
    expect(canonical).toMatchObject(fields);
    for (const output of [toPluginMessageContext(canonical), context, event, received]) {
      expect(
        Object.fromEntries(Object.entries(output).filter(([key]) => key.startsWith("replyTo"))),
      ).toEqual(present ? fields : {});
    }
    for (const metadata of [event.metadata, received.metadata]) {
      expect(metadata).toMatchObject(fields);
      expect(Object.keys(metadata ?? {}).filter((key) => key.startsWith("replyTo"))).toEqual(
        Object.keys(fields),
      );
    }
  },
);

it("falls back to raw body when command body is blank", () => {
  const canonical = makeCanonicalInbound({
    BodyForCommands: " \n\t",
    RawBody: "Readiness probe failed",
  });

  expect(canonical.content).toBe("Readiness probe failed");
});

it("supports explicit content/messageId overrides", () => {
  const canonical = deriveInboundMessageHookContext(makeInboundCtx(), {
    content: "override-content",
    messageId: "override-msg",
  });

  expect(canonical).toMatchObject({ content: "override-content", messageId: "override-msg" });
});

it.each([
  ["sparse", [{}, { path: "/tmp/sparse.png", contentType: "image/png" }], "/tmp/sparse.png", 1],
  ["type-only", [{ contentType: "image/png" }], undefined, 0],
] as const)("dual-emits %s hook media from canonical facts", (_name, media, path, index) => {
  const ctx = finalizeInboundContextForSdk(makeInboundCtx({ media: [...media] }));
  const { event } = toPluginInboundClaimPair(deriveInboundMessageHookContext(ctx));
  expect(event.media?.[index]?.path).toBe(path);
  expect(event.metadata?.mediaPath).toBe(path);
});

it("withholds pending remote media from every inbound hook event", () => {
  const remote = {
    path: "/remote-host/photo.jpg",
    url: "media://remote/photo.jpg",
    contentType: "image/jpeg",
  };
  const canonical = { ...makeCanonicalInbound({ media: [remote] }), mediaStagingPending: true };
  const expectedOriginalMedia = [{ ...remote, kind: "image" }];

  for (const event of [
    toPluginInboundClaimPair(canonical).event,
    toPluginMessageReceivedEvent(canonical),
    toInternalMessageReceivedContext(canonical),
    toInternalMessageTranscribedContext(canonical, {}),
    toInternalMessagePreprocessedContext(canonical, {}),
  ]) {
    expect(event.mediaStagingPending).toBe(true);
    expect(event.originalMedia).toEqual(expectedOriginalMedia);
    expect(event.media).toBeUndefined();
  }
  expect(toPluginInboundClaimPair(canonical).event.metadata?.mediaPath).toBeUndefined();
  expect(toPluginMessageReceivedEvent(canonical).metadata?.mediaPath).toBeUndefined();
  expect(toInternalMessageReceivedContext(canonical).metadata?.mediaPath).toBeUndefined();
});

it.each([false, true])("projects retained media facts (staged=%s)", (staged) => {
  const paths = staged ? ["/tmp/tree.jpg", "/tmp/ramp.jpg"] : ["/tmp/tree.jpg"];
  const urls = staged
    ? ["file:///tmp/tree.jpg", "file:///tmp/ramp.jpg"]
    : ["/tmp/tree.jpg", "https://cdn.test/ramp.jpg"];
  const types = ["image/jpeg", staged ? "image/jpeg" : "image"];
  const media = staged
    ? [
        { path: "/remote/tree.jpg", contentType: "image/jpeg", messageId: "tree" },
        { path: "/remote/ramp.jpg", contentType: "image/jpeg", messageId: "ramp" },
      ]
    : [
        { path: paths[0], contentType: types[0] },
        { url: urls[1], kind: "image" as const },
      ];
  const input = makeInboundCtx({
    media,
    ...(staged ? { MediaPaths: paths, MediaUrls: urls, MediaTypes: types, MediaStaged: true } : {}),
  });
  const canonical = deriveInboundMessageHookContext(
    staged ? finalizeInboundContextForSdk(input) : input,
  );
  expect(canonical).toMatchObject({
    mediaPath: paths[0],
    mediaUrl: urls[0],
    mediaType: types[0],
    mediaPaths: paths,
    mediaUrls: urls,
    mediaTypes: types,
  });
  if (!staged) {
    expect(canonical.media).toEqual([
      { path: paths[0], contentType: types[0], kind: "image" },
      { url: urls[1], kind: "image" },
    ]);
  }
});

it("maps received payloads and freezes plugin traces", () => {
  const trace: DiagnosticTraceContext = {
    traceId: "11111111111111111111111111111111",
    spanId: "2222222222222222",
    parentSpanId: "3333333333333333",
    traceFlags: "01",
  };
  const traceFields = {
    trace,
    traceId: trace.traceId,
    spanId: trace.spanId,
    parentSpanId: trace.parentSpanId,
  };
  const canonical = {
    ...makeCanonicalInbound({ TopicName: "Deployments", media: [audio, photo] }),
    runId: "run-1",
    trace,
    callDepth: 2,
  };

  const pluginContext = toPluginMessageContext(canonical);
  const receivedEvent = toPluginMessageReceivedEvent(canonical);
  const internalReceived = toInternalMessageReceivedContext(canonical);
  expect(pluginContext).toEqual({
    ...inboundRouting,
    ...inboundTurn,
    senderId: "sender-1",
    ...traceFields,
    callDepth: 2,
  });
  const claim = toPluginInboundClaimPair(canonical);
  const sent = buildCanonicalSentMessageHookContext({
    to: "demo-chat:chat:456",
    content: "reply",
    success: true,
    channelId: "demo-chat",
    trace,
  });
  for (const copy of [
    pluginContext.trace,
    receivedEvent.trace,
    claim.context.trace,
    claim.event.trace,
    toPluginMessageSentEvent(sent).trace,
  ]) {
    expect(copy).not.toBe(trace);
    expect(copy).toEqual(trace);
    expect(Object.isFrozen(copy)).toBe(true);
  }
  expect(receivedEvent).toMatchObject({
    ...message,
    ...inboundTurn,
    threadId: 42,
    senderId: "sender-1",
    media: expectedMedia,
    ...traceFields,
  });
  expect(internalReceived).toMatchObject({
    ...message,
    ...inboundRouting,
    messageId: "msg-1",
    media: expectedMedia,
  });
  for (const metadata of [receivedEvent.metadata, internalReceived.metadata]) {
    expect(metadata).toMatchObject({
      ...expectedMediaMetadata,
      senderName: "User One",
      senderUsername: "userone",
      senderE164: "+15551234567",
      threadId: 42,
      topicName: "Deployments",
    });
  }
  expect(receivedEvent.metadata?.messageId).toBe("msg-1");
});

it.each([
  ["rejected", undefined, "channel:room-123", undefined],
  ["direct-message", "claim-chat:123", "channel:456", "user:123"],
])("honors the channel plugin's %s claim resolution", (_name, from, to, conversationId) => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "claim-chat",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "claim-chat", label: "Claim chat" }),
          messaging: {
            resolveInboundConversation: ({ from: sender }) => {
              const normalizedFrom = sender?.replace(/^claim-chat:/i, "").trim();
              return normalizedFrom ? { conversationId: `user:${normalizedFrom}` } : null;
            },
          },
        } satisfies ChannelPlugin,
      },
    ]),
  );
  const canonical = makeCanonicalInbound({
    Provider: "claim-chat",
    Surface: "claim-chat",
    OriginatingChannel: "claim-chat",
    From: from,
    To: to,
    OriginatingTo: to,
    GroupChannel: undefined,
    GroupSubject: undefined,
  });
  const { context, event } = toPluginInboundClaimPair(canonical);
  expect(event.conversationId).toBe(conversationId);
  expect(context).toMatchObject({
    channelId: "claim-chat",
    accountId: "acc-1",
    conversationId,
    sessionKey: "session-1",
    senderId: "sender-1",
    messageId: "msg-1",
  });
});

it.each([
  ["transcribed", toInternalMessageTranscribedContext, { transcript: "" }],
  [
    "preprocessed",
    toInternalMessagePreprocessedContext,
    { transcript: undefined, isGroup: true, groupId: "demo-chat:chat:456" },
  ],
] as const)("maps the internal %s payload", (_name, project, expected) => {
  const cfg: OpenClawConfig = {};
  const result = project(makeCanonicalInbound({ Transcript: undefined }), cfg);
  expect(result).toMatchObject(expected);
  expect(result.cfg).toBe(cfg);
  expect(result.media).toEqual([{ ...audio, kind: "audio" }]);
});

it("maps sent context consistently for plugin/internal hooks", () => {
  const delivery = {
    to: "demo-chat:chat:456",
    content: "reply",
    success: false,
    error: "network error",
  };
  const inputRouting = { channelId: "demo-chat", accountId: "acc-1" };
  const routing = { ...inputRouting, conversationId: "demo-chat:chat:456" };
  const turn = { sessionKey: "session-1", runId: "run-out-1", messageId: "out-1" };
  const group = { isGroup: true, groupId: "demo-chat:chat:456" };
  const canonical = buildCanonicalSentMessageHookContext({
    ...delivery,
    ...inputRouting,
    ...turn,
    ...group,
  });
  expect(toPluginMessageContext(canonical)).toEqual({ ...routing, ...turn });
  expect(toPluginMessageSentEvent(canonical)).toEqual({ ...delivery, ...turn });
  expect(toInternalMessageSentContext(canonical)).toEqual({
    ...delivery,
    ...routing,
    messageId: "out-1",
    ...group,
  });
});

it("projects normalized location and stable provider update identity", () => {
  const canonical = makeCanonicalInbound({
    LocationLat: 43.8376,
    LocationLon: 18.4534,
    LocationAccuracy: 12,
    LocationSource: "live",
    LocationIsLive: true,
    LocationLivePeriodSeconds: 900,
    ProviderUpdateId: "9002",
    ProviderUpdateKind: "edited_message",
    ProviderMessageTimestamp: 1_786_094_460_000,
    ProviderEditTimestamp: 1_786_094_520_000,
  });

  const { event } = toPluginInboundClaimPair(canonical);
  expect(event.location).toEqual({
    latitude: 43.8376,
    longitude: 18.4534,
    accuracy: 12,
    source: "live",
    isLive: true,
    livePeriodSeconds: 900,
  });
  expect(event.providerUpdate).toEqual({
    id: "9002",
    kind: "edited_message",
    messageId: "msg-1",
    messageTimestamp: 1_786_094_460_000,
    editedTimestamp: 1_786_094_520_000,
  });
  expect(toPluginMessageReceivedEvent(canonical)).toMatchObject({
    location: event.location,
    providerUpdate: event.providerUpdate,
  });
});
