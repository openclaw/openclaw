import { createHash } from "node:crypto";
import path from "node:path";
import { STREAM_ERROR_FALLBACK_TEXT } from "@openclaw/ai/internal/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createSessionProjection,
  projectLiveSessionMessage,
} from "../../packages/gateway-client/src/session-projection.js";
import { getMediaDir } from "../media/store.js";
import * as assistantDisplay from "../shared/assistant-display-content.js";
import { readRunFailureNotice } from "../shared/run-failure-notice.js";
import { augmentChatHistoryWithCanvasBlocks } from "./chat-display-projection.canvas.js";
import {
  projectChatDisplayMessage,
  projectChatDisplayMessages,
  projectChatDisplayMessagesWithState,
} from "./chat-display-projection.js";
import { sanitizeChatHistoryMessages } from "./chat-display-projection.sanitize.js";

const text = (value: string) => ({ type: "text", text: value });

it("admits display content once before sanitizing a history page", () => {
  const messages = [
    { role: "user", content: "Show the report" },
    {
      role: "assistant",
      content: [text("model-only")],
      openclawDisplayContent: [text("Visible report")],
      providerReplay: { private: "replay" },
    },
    { role: "toolResult", toolCallId: "read-1", content: [text("Tool output")] },
  ];
  const original = structuredClone(messages);
  const admission = vi.spyOn(assistantDisplay, "projectAssistantDisplayContent");
  try {
    const projected = projectChatDisplayMessages([null, ...messages, "invalid"]);
    expect(JSON.stringify(projected)).toBe(
      JSON.stringify([
        messages[0],
        { role: "assistant", content: [text("Visible report")] },
        messages[2],
      ]),
    );
    expect(messages).toEqual(original);
    expect(admission).toHaveBeenCalledTimes(messages.length);
  } finally {
    admission.mockRestore();
  }
});

it("preserves model-change labels without exposing other custom-message details", () => {
  const message = {
    role: "custom",
    customType: "session-model-change",
    display: true,
    content: "Model changed from Demo model A to Demo model B.",
    details: { from: "Demo model A", to: "Demo model B", diagnostic: "PRIVATE_DETAIL" },
  };
  expect(projectStable([message])).toEqual([
    { ...message, details: { from: "Demo model A", to: "Demo model B" } },
  ]);
  for (const details of [{ from: "Demo model A" }, { from: 1, to: "Demo model B" }]) {
    const projected = projectStable([{ ...message, details }]);
    expect(projected[0]).not.toHaveProperty("details");
  }
});

it("preserves catalog text that resembles an OpenClaw reply-control token", () => {
  expect(
    projectChatDisplayMessages([
      {
        role: "assistant",
        content: [text("NO_REPLY")],
        __openclaw: { catalogDisplay: { type: "agentMessage" } },
      },
    ]),
  ).toEqual([expect.objectContaining({ content: [text("NO_REPLY")] })]);
});

const phasedText = (value: string, phase: string) => ({
  ...text(value),
  textSignature: JSON.stringify({ v: 1, id: phase, phase }),
});
const userRow = <T extends Record<string, unknown>>(content: string, metadata: T) => ({
  role: "user",
  content,
  __openclaw: metadata,
});
const assistant = <T, F extends Record<string, unknown>>(content: T, fields: F) => ({
  role: "assistant",
  content,
  ...fields,
});
const toolResult = <T extends Record<string, unknown>>(toolName: string, fields: T) => ({
  type: "toolResult",
  toolName,
  ...fields,
});
function expectSanitized(
  input: unknown,
  expected: unknown,
  maxChars?: number,
  options?: Parameters<typeof sanitizeChatHistoryMessages>[2],
) {
  const original = structuredClone(input);
  expect(sanitizeChatHistoryMessages([input], maxChars, options)).toEqual([expected]);
  expect(input).toEqual(original);
}
const toolRows = (result: Record<string, unknown>) => [
  { ...result, role: "toolResult" },
  { role: "assistant", content: [result] },
];
function projectStable(
  messages: Parameters<typeof projectChatDisplayMessages>[0],
  options?: Parameters<typeof projectChatDisplayMessages>[1],
) {
  const original = structuredClone(messages);
  const projected = projectChatDisplayMessages(messages, options);
  expect(messages).toEqual(original);
  if (!options) {
    expect(projectChatDisplayMessages(projected)).toEqual(projected);
  }
  return projected;
}

