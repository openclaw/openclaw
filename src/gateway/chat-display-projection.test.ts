import { createHash } from "node:crypto";
import path from "node:path";
import { STREAM_ERROR_FALLBACK_TEXT } from "@openclaw/ai/internal/shared";
import { describe, expect, it, vi } from "vitest";
import { getMediaDir } from "../media/store.js";
import { augmentChatHistoryWithCanvasBlocks } from "./chat-display-projection.canvas.js";
import { createPreSessionStartAnnouncePairFilter } from "./chat-display-projection.history.js";
import {
  projectChatDisplayMessage,
  projectChatDisplayMessages,
} from "./chat-display-projection.js";
import { sanitizeChatHistoryMessages } from "./chat-display-projection.sanitize.js";
import { SessionHistorySseState } from "./session-history-state.js";

it("hides private yield inputs without changing canonical arguments", () => {
  const publicInput = { acknowledgment: "Waiting." };
  const args = Object.freeze({ ...publicInput, message: "PRIVATE_YIELD_CONTEXT" });
  const call = { type: "toolCall", name: "sessions_yield", arguments: args, input: args };
  const publicCall = { type: "toolCall", name: "message", arguments: { message: "Public reply" } };
  const message = { role: "assistant", content: [call, publicCall] };
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
  expect(
    sanitizeChatHistoryMessages([
      {
        role: "assistant",
        content: [
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
      },
    ]),
  ).toEqual([{ role: "assistant", content: [{ type: "attachment", attachment }] }]);
});

describe("transcript display metadata", () => {
  it("keeps display identity while omitting upstream prompt metadata", () => {
    const metadata = { id: "message-1", mirrorIdentity: "turn-1:prompt", replyToId: "message-0" };
    expect(
      projectChatDisplayMessages([
        {
          role: "user",
          content: "Visible",
          __openclaw: { ...metadata, upstreamUserText: "private decorated prompt ".repeat(12_000) },
          providerReplay: {
            type: "openai-responses-compaction",
            data: "opaque-display-compaction",
          },
        },
      ]),
    ).toEqual([{ role: "user", content: "Visible", __openclaw: metadata }]);
  });

  it.each([
    {
      content: [{ type: "text", text: "block text ".repeat(20) }],
      metadata: { id: "message-9", senderId: "assistant-1" },
      expected: [{ type: "text", text: "block text block\n...(truncated)..." }],
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
      expect(
        sanitizeChatHistoryMessages([{ role: "assistant", content, __openclaw: metadata }], 16),
      ).toEqual([
        {
          role: "assistant",
          content: expected,
          __openclaw: { ...metadata, truncated: true, reason },
        },
      ]);
    },
  );

  it.each([
    { changed: true, diff: "+line\n".repeat(40) },
    { cwd: "/workspace/".repeat(40), diff: "+short" },
  ])("marks capped details on standalone and nested tool results (%j)", (details) => {
    const result = {
      type: "toolResult",
      toolName: "edit",
      details,
    };
    for (const projected of sanitizeChatHistoryMessages(
      [
        { role: "assistant", content: [result] },
        { ...result, role: "toolResult" },
      ],
      32,
    )) {
      expect(JSON.stringify(projected)).toContain("...(truncated)...");
      expect(projected).toHaveProperty("__openclaw", { truncated: true, reason: "display-cap" });
    }
  });
});

describe("managed inbound media facts", () => {
  const id = "photo---11111111-2222-3333-4444-555555555555.png";
  it.each([
    [
      path.join(getMediaDir(), "inbound", id),
      { path: "media://inbound/" + id, contentType: "image/png" },
    ],
    [path.join("/tmp", "media", "inbound", id), { contentType: "image/png" }],
    [path.join(getMediaDir(), "inbound", "%"), { contentType: "image/png" }],
  ])("projects only a valid managed inbound path: %s", (mediaPath, expected) => {
    expect(
      sanitizeChatHistoryMessages([
        {
          role: "user",
          content: "image",
          __openclaw: { media: [{ path: mediaPath, contentType: "image/png" }] },
        },
      ]),
    ).toEqual([{ role: "user", content: "image", __openclaw: { media: [expected] } }]);
  });
});

describe("current user profile display", () => {
  const resolved = (id: string, hasUploadedAvatar = true) => ({
    kind: "resolved" as const,
    profileId: id,
    avatarUrl: "/api/users/" + id + "/avatar?v=20",
    hasUploadedAvatar,
  });
  const profile = (id: string, fields: Record<string, unknown> = {}) => ({
    role: "user",
    content: id,
    __openclaw: { senderIdentity: { type: "profile", id }, senderId: id, ...fields },
  });

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
    ].map((senderIdentity) => ({
      role: "user",
      content: "same label",
      __openclaw: { senderId: "shared-id", ...(senderIdentity ? { senderIdentity } : {}) },
    }));
    const original = structuredClone(rows);
    const resolveCurrentUserProfileDisplay = vi.fn(() => resolved("canonical-id"));
    const projected = projectChatDisplayMessages(rows, { resolveCurrentUserProfileDisplay });
    expect(resolveCurrentUserProfileDisplay).toHaveBeenCalledTimes(1);
    expect(projected[0]?.["__openclaw"]).toEqual({
      senderId: "shared-id",
      senderIdentity: { type: "profile", id: "canonical-id" },
      senderProfileAvatarUrl: "/api/users/canonical-id/avatar?v=20",
    });
    expect(projected.slice(1)).toEqual(rows.slice(1));
    expect(rows).toEqual(original);
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
      { role: "assistant", content: "hostile", __openclaw: { senderId: "hostile-assistant" } },
      {
        role: "toolResult",
        toolCallId: "hostile",
        toolName: "read",
        content: "hostile",
        __openclaw: { senderId: "hostile-tool" },
      },
    ];
    const original = structuredClone(messages);
    const resolveCurrentUserProfileDisplay = vi.fn((id: string) =>
      id === "missing" ? { kind: "unresolved" as const } : resolved(id, false),
    );
    const projected = projectChatDisplayMessages(messages, { resolveCurrentUserProfileDisplay });
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
    expect(messages).toEqual(original);
  });
});

