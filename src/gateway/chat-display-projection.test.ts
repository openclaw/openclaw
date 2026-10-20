import { createHash } from "node:crypto";
import path from "node:path";
import { STREAM_ERROR_FALLBACK_TEXT } from "@openclaw/ai/internal/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createSessionProjection,
  projectLiveSessionMessage,
} from "../../packages/gateway-client/src/session-projection.js";
import { getMediaDir } from "../media/store.js";
import { readRunFailureNotice } from "../shared/run-failure-notice.js";
import { augmentChatHistoryWithCanvasBlocks } from "./chat-display-projection.canvas.js";
import { createPreSessionStartAnnouncePairFilter } from "./chat-display-projection.history.js";
import {
  projectChatDisplayMessage,
  projectChatDisplayMessages,
} from "./chat-display-projection.js";
import { sanitizeChatHistoryMessages } from "./chat-display-projection.sanitize.js";
import { SessionHistorySseState } from "./session-history-state.js";

const text = (value: string) => ({ type: "text", text: value });
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
  expect(sanitizeChatHistoryMessages([input], maxChars, options)).toEqual([expected]);
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
  expect(projectChatDisplayMessages([message])).toEqual([
    {
      ...message,
      content: [{ ...call, arguments: publicInput, input: publicInput }, publicCall],
    },
  ]);
  expect(args.message).toBe("PRIVATE_YIELD_CONTEXT");
});