it("hides private yield inputs without changing canonical arguments", () => {
  const publicInput = { acknowledgment: "Waiting." };
  const args = Object.freeze({ ...publicInput, message: "PRIVATE_YIELD_CONTEXT" });
  const call = { type: "toolCall", name: "sessions_yield", arguments: args, input: args };
  const publicCall = { type: "toolCall", name: "message", arguments: { message: "Public reply" } };
  const message = assistant([call, publicCall], {});
  expect(projectStable([message])).toEqual([
    {
      ...message,
      content: [{ ...call, arguments: publicInput, input: publicInput }, publicCall],
    },
  ]);
  expect(args.message).toBe("PRIVATE_YIELD_CONTEXT");
});

it.each(["<", "<tool_"])(
  "hides a standalone %j before a native call in refreshed history",
  (fragment) => {
    const call = {
      type: "toolCall",
      id: "read-prelude",
      name: "read",
      arguments: { path: "literal-<tool_.txt" },
    };
    const message = assistant([text(fragment), call], { stopReason: "toolUse" });
    const original = structuredClone(message);
    const projected = sanitizeChatHistoryMessages([message]);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toHaveProperty("content", expect.arrayContaining([call]));
    expect(projected[0]).toHaveProperty(
      "content",
      expect.not.arrayContaining([expect.objectContaining(text(fragment))]),
    );
    expect(message).toEqual(original);
    expect(sanitizeChatHistoryMessages(projected)).toEqual(projected);
  },
);

it("preserves literal, user, and text-only marker content in refreshed history", () => {
  const call = { type: "toolCall", id: "read-controls", name: "read", arguments: {} };
  const messages = [
    assistant([text("<tool_")], {}),
    assistant([text("a < b"), call], {}),
    assistant([text("Use `<tool_` literally."), call], {}),
    assistant([text("```xml\n"), text("<tool_"), text("\n```"), call], {}),
    { role: "user", content: [text("<tool_"), call] },
  ];
  expect(sanitizeChatHistoryMessages(messages)).toEqual(messages);
});

it("strips attachment capabilities even after another field changed", () => {
  const attachment = {
    kind: "document",
    label: "report.csv",
    url: "/api/chat/media/outgoing/agent%3Amain%3Amain/id/full",
  };
  expectSanitized(
    assistant(
      [
        {
          type: "attachment",
          thinkingSignature: "private-reasoning-signature",
          attachment: {
            ...attachment,
            path: "/tmp/private-report.csv",
            url: attachment.url + "?mediaTicket=secret",
          },
        },
      ],
      {},
    ),
    assistant([{ type: "attachment", attachment }], {}),
  );
});

it("normalizes context markers independently from assistant billing", () => {
  const usage = { input: 6, output: 77, cacheRead: 54_631, totalTokens: 54_714 };
  const marker = { state: "available", promptTokens: 27_378, totalTokens: 27_379 };
  const message = (contextUsage: unknown) =>
    assistant("done", { usage: { ...usage, contextUsage } });
  const projected = sanitizeChatHistoryMessages([
    message({ ...marker, source: "private" }),
    message({ state: "unavailable", source: "private", promptTokens: 100 }),
    message({ state: "available", promptTokens: 27_378 }),
    message({ state: "available", promptTokens: 27_378, totalTokens: 27_000 }),
    message({ state: "available", promptTokens: Number.POSITIVE_INFINITY, totalTokens: 30_000 }),
    message({ state: "available", promptTokens: 0, totalTokens: 0 }),
  ]) as Array<{ usage?: unknown }>;
  expect(projected.map((entry) => entry.usage)).toEqual([
    { ...usage, contextUsage: marker },
    { ...usage, contextUsage: { state: "unavailable" } },
    usage,
    usage,
    usage,
    { ...usage, contextUsage: { state: "available", promptTokens: 0, totalTokens: 0 } },
  ]);
});