it("matches later audio against text left by an earlier supplement", () => {
  const marker = { textSha256: createHash("sha256").update("same").digest("hex") };
  const firstAudio = { type: "audio", url: "https://example.test/first.mp3" };
  const secondAudio = { type: "audio", url: "https://example.test/second.mp3" };
  const caption = { type: "input_text", text: "caption" };
  const reply = (timestamp: number) => ({
    role: "assistant",
    content: [{ type: "text", text: "same" }],
    timestamp,
  });
  const messages = [
    reply(1),
    reply(2),
    { role: "assistant", content: [caption, firstAudio], openclawTtsSupplement: marker },
    { role: "assistant", content: [secondAudio], openclawTtsSupplement: marker },
  ];
  const original = structuredClone(messages);
  expect(projectChatDisplayMessages(messages)).toEqual([
    { ...reply(1), content: [{ type: "text", text: "same" }, secondAudio] },
    { ...reply(2), content: [{ type: "text", text: "same" }, caption, firstAudio] },
  ]);
  expect(messages).toEqual(original);
});

it.each(["next-renderable", "last-renderable", "last-assistant"] as const)(
  "preserves first-accepted previews and original messages on the %s target",
  (placement) => {
    const baseContent = [
      { type: "text", text: "Canvas results" },
      { type: "canvas", preview: { viewId: "existing", url: "/existing" } },
      { type: "canvas", preview: { viewId: "", url: "" } },
      ...(placement === "last-assistant" ? [{ type: "toolCall", name: "canvas" }] : []),
    ];
    Object.freeze(baseContent);
    const target = Object.freeze({ role: "assistant", content: baseContent, timestamp: 42 });
    const toolAssistant = { role: "assistant", content: [{ type: "toolCall", name: "canvas" }] };
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
        mcpAppPreview: {
          kind: "canvas",
          view: { id: "app" },
          mcpApp: { viewId: "app" },
        },
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
it.each([
  { browserTab: { ...hostTab, url: 42, title: [], extra: "drop" }, expected: hostTab },
  {
    browserTab: {
      targetId: "x".repeat(128),
      target: "node",
      profile: "p".repeat(128),
      node: "n".repeat(256),
      url: "u".repeat(2047) + "😀",
      title: "t".repeat(511) + "😀",
      extra: "drop",
    },
    expected: {
      targetId: "x".repeat(128),
      target: "node",
      profile: "p".repeat(128),
      node: "n".repeat(256),
      url: "u".repeat(2047),
      title: "t".repeat(511),
    },
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
    const block = (tab: unknown) => ({
      type: "toolResult",
      toolName: "browser",
      ...(tab ? { details: { browserTab: tab } } : {}),
    });
    expect(
      sanitizeChatHistoryMessages([
        { role: "toolResult", ...block(browserTab) },
        { role: "assistant", content: [block(browserTab)] },
      ]),
    ).toEqual([
      { role: "toolResult", ...block(expected) },
      { role: "assistant", content: [block(expected)] },
    ]);
  },
);

it.each([
  { toolName: "exec", details: { exitCode: 7, durationMs: 12.5, cwd: "/workspace", ok: false } },
  { toolName: "sessions_spawn", details: { ok: true, sessionKey: "agent:helper:main" } },
])("retains $toolName status in standalone and nested history", ({ toolName, details }) => {
  const result = { type: "toolResult", toolName, content: "done", details };
  const messages = [
    { ...result, role: "toolResult" },
    { role: "assistant", content: [result] },
  ];
  expect(sanitizeChatHistoryMessages(messages)).toEqual(messages);
});

it.each([
  { exitCode: Number.NaN, durationMs: Infinity, sessionKey: " padded ", ok: "true" },
  { exitCode: "0", durationMs: -Infinity, sessionKey: "s".repeat(33), ok: 1 },
])("keeps malformed status metadata out of display history (%j)", (details) => {
  const result = { type: "toolResult", toolName: "exec", details: { changed: true } };
  expect(
    sanitizeChatHistoryMessages(
      [
        { ...result, role: "toolResult", details: { ...details, changed: true } },
        { role: "assistant", content: [{ ...result, details: { ...details, changed: true } }] },
      ],
      32,
    ),
  ).toEqual([
    { ...result, role: "toolResult" },
    { role: "assistant", content: [result] },
  ]);
});

it.each([{ maxChars: 32 }, { maxChars: 8_000, toolResultMaxChars: 32 }])(
  "caps nested output once, preserves literal text, and removes private media (%j)",
  (options) => {
    const text = " \n[[reply_to_current]] <tag>\r\n" + "x".repeat(20_000) + "  \n";
    const metadata = {
      id: "nested-output",
      toolOutput: { source: "execution", modelInput: "unverified" },
    };
    const result = {
      type: "toolResult",
      toolCallId: "nested-call",
      toolName: "exec",
      isError: true,
    };
    const message = {
      role: "assistant",
      __openclaw: metadata,
      content: [
        {
          ...result,
          text,
          content: [
            { type: "text", text },
            { type: "image", data: "aW1hZ2U=", path: "/private/image.png" },
          ],
        },
      ],
    };
    const original = structuredClone(message);
    expect(sanitizeChatHistoryMessages([message], options.maxChars, options)).toEqual([
      {
        role: "assistant",
        __openclaw: { ...metadata, truncated: true, reason: "display-cap" },
        content: [
          {
            ...result,
            content: [
              { type: "text", text: text.slice(0, 32) },
              { type: "image", omitted: true, bytes: 5 },
            ],
          },
        ],
      },
    ]);
    expect(message).toEqual(original);
  },
);

it("retains complete structured tool previews and tool arguments under a smaller text cap", () => {
  const text = JSON.stringify({
    kind: "canvas",
    view: { id: "preview", title: "x".repeat(3_000) },
  });
  const call = { type: "toolCall", id: "structured", name: "exec", arguments: { input: text } };
  const result = {
    type: "toolResult",
    toolCallId: "structured",
    content: [{ type: "text", text }],
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
const text = (value: string) => ({ type: "text", text: value });
const tool = { type: "toolCall", id: "partial-call", name: "read", arguments: {} };
const answer = {
  role: "assistant",
  content: [text("Recovered answer")],
  stopReason: "stop",
  __openclaw: { id: "answer", seq: 3, runId: "run-a" },
};
const projectedIds = (messages: unknown[]) =>
  projectChatDisplayMessages(messages).map((message) => message["__openclaw"]);

it.each([
  {
    name: "legacy structured error",
    errorCode: "misalignment_policy_violation",
    errorType: "invalid_request_error",
    expected: "The provider stopped this request as a safety precaution (misalignment).",
  },
  {
    name: "saved code only",
    errorCode: "misalignment_policy_violation",
    expected: "The provider stopped this request as a safety precaution (misalignment).",
  },
  {
    name: "current refusal diagnostic",
    diagnostics: [{ type: "provider_refusal", details: { category: "misalignment" } }],
    expected: "Chat stopped as a precaution. Review the findings in chat before continuing.",
  },
])(
  "preserves $name guidance with empty and partial replies",
  ({ name: _name, expected, ...error }) => {
    for (const content of [[], [text("Partial reply")]]) {
      const message = {
        ...failed,
        ...error,
        content,
        errorMessage: "PRIVATE_PROVIDER_DETAIL",
        errorBody: '{"misalignment":{"detailed_explanation":"PRIVATE_FINDINGS ... [truncated]',
      };
      const original = structuredClone(message);
      const messages = projectChatDisplayMessages([user, message]);
      expect(messages.at(-1)).toMatchObject({
        stopReason: "error",
        content: [text([expected, ...content.map((part) => part.text)].join("\n\n"))],
      });
      expect(JSON.stringify(messages)).not.toContain("PRIVATE_");
      expect(projectChatDisplayMessages(messages)).toEqual(messages);
      expect(message).toEqual(original);
    }
  },
);

it.each([
  { name: "structured", content: [tool] },
  {
    name: "phased commentary",
    content: [
      {
        ...text("PRIVATE_COMMENTARY"),
        textSignature: '{"v":1,"id":"commentary","phase":"commentary"}',
      },
    ],
  },
  {
    name: "over-limit phased final",
    content: [
      {
        ...text("Partial reply ".repeat(700)),
        textSignature: '{"v":1,"id":"long","phase":"final_answer"}',
      },
    ],
  },
  { name: "string content", content: "Partial reply" },
  { name: "text alias", content: [], text: "Partial reply" },
])("retains safe incomplete-tool guidance in $name history", ({ name: _name, ...partial }) => {
  const message = {
    ...failed,
    ...partial,
    errorCode: "incomplete_tool_call",
    errorMessage: "PRIVATE_PROVIDER_DETAIL",
  };
  const original = structuredClone(message);
  const messages = projectChatDisplayMessages([user, message]);
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
  expect(projectChatDisplayMessages(messages)).toEqual(messages);
  expect(message).toEqual(original);
});

it("retires repeated non-visible failed attempts after their run answers", () => {
  const failures = Array.from({ length: 4 }, (_, attempt) => ({
    ...failed,
    content: [{ type: "input_text", text: STREAM_ERROR_FALLBACK_TEXT }],
    __openclaw: { ...failed["__openclaw"], id: "attempt-" + attempt, seq: attempt + 2 },
  }));
  const final = { ...answer, __openclaw: { ...answer["__openclaw"], seq: 6 } };
  const raw = [user, ...failures, final];
  const original = structuredClone(raw);
  expect(projectChatDisplayMessages(raw)).toEqual([user, final]);
  expect(raw).toEqual(original);
});

it.each([
  { ...answer, provider: "openclaw", model: "gateway-injected" },
  { ...answer, stopReason: "toolUse" },
])("keeps the failure without a successful runtime answer: %j", (later) => {
  expect(projectedIds([user, failed, later])).toContainEqual(failed["__openclaw"]);
});

it("keeps unattributed failures and failures separated by a new user turn", () => {
  const unattributed = { ...failed, __openclaw: { id: "failed", seq: 2 } };
  expect(projectedIds([user, unattributed, answer])).toContainEqual(unattributed["__openclaw"]);
  expect(projectedIds([user, failed, { ...user, content: "next turn" }, answer])).toContainEqual(
    failed["__openclaw"],
  );
  expect(projectedIds([user, failed])).toContainEqual(failed["__openclaw"]);
});

it("preserves partial content even when the redundant text field is empty", () => {
  const partial = { ...failed, text: "", content: [text("Partial reply")] };
  expect(projectChatDisplayMessages([user, partial, answer])[1]).toMatchObject({
    content: [text("Partial reply")],
  });
});

it("repairs only matching attempts when run identities interleave", () => {
  const other = { ...failed, __openclaw: { id: "other", seq: 3, runId: "run-b" } };
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
  ).toMatchObject({
    stopReason: "error",
  });
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

const failure = (errorMessage: string, fields: Record<string, unknown> = {}) =>
  projectChatDisplayMessage({
    role: "assistant",
    stopReason: "error",
    content: [],
    errorMessage,
    ...fields,
  });

it("retains the actual schema rejection without leaking the response envelope", () => {
  const projected = failure("Invalid service_tier argument", {
    errorType: "invalid_request_error",
    errorBody: JSON.stringify({
      error: { type: "invalid_request_error", message: "Invalid service_tier argument" },
      request: { input: "PRIVATE_PROMPT", headers: { authorization: "PRIVATE_AUTH" } },
    }),
  });
  expect(projected).toMatchObject({
    content: [
      { type: "text", text: String.raw`LLM request rejected: Invalid service\_tier argument` },
    ],
  });
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_");
  expect(projected).not.toHaveProperty("errorBody");
  expect(projectChatDisplayMessage(projected)).toEqual(projected);
});

it("keeps safe failure guidance alongside partial reply text", () => {
  const projected = failure("429: PRIVATE_CANARY", {
    content: [{ type: "text", text: "The first step completed." }],
  });
  expect(projected).toMatchObject({
    content: [
      {
        type: "text",
        text: "⚠️ The AI service needs a short break. Please try again in a few minutes.\n\nThe first step completed.",
      },
    ],
  });
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_CANARY");
  expect(projectChatDisplayMessage(projected)).toEqual(projected);
});