it("strips attachment capabilities even after another field changed", () => {
  const attachment = {
    artifactId: "artifact_managed_media_11111111-1111-4111-8111-111111111111",
    kind: "document",
    label: "report.csv",
    mimeType: "text/csv",
    sizeBytes: 12,
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
      projectChatDisplayMessages([
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

describe("current user profile display", () => {
  const resolved = (id: string, hasUploadedAvatar = true) => ({
    kind: "resolved" as const,
    profileId: id,
    avatarUrl: "/api/users/" + id + "/avatar?v=20",
    hasUploadedAvatar,
  });
  const profile = (id: string, fields: Record<string, unknown> = {}) =>
    userRow(id, { senderIdentity: { type: "profile", id }, senderId: id, ...fields });

  it("gates alias lookup on profile provenance", () => {
    const rows = [
      { type: "profile", id: "shared-id" },
      {
        type: "observation",
        id: "shared-id",
        pluginId: "channel",
        accountId: null,
        senderKind: "unknown",
      },
      undefined,
    ].map((senderIdentity) =>
      userRow("same label", {
        senderId: "shared-id",
        ...(senderIdentity ? { senderIdentity } : {}),
      }),
    );
    const resolveCurrentUserProfileDisplay = vi.fn(() => resolved("canonical-id"));
    const projected = projectStable(rows, { resolveCurrentUserProfileDisplay });
    expect(resolveCurrentUserProfileDisplay).toHaveBeenCalledTimes(1);
    expect(projected[0]?.["__openclaw"]).toEqual({
      senderId: "shared-id",
      senderIdentity: { type: "profile", id: "canonical-id" },
      senderProfileAvatarUrl: "/api/users/canonical-id/avatar?v=20",
    });
    expect(projected.slice(1)).toEqual(rows.slice(1));
  });

  it("caches profile lookups, refreshes stale avatars, and preserves unresolved rows", () => {
    const messages = [
      profile("ada", {
        senderName: "Historical Ada",
        senderUsername: "ada",
        senderProfileAvatarUrl: "/old/avatar",
      }),
      profile("ada", { senderName: "Earlier Ada" }),
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
      id === "missing" ? { kind: "unresolved" as const } : resolved(id, false),
    );
    const projected = projectStable(messages, { resolveCurrentUserProfileDisplay });
    expect(resolveCurrentUserProfileDisplay.mock.calls).toEqual([["ada"], ["missing"]]);
    expect(projected).toEqual(
      messages.map((message, index) =>
        index < 2
          ? {
              ...message,
              __openclaw: {
                ...message["__openclaw"],
                senderProfileAvatarUrl: "/api/users/ada/avatar?v=20",
              },
            }
          : message,
      ),
    );
    expect(projected[0]).not.toBe(messages[0]);
    for (const index of [2, 3, 4]) {
      expect(projected[index]).toBe(messages[index]);
    }
  });
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
    const canvas = (preview: Record<string, unknown>, rawText: string | null | undefined) => ({
      type: "canvas",
      preview: { kind: "canvas", surface: "assistant_message", render: "url", ...preview },
      rawText,
    });
    const accepted = [
      { index: 1, viewId: "first", url: "/rejected-id-url" },
      { index: 3, viewId: "second", url: "/later-url" },
      { index: 5, url: "/url-only" },
    ].map(({ index, ...preview }) => canvas(preview, tools[index]?.content));
    const expectedContent = [
      ...baseContent,
      ...accepted,
      canvas({ viewId: "app", mcpApp: { viewId: "app" } }, null),
    ];

    const augmented = augmentChatHistoryWithCanvasBlocks(messages);

    expect(augmented).toEqual(
      messages.map((message, index) =>
        index === targetIndex ? { ...target, content: expectedContent } : message,
      ),
    );
    expect(augmented[targetIndex]).not.toBe(target);
    for (const [index, message] of messages.entries()) {
      if (index !== targetIndex) {
        expect(augmented[index]).toBe(message);
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

it.each([
  ["exec", { exitCode: 7, durationMs: 12.5, cwd: "/workspace", ok: false }, {}],
  ["sessions_spawn", { ok: true, sessionKey: "agent:helper:main" }, {}],
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
    const original = structuredClone(message);
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
    expect(message).toEqual(original);
  },
);

it("retains complete structured tool previews and tool arguments under a smaller text cap", () => {
  const payload = JSON.stringify({
    kind: "canvas",
    view: { id: "preview", title: "x".repeat(3_000) },
  });
  const call = { type: "toolCall", id: "structured", name: "exec", arguments: { input: payload } };
  const result = {
    type: "toolResult",
    toolCallId: "structured",
    content: [text(payload)],
  };
  const messages = [
    { role: "toolResult", content: result.content },
    { role: "assistant", content: [call, result] },
  ];
  expect(sanitizeChatHistoryMessages(messages, 8_000, { toolResultMaxChars: 2_000 })).toEqual(
    messages,
  );
});

const user = { role: "user", content: "hello", __openclaw: { seq: 1 } };
const failed = {
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage: "model unavailable",
  __openclaw: { id: "failed", seq: 2, runId: "run-a" },
};
const tool = { type: "toolCall", id: "partial-call", name: "read", arguments: {} };
const answer = {
  role: "assistant",
  content: [text("Recovered answer")],
  stopReason: "stop",
  __openclaw: { id: "answer", seq: 3, runId: "run-a" },
};
const terminal = (runId = "run-a") => ({
  role: "custom",
  customType: "run-failed-before-reply",
  content: "Recovery exhausted.",
  details: { runId },
  __openclaw: { id: "terminal-" + runId, seq: 10, runId },
});
const projectedIds = (messages: unknown[]) =>
  projectChatDisplayMessages(messages).map((message) => message["__openclaw"]);

const legacyGuidance = "The provider stopped this request as a safety precaution (misalignment).";
it.each([
  [
    { errorCode: "misalignment_policy_violation", errorType: "invalid_request_error" },
    legacyGuidance,
  ],
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
  expect(messages.at(-1)).toMatchObject({
    stopReason: "error",
    content: expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining(
          "⚠️ The task couldn't finish. Some actions may have completed; check their results before continuing.",
        ),
      }),
    ]),
  });
  const serialized = JSON.stringify(messages);
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

it("refreshes SSE history after an appended failure recovers", async () => {
  const state = SessionHistorySseState.fromSnapshot({
    target: { sessionId: "session", sessionKey: "agent:main:test" },
    snapshot: {
      history: { items: [user], messages: [user], hasMore: false },
      rawTranscriptSeq: 1,
      turnBoundaryPending: false,
      assistantErrorPending: false,
    },
  });
  expect(
    (await state.prepareInlineMessage({ message: failed, messageSeq: 2 }))()?.message,
  ).toBeUndefined();
  expect((await state.prepareInlineMessage({ message: answer, messageSeq: 3 }))()).toEqual({
    shouldRefresh: true,
  });
});

it("drops only old announce pairs across adjacent chunks", () => {
  const announce = {
    role: "user",
    timestamp: 10,
    content: "Earlier child finished",
    provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
  };
  const oldReply = { role: "assistant", timestamp: 11, content: "Acknowledged" };
  const newReply = { ...oldReply, timestamp: 30 };
  const rows = [announce, oldReply, announce, newReply, user];
  for (let split = 1; split < rows.length; split++) {
    const filter = createPreSessionStartAnnouncePairFilter(20);
    expect([...filter(rows.slice(0, split)), ...filter(rows.slice(split))]).toEqual([
      newReply,
      user,
    ]);
  }
});

const schemaError = "Invalid service_tier argument";
it.each([
  [
    schemaError,
    {
      errorType: "invalid_request_error",
      errorBody: JSON.stringify({
        error: { type: "invalid_request_error", message: schemaError },
        request: { input: "PRIVATE_PROMPT", headers: { authorization: "PRIVATE_AUTH" } },
      }),
    },
    String.raw`LLM request rejected: Invalid service\_tier argument`,
  ],
  [
    "429: PRIVATE_CANARY",
    { content: [text("The first step completed.")] },
    "⚠️ The AI service needs a short break. Please try again in a few minutes.\n\nThe first step completed.",
  ],
] as const)("retains safe failure guidance for %s", (errorMessage, fields, expected) => {
  const projected = projectChatDisplayMessage(
    assistant([], { stopReason: "error", errorMessage, ...fields }),
  );
  expect(projected).toMatchObject({ content: [text(expected)] });
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_");
  expect(projected).not.toHaveProperty("errorBody");
  expect(projectChatDisplayMessage(projected)).toEqual(projected);
});