describe("transcript display metadata", () => {
  it("keeps display identity while omitting upstream prompt metadata", () => {
    const metadata = { id: "message-1", mirrorIdentity: "turn-1:prompt", replyToId: "message-0" };
    const message = userRow("Visible", {
      ...metadata,
      upstreamUserText: "private decorated prompt ".repeat(12_000),
      sessionSendDelivery: Object.freeze({ source: "private-session" }),
      chatInputRecovery: Object.freeze({ source: "private-operator-snapshot" }),
    });
    expect(
      projectStable([
        {
          ...message,
          providerReplay: {
            type: "openai-responses-compaction",
            data: "opaque-display-compaction",
          },
        },
      ]),
    ).toEqual([userRow("Visible", metadata)]);
  });

  it.each([
    {
      content: [text("block text ".repeat(20))],
      metadata: { id: "message-9", senderId: "assistant-1" },
      expected: [text("block text block\n...(truncated)...")],
      reason: "display-cap",
    },
    {
      content: "still long enough to cap ".repeat(4),
      metadata: { truncated: true, reason: "oversized" },
      expected: "still long enoug\n...(truncated)...",
      reason: "oversized",
    },
  ])(
    "caps text while retaining metadata and its $reason reason",
    ({ content, metadata, expected, reason }) => {
      expectSanitized(
        assistant(content, { __openclaw: metadata }),
        assistant(expected, { __openclaw: { ...metadata, truncated: true, reason } }),
        16,
      );
    },
  );

  it.each([
    { changed: true, diff: "+line\n".repeat(40) },
    { cwd: "/workspace/".repeat(40), diff: "+short" },
  ])("marks capped details on standalone and nested tool results (%j)", (details) => {
    const result = toolResult("edit", { details });
    for (const projected of sanitizeChatHistoryMessages(toolRows(result), 32)) {
      expect(JSON.stringify(projected)).toContain("...(truncated)...");
      expect(projected).toHaveProperty("__openclaw", { truncated: true, reason: "display-cap" });
    }
  });
});

const inboundId = "photo---11111111-2222-3333-4444-555555555555.png";
it.each([
  [
    path.join(getMediaDir(), "inbound", inboundId),
    { path: "media://inbound/" + inboundId, contentType: "image/png" },
  ],
  [path.join("/tmp", "media", "inbound", inboundId), { contentType: "image/png" }],
  [path.join(getMediaDir(), "inbound", "%"), { contentType: "image/png" }],
])("projects only a valid managed inbound path: %s", (mediaPath, expected) => {
  expectSanitized(
    userRow("image", { media: [{ path: mediaPath, contentType: "image/png" }] }),
    userRow("image", { media: [expected] }),
  );
});

it("refreshes cached profile aliases without rewriting non-profile or unresolved senders", () => {
  const profile = (id: string, fields: Record<string, unknown> = {}) =>
    userRow(id, { senderIdentity: { type: "profile", id }, senderId: id, ...fields });
  const messages = [
    profile("ada", {
      senderName: "Historical Ada",
      senderUsername: "ada",
      senderProfileAvatarUrl: "/old/avatar",
    }),
    profile("ada", { senderName: "Earlier Ada" }),
    userRow("same label", {
      senderId: "ada",
      senderIdentity: {
        type: "observation",
        id: "ada",
        pluginId: "channel",
        accountId: null,
        senderKind: "unknown",
      },
    }),
    userRow("same label", { senderId: "ada" }),
    profile("missing", { senderProfileAvatarUrl: "/existing/avatar" }),
    { role: "user", content: "missing sender" },
    assistant("hostile", { __openclaw: { senderId: "hostile-assistant" } }),
    {
      role: "toolResult",
      toolCallId: "hostile",
      toolName: "read",
      content: "hostile",
      __openclaw: { senderId: "hostile-tool" },
    },
  ];
  const resolveCurrentUserProfileDisplay = vi.fn((id: string) =>
    id === "missing"
      ? { kind: "unresolved" as const }
      : {
          kind: "resolved" as const,
          profileId: "canonical-id",
          avatarUrl: "/api/users/canonical-id/avatar?v=20",
          hasUploadedAvatar: false,
        },
  );
  const projected = projectStable(messages, { resolveCurrentUserProfileDisplay });
  for (const [index, message] of messages.slice(0, 2).entries()) {
    expect(projected[index]).toMatchObject({
      __openclaw: {
        ...message["__openclaw"],
        senderIdentity: { type: "profile", id: "canonical-id" },
        senderProfileAvatarUrl: "/api/users/canonical-id/avatar?v=20",
      },
    });
  }
  expect(projected.slice(2)).toEqual(messages.slice(2));
});

it("matches later audio against text left by an earlier supplement", () => {
  const marker = { textSha256: createHash("sha256").update("same").digest("hex") };
  const firstAudio = { type: "audio", url: "https://example.test/first.mp3" };
  const secondAudio = { type: "audio", url: "https://example.test/second.mp3" };
  const caption = { type: "input_text", text: "caption" };
  const reply = (timestamp: number) => assistant([text("same")], { timestamp });
  const messages = [
    reply(1),
    reply(2),
    assistant([caption, firstAudio], { openclawTtsSupplement: marker }),
    assistant([secondAudio], { openclawTtsSupplement: marker }),
  ];
  expect(projectStable(messages)).toEqual([
    { ...reply(1), content: [text("same"), secondAudio] },
    { ...reply(2), content: [text("same"), caption, firstAudio] },
  ]);
});

it.each(["next-renderable", "last-renderable", "last-assistant"] as const)(
  "preserves first-accepted previews and original messages on the %s target",
  (placement) => {
    const baseContent = [
      text("Canvas results"),
      { type: "canvas", preview: { viewId: "existing", url: "/existing" } },
      { type: "canvas", preview: { viewId: "", url: "" } },
      ...(placement === "last-assistant" ? [{ type: "toolCall", name: "canvas" }] : []),
    ];
    Object.freeze(baseContent);
    const target = Object.freeze(assistant(baseContent, { timestamp: 42 }));
    const toolAssistant = assistant([{ type: "toolCall", name: "canvas" }], {});
    const tools = [
      ["existing", "/rejected-id-url"],
      ["first", "/rejected-id-url"],
      ["first", "/later-url"],
      ["second", "/later-url"],
      ["url-duplicate", "/existing"],
      [undefined, "/url-only"],
      [undefined, "/url-only"],
    ].map(([id, url]) => ({
      role: "toolResult",
      toolName: "canvas",
      content: JSON.stringify({ kind: "canvas", view: { ...(id ? { id } : {}), url } }),
    }));
    const detailTool = {
      role: "toolResult",
      toolName: "demo__show",
      content: "Keep the original tool result",
      details: {
        mcpAppPreview: { kind: "canvas", view: { id: "app" }, mcpApp: { viewId: "app" } },
      },
    };
    const pending = [...tools, detailTool];
    const messages =
      placement === "next-renderable"
        ? [...pending, toolAssistant, target]
        : placement === "last-renderable"
          ? [target, toolAssistant, ...pending]
          : [target, ...pending];
    Object.freeze(messages);
    const original = JSON.stringify(messages);
    const targetIndex = placement === "next-renderable" ? messages.length - 1 : 0;
    const augmented = augmentChatHistoryWithCanvasBlocks(messages);
    expect(augmented).toHaveLength(messages.length);
    expect(augmented[targetIndex]).toMatchObject({
      content: [
        ...baseContent,
        { type: "canvas", preview: { viewId: "first", url: "/rejected-id-url" } },
        { type: "canvas", preview: { viewId: "second", url: "/later-url" } },
        { type: "canvas", preview: { url: "/url-only" } },
        { type: "canvas", preview: { viewId: "app", mcpApp: { viewId: "app" } } },
      ],
    });
    for (const [index, message] of messages.entries()) {
      if (index !== targetIndex) {
        expect(augmented[index]).toEqual(message);
      }
    }
    expect(JSON.stringify(messages)).toBe(original);
  },
);

const hostTab = { targetId: "tab-1", target: "host", profile: "work" };
const nodeTab = { ...hostTab, target: "node", node: "node-1" };
const boundedTab = {
  targetId: "x".repeat(128),
  target: "node",
  profile: "p".repeat(128),
  node: "n".repeat(256),
  url: "u".repeat(2047),
  title: "t".repeat(511),
};
it.each([
  { browserTab: { ...hostTab, url: 42, title: [], extra: "drop" }, expected: hostTab },
  {
    browserTab: {
      ...boundedTab,
      url: boundedTab.url + "😀",
      title: boundedTab.title + "😀",
      extra: "drop",
    },
    expected: boundedTab,
  },
  ...[
    { ...hostTab, target: "sandbox" },
    { ...hostTab, target: "node" },
    { ...hostTab, node: "node-1" },
    { ...nodeTab, targetId: " padded " },
    { ...nodeTab, targetId: "x".repeat(129) },
    { ...nodeTab, targetId: "" },
    { ...nodeTab, profile: "p".repeat(129) },
  ].map((browserTab) => ({ browserTab, expected: undefined })),
])(
  "preserves complete browser routes and bounded display fields (%j)",
  ({ browserTab, expected }) => {
    const block = (tab: unknown) =>
      toolResult("browser", tab ? { details: { browserTab: tab } } : {});
    expect(sanitizeChatHistoryMessages(toolRows(block(browserTab)))).toEqual(
      toolRows(block(expected)),
    );
  },
);

const execStatus = { exitCode: 7, durationMs: 12.5, cwd: "/workspace", ok: false };
it.each([
  ["exec", { ...execStatus, sessionKey: "agent:helper:main" }, {}],
  ["exec", {}, { exitCode: Number.NaN, durationMs: Infinity, sessionKey: " padded ", ok: "true" }],
  ["exec", {}, { exitCode: "0", durationMs: -Infinity, sessionKey: "s".repeat(33), ok: 1 }],
] as const)(
  "preserves valid %s status and strips malformed fields (%j, %j)",
  (toolName, valid, invalid) => {
    const result = toolResult(toolName, { content: "done", details: { ...valid, changed: true } });
    expect(
      sanitizeChatHistoryMessages(
        toolRows({ ...result, details: { ...result.details, ...invalid } }),
        32,
      ),
    ).toEqual(toolRows(result));
  },
);

it.each([{ maxChars: 32 }, { maxChars: 8_000, toolResultMaxChars: 32 }])(
  "caps nested output once, preserves literal text, and removes private media (%j)",
  (options) => {
    const output = " \n[[reply_to_current]] <tag>\r\n" + "x".repeat(20_000) + "  \n";
    const metadata = {
      id: "nested-output",
      toolOutput: { source: "execution", modelInput: "unverified" },
    };
    const result = toolResult("exec", { toolCallId: "nested-call", isError: true });
    const message = assistant(
      [
        {
          ...result,
          text: output,
          content: [text(output), { type: "image", data: "aW1hZ2U=", path: "/private/image.png" }],
        },
      ],
      { __openclaw: metadata },
    );
    expectSanitized(
      message,
      assistant(
        [
          {
            ...result,
            content: [text(output.slice(0, 32)), { type: "image", omitted: true, bytes: 5 }],
          },
        ],
        { __openclaw: { ...metadata, truncated: true, reason: "display-cap" } },
      ),
      options.maxChars,
      options,
    );
  },
);

it("retains complete structured tool previews and tool arguments under a smaller text cap", () => {
  const payload = JSON.stringify({ view: { title: "x".repeat(3_000) } });
  const call = { type: "toolCall", id: "structured", name: "exec", arguments: { input: payload } };
  const readText = vi.fn(() => payload);
  const output = Object.defineProperty(text(payload), "text", { get: readText });
  const result = { type: "toolResult", toolCallId: "structured", content: [output] };
  const messages = [
    { role: "toolResult", content: result.content },
    { role: "assistant", content: [call, result] },
  ];
  const projected = sanitizeChatHistoryMessages(messages, 8_000, { toolResultMaxChars: 2_000 });
  expect(readText).toHaveBeenCalledTimes(2);
  expect(projected).toEqual(messages);
});

const user = userRow("hello", { seq: 1 });
const failed = assistant([], {
  stopReason: "error",
  errorMessage: "model unavailable",
  __openclaw: { id: "failed", seq: 2, runId: "run-a" },
});
const tool = { type: "toolCall", id: "partial-call", name: "read", arguments: {} };
const answer = assistant([text("Recovered answer")], {
  stopReason: "stop",
  __openclaw: { id: "answer", seq: 3, runId: "run-a" },
});
const terminal = (runId = "run-a") => ({
  role: "custom",
  customType: "run-failed-before-reply",
  content: "Recovery exhausted.",
  details: { runId },
  __openclaw: { id: "terminal-" + runId, seq: 10, runId },
});
const projectedIds = (messages: unknown[]) =>
  projectChatDisplayMessages(messages).map((message) => message["__openclaw"]);

it.each(["length", "stop"])("hides empty %s attempts", (stopReason) => {
  const empty = assistant([text("")], { stopReason, __openclaw: { runId: "run-empty" } });
  const thinking = { ...empty, content: [text(""), { type: "thinking", thinking: "" }] };
  const toolMessage = assistant([tool], { stopReason });
  expect(projectStable([user, empty, thinking, toolMessage, answer])).toEqual([
    user,
    toolMessage,
    answer,
  ]);
  expect(projectStable([empty], { assistantErrorPending: true })).toEqual([]);
});

it.each(["length", "stop"])("retains keyed commentary from a %s attempt", (stopReason) => {
  const commentary = assistant([phasedText("Running it now.", "commentary")], { stopReason });
  const options = { includeCommentaryFallbacks: true };
  const projected = projectStable([user, commentary, terminal()], options);
  expect(projected).toHaveLength(3);
  expect(projected[1]).toMatchObject({
    content: [text("Running it now.")],
    openclawStreamFallback: { source: "segment", itemId: "commentary" },
  });
  expect(readRunFailureNotice(projected[2])).toEqual({
    runId: "run-a",
    summary: "Recovery exhausted.",
  });
  expect(projectStable([commentary])).toEqual([]);
  expect(projectStable([{ ...commentary, display: false }], options)).toEqual([]);
  expect(projectChatDisplayMessage({ ...commentary, display: false }, options)).toBeUndefined();
  expect(
    projectStable([assistant([phasedText("", "commentary")], { stopReason })], options),
  ).toEqual([]);
});

it.each([
  ["length", undefined],
  ["length", false],
  ["length", true],
  ["stop", undefined],
  ["stop", false],
  ["stop", true],
] as const)("honors source silence before %s commentary (display=%s)", (stopReason, display) => {
  const progress = "Running it now.";
  const final = phasedText("NO_REPLY", "final_answer");
  const source = assistant([phasedText(progress, "commentary"), final], {
    stopReason,
    ...(display === undefined ? {} : { display }),
  });
  const expected =
    display === true
      ? [
          {
            role: "assistant",
            content: [text(progress)],
            openclawStreamFallback: {
              source: "segment",
              itemId: "commentary",
              replacementText: progress,
            },
          },
          { ...source, content: [final] },
        ]
      : [];
  for (const assistantErrorPending of [false, true]) {
    expect(
      projectStable([source], { includeCommentaryFallbacks: true, assistantErrorPending }),
    ).toEqual(expected);
  }
});

it("drops invisible assistant attempts without pending recovery", () => {
  const emptyAttempt = (id: string, stopReason: "length" | "stop") =>
    assistant([text(""), { type: "thinking", thinking: "" }], {
      stopReason,
      __openclaw: { id, runId: "run-empty" },
    });
  expect(
    projectStable([
      user,
      emptyAttempt("empty-primary", "length"),
      emptyAttempt("empty-fallback", "stop"),
      assistant([text("model-only")], { stopReason: "stop", openclawDisplayContent: [] }),
    ]),
  ).toEqual([user]);
});

it.each([false, true])(
  "retains completed material without settling pending recovery (earlier page=%s)",
  (assistantErrorPending) => {
    const reasoning = assistant([{ type: "thinking", thinking: "Compare the evidence." }], {
      stopReason: "stop",
      __openclaw: { id: "reasoning", runId: "run-a" },
    });
    const progress = "Checking the evidence.";
    const commentary = assistant([phasedText(progress, "commentary")], {
      stopReason: "length",
      __openclaw: { id: "commentary", runId: "run-a" },
    });
    const input = [
      ...(assistantErrorPending ? [] : [failed]),
      reasoning,
      commentary,
      ...["stop", "length"].map((stopReason) =>
        assistant([text(" "), { type: "thinking", thinking: "" }], { stopReason }),
      ),
    ];
    const original = structuredClone(input);
    const projected = projectChatDisplayMessagesWithState(input, {
      assistantErrorPending,
      includeCommentaryFallbacks: true,
    });
    expect(projected).toMatchObject({
      messages: [
        reasoning,
        {
          content: [text(progress)],
          __openclaw: commentary["__openclaw"],
          openclawStreamFallback: { source: "segment", itemId: "commentary" },
        },
      ],
      assistantErrorPending: true,
      assistantErrorRecoveryObserved: false,
    });
    expect(projectChatDisplayMessages(projected.messages)).toEqual(projected.messages);
    expect(input).toEqual(original);
  },
);

const legacyGuidance = "The provider stopped this request as a safety precaution (misalignment).";
it.each([
  [{ errorCode: "misalignment_policy_violation" }, legacyGuidance],
  [
    { diagnostics: [{ type: "provider_refusal", details: { category: "misalignment" } }] },
    "Chat stopped as a precaution. Review the findings in chat before continuing.",
  ],
] as const)("preserves guidance with empty and partial replies (%j)", (error, expected) => {
  for (const content of [[], [text("Partial reply")]]) {
    const message = {
      ...failed,
      __openclaw: { id: "legacy", seq: 2 },
      ...error,
      content,
      errorMessage: "PRIVATE_PROVIDER_DETAIL",
      errorBody: '{"misalignment":{"detailed_explanation":"PRIVATE_FINDINGS ... [truncated]',
    };
    const messages = projectStable([user, message]);
    expect(messages.at(-1)).toMatchObject({
      stopReason: "error",
      content: [text([expected, ...content.map((part) => part.text)].join("\n\n"))],
    });
    expect(JSON.stringify(messages)).not.toContain("PRIVATE_");
  }
});

it.each([
  { content: [tool] },
  { content: [phasedText("PRIVATE_COMMENTARY", "commentary")] },
  { content: [phasedText("Partial reply ".repeat(700), "final_answer")] },
  { content: "Partial reply" },
  { content: [], text: "Partial reply" },
])("retains safe incomplete-tool guidance (%j)", (partial) => {
  const message = {
    ...failed,
    ...partial,
    __openclaw: { id: "legacy", seq: 2 },
    errorCode: "incomplete_tool_call",
    errorMessage: "PRIVATE_PROVIDER_DETAIL",
  };
  const messages = projectStable([user, message]);
  expect(messages.at(-1)).toHaveProperty("stopReason", "error");
  const serialized = JSON.stringify(messages);
  expect(serialized).toContain(
    "Some actions may have completed; check their results before continuing.",
  );
  expect(serialized).not.toContain("PRIVATE_PROVIDER_DETAIL");
  expect(serialized).not.toContain("PRIVATE_COMMENTARY");
  expect(serialized.split("The task couldn't finish.")).toHaveLength(2);
  if (JSON.stringify(partial).includes("Partial reply")) {
    expect(serialized).toContain("Partial reply");
  }
  if (JSON.stringify(partial).includes("partial-call")) {
    expect(serialized).toContain("partial-call");
  }
});

it("shows one settled notice while preserving each attempt's partial output", () => {
  const partial = { ...failed, text: "", content: [text("The first step completed.")] };
  const empty = { ...failed, __openclaw: { id: "failed-again", seq: 3, runId: "run-a" } };
  const receipt = {
    role: "custom",
    customType: "run-failed-before-reply",
    content: "The request failed after retries.",
    details: { runId: "run-a", error: "PRIVATE_PROVIDER_ERROR" },
    __openclaw: { id: "receipt", seq: 4 },
  };
  const raw = [user, partial, empty, receipt];
  const projected = projectStable(raw);
  expect(projected.map(readRunFailureNotice).filter(Boolean)).toEqual([
    { runId: "run-a", summary: "The request failed after retries." },
  ]);
  expect(projected.filter((message) => message.role === "assistant")).toEqual([
    { ...partial, stopReason: undefined, errorMessage: undefined },
  ]);
  expect(projected.at(-1)).toMatchObject({ role: "custom", content: receipt.content });
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_PROVIDER_ERROR");
});

it.each([
  { content: [{ type: "image", url: "/media/proof.png", mimeType: "image/png" }] },
  { content: [tool] },
])("keeps structured partial output separate from its final notice: %j", ({ content }) => {
  const projected = projectChatDisplayMessages([{ ...failed, content }, terminal()]);
  expect(projected).toHaveLength(2);
  expect(projected[0]).toMatchObject({ role: "assistant", content });
  expect(projected[0]).not.toHaveProperty("openclawRunError");
  expect(projected[0]).not.toHaveProperty("stopReason");
  expect(readRunFailureNotice(projected[1])?.runId).toBe("run-a");
  let state = createSessionProjection({ sessionKey: "agent:main:split" }, projected);
  for (const message of projected) {
    state = projectLiveSessionMessage(state, message);
  }
  expect(state.messages).toEqual(projected);
});

it("retires repeated non-visible failed attempts after their run answers", () => {
  const failures = Array.from({ length: 4 }, (_, attempt) => ({
    ...failed,
    content: [{ type: "input_text", text: STREAM_ERROR_FALLBACK_TEXT }],
    __openclaw: { ...failed["__openclaw"], id: "attempt-" + attempt, seq: attempt + 2 },
  }));
  const final = { ...answer, __openclaw: { ...answer["__openclaw"], seq: 6 } };
  const raw = [user, ...failures, final];
  expect(projectStable(raw)).toEqual([user, final]);
});

it.each([false, true])(
  "keeps same-run recovery across hidden internal continuations (overflow=%s)",
  (overflow) => {
    const failure = overflow
      ? {
          ...failed,
          content: [
            text(
              "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.",
            ),
          ],
        }
      : failed;
    const continuation = {
      role: "user",
      content: "Continue from the current transcript.",
      provenance: { kind: "internal_system" },
      display: false,
    };
    const raw = [user, failure, continuation, answer];
    expect(projectStable(raw)).toEqual([user, answer]);
    expect(
      projectedIds([
        user,
        failure,
        continuation,
        { ...answer, __openclaw: { ...answer["__openclaw"], runId: "other" } },
      ]),
    ).not.toContainEqual(failed["__openclaw"]);
  },
);

it("repairs only matching attempts when run identities interleave", () => {
  const other = terminal("run-b");
  expect(projectedIds([user, failed, other, answer])).toEqual([
    user["__openclaw"],
    other["__openclaw"],
    answer["__openclaw"],
  ]);
});

it("retains safe failure guidance alongside partial output", () => {
  const projected = projectChatDisplayMessage(
    assistant([text("The first step completed.")], {
      stopReason: "error",
      errorMessage: "429: PRIVATE_CANARY",
      errorBody: "PRIVATE_BODY",
    }),
  );
  expect(projected).toMatchObject({
    content: [
      text(
        "⚠️ The AI service needs a short break. Please try again in a few minutes.\n\nThe first step completed.",
      ),
    ],
  });
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_");
  expect(projected).not.toHaveProperty("errorBody");
  expect(projectChatDisplayMessage(projected)).toEqual(projected);
});
