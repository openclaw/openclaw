import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readTranscriptEventRows } from "../config/sessions/session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { applyAssistantDeliveryDirectives } from "../config/sessions/transcript-assistant-delivery.js";
import {
  appendAssistantMirrorMessageByIdentity,
  appendSessionTranscriptMessageByIdentity,
} from "../plugin-sdk/session-transcript-runtime.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { buildSessionHistorySnapshot } from "./session-history-state.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";
import { readRecentSessionMessagesWithStatsAsync } from "./session-transcript-readers.js";

describe("assistant media directive display projection", () => {
  it.each(
    [false, true].flatMap((recovered) =>
      [[], [{ type: "thinking", thinking: "Internal reasoning" }]].map((content) => ({
        recovered,
        content,
      })),
    ),
  )(
    "preserves error-turn media (later reply=$recovered, content=$content)",
    ({ recovered, content }) => {
      const user = { role: "user", content: "hello" };
      const reply = {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "I agree with that product direction." }],
        __openclaw: { runId: "run-retry" },
      };
      const mediaReply = {
        role: "assistant",
        content,
        stopReason: "error",
        __openclaw: {
          runId: "run-retry",
          media: [{ path: "media://inbound/synthetic-image", contentType: "image/png" }],
        },
      };
      const rawMessages = [user, mediaReply, ...(recovered ? [reply] : [])];
      const expected = [user, { ...mediaReply, content: [] }, ...(recovered ? [reply] : [])];
      expect(projectChatDisplayMessages(rawMessages)).toEqual(expected);
      expect(buildSessionHistorySnapshot({ rawMessages }).history.messages).toEqual(expected);
    },
  );

  it("withholds relative MEDIA directives until managed attachment blocks replace them", () => {
    const { payload } = projectSessionMessagePayload({
      sessionKey: "agent:main:main",
      message: {
        role: "assistant",
        openclawDelivery: {
          mediaUrls: ["./attachment-catalog-tiny/demo.jpg", "./attachment-catalog-tiny/demo.mp3"],
        },
        content: [
          {
            type: "text",
            text: [
              "Prepared the batch.",
              "MEDIA:./attachment-catalog-tiny/demo.jpg",
              "MEDIA:./attachment-catalog-tiny/demo.mp3",
            ].join("\n"),
          },
        ],
      },
    });
    const message = payload?.message as { content?: Array<{ text?: string }> } | undefined;

    expect(message?.content?.[0]?.text).toBe("Prepared the batch.");
    expect(JSON.stringify(payload)).not.toContain("MEDIA:");
    expect(JSON.stringify(payload)).not.toContain("attachment-catalog-tiny");
  });

  it("keeps a media-only assistant row pending for its structured rewrite", () => {
    const { payload } = projectSessionMessagePayload({
      sessionKey: "agent:main:main",
      message: {
        role: "assistant",
        openclawDelivery: { mediaUrls: ["./attachment-catalog-tiny/demo.jpg"] },
        content: [{ type: "text", text: "MEDIA:./attachment-catalog-tiny/demo.jpg" }],
      },
    });

    expect(payload?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "" }],
    });
  });

  it("preserves fenced MEDIA examples as ordinary assistant text", () => {
    const text = ["```text", "MEDIA:./example.jpg", "```", ""].join("\n");
    const { payload } = projectSessionMessagePayload({
      sessionKey: "agent:main:main",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

    expect(payload?.message).toMatchObject({
      content: [{ type: "text", text }],
    });
  });

  it("preserves legacy remote MEDIA references for client-side attachment projection", () => {
    const text = "MEDIA:https://cdn.example.test/legacy.jpg";
    const { payload } = projectSessionMessagePayload({
      sessionKey: "agent:main:main",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

    expect(payload?.message).toMatchObject({
      content: [{ type: "text", text }],
    });
  });

  it.each(["MEDIA:chart.png", "MEDIA:./image.png"])(
    "preserves an ordinary relative reference through persistence and projection: %s",
    (text) => {
      const persisted = applyAssistantDeliveryDirectives({
        role: "assistant",
        content: [{ type: "text", text }],
      });
      const { payload } = projectSessionMessagePayload({
        sessionKey: "agent:main:main",
        message: persisted,
      });

      expect(payload?.message).toMatchObject({ content: [{ type: "text", text }] });
    },
  );

  it("withholds only relative directives from a mixed legacy batch", () => {
    const { payload } = projectSessionMessagePayload({
      sessionKey: "agent:main:main",
      message: {
        role: "assistant",
        openclawDelivery: { mediaUrls: ["./attachment-catalog-tiny/demo.jpg"] },
        content: [
          {
            type: "text",
            text: [
              "Prepared the mixed batch.",
              "MEDIA:https://cdn.example.test/legacy.jpg",
              "MEDIA:/media/legacy-audio.mp3",
              "MEDIA:./attachment-catalog-tiny/demo.jpg",
            ].join("\n"),
          },
        ],
      },
    });

    expect(payload?.message).toMatchObject({
      content: [
        {
          type: "text",
          text: [
            "Prepared the mixed batch.",
            "MEDIA:https://cdn.example.test/legacy.jpg",
            "MEDIA:/media/legacy-audio.mp3",
          ].join("\n"),
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("attachment-catalog-tiny");
  });
});

const answer = "The train leaves at noon.";
const text = [{ type: "text", text: answer }];
function assistant(fields: Record<string, unknown> = {}) {
  return { role: "assistant", content: text, __openclaw: { id: "real-answer" }, ...fields };
}
function mirror(fields: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    provider: "openclaw",
    model: "delivery-mirror",
    content: text,
    idempotencyKey: "channel-delivery-one",
    openclawDeliveryMirror: {
      kind: "channel-final",
      sourceMessageId: "channel-delivery-one",
      sourceAssistantMessageId: "real-answer",
    },
    ...fields,
  };
}

describe("correlated channel mirrors in Gateway history", () => {
  let state: OpenClawTestState;
  let scope: { agentId: string; sessionId: string; sessionKey: string; storePath: string };

  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-mirror-history-", applyEnv: false });
    scope = {
      agentId: "main",
      sessionId: "mirror-history-session",
      sessionKey: "agent:main:mirror-history",
      storePath: path.join(state.root, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await state.cleanup();
  });

  const append = (eventId: string, message: Record<string, unknown>) =>
    appendSessionTranscriptMessageByIdentity({ ...scope, eventId, message });
  const storedRows = () =>
    readTranscriptEventRows(
      openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteTranscriptReadScope(scope))),
      scope.sessionId,
    );

  it("hides only new correlated mirrors and preserves old bytes and identical distinct turns", async () => {
    await append("old-answer", {
      role: "assistant",
      timestamp: 9000,
      content: [{ type: "thinking", thinking: "Checking the old timetable." }, ...text],
    });
    await append(
      "old-mirror",
      mirror({
        timestamp: 1000,
        idempotencyKey: "old-delivery",
        openclawDeliveryMirror: { kind: "channel-final", sourceMessageId: "old-delivery" },
      }),
    );
    const oldRows = storedRows();
    await append("first-new-answer", {
      role: "assistant",
      timestamp: 8000,
      content: [
        { type: "thinking", thinking: "Checking the current timetable." },
        {
          type: "text",
          text: "I will check the departure.",
          textSignature: '{"v":1,"id":"commentary","phase":"commentary"}',
        },
        {
          type: "text",
          text: answer,
          textSignature: '{"v":1,"id":"final","phase":"final_answer"}',
        },
      ],
    });
    await appendAssistantMirrorMessageByIdentity({
      ...scope,
      idempotencyKey: "first-new-delivery",
      deliveryMirror: { kind: "channel-final", sourceMessageId: "first-new-delivery" },
      text: answer,
      updateMode: "none",
    });
    await append("second-question", {
      role: "user",
      content: "Please confirm that again.",
      timestamp: 500,
    });
    await append("second-new-answer", { role: "assistant", content: text, timestamp: 400 });
    await appendAssistantMirrorMessageByIdentity({
      ...scope,
      idempotencyKey: "second-new-delivery",
      deliveryMirror: { kind: "channel-final", sourceMessageId: "second-new-delivery" },
      text: answer,
      updateMode: "none",
    });
    const beforeRead = storedRows();

    const history = await readRecentSessionMessagesWithStatsAsync(scope, { maxMessages: 20 });
    const displayed = projectChatDisplayMessages(history.messages);

    expect(history.messages).toHaveLength(7);
    expect(displayed).toMatchObject([
      { role: "assistant", __openclaw: { id: "old-answer" } },
      { model: "delivery-mirror", __openclaw: { id: "old-mirror" } },
      { role: "assistant", __openclaw: { id: "first-new-answer" } },
      { role: "user", __openclaw: { id: "second-question" } },
      { role: "assistant", __openclaw: { id: "second-new-answer" } },
    ]);
    expect(displayed[2]).toMatchObject({
      content: [
        { type: "thinking", thinking: "Checking the current timetable." },
        { type: "text", text: answer },
      ],
    });
    expect(storedRows()).toEqual(beforeRead);
    expect(storedRows().slice(0, oldRows.length)).toEqual(oldRows);
  });
});

describe("channel mirror display controls", () => {
  it.each([
    {
      name: "different explicit source despite mirrorIdentity",
      previous: assistant({
        __openclaw: { id: "another-answer", mirrorIdentity: "existing-acp-reply" },
      }),
      current: mirror(),
    },
    {
      name: "fieldless historical mirror",
      previous: assistant({ content: [{ type: "thinking", thinking: "Reasoning." }, ...text] }),
      current: mirror({
        openclawDeliveryMirror: { kind: "channel-final", sourceMessageId: "old-delivery" },
      }),
    },
    {
      name: "different visible text",
      previous: assistant(),
      current: mirror({ content: [{ type: "text", text: "The train leaves at three." }] }),
    },
    {
      name: "another delivery mirror",
      previous: mirror({ __openclaw: { id: "real-answer" }, idempotencyKey: "earlier-delivery" }),
      current: mirror(),
    },
  ])("preserves both rows for $name", ({ previous, current }) => {
    expect(projectChatDisplayMessages([previous, current])).toHaveLength(2);
  });

  it("does not collapse across a filtered user turn", () => {
    const displayed = projectChatDisplayMessages([
      assistant(),
      { role: "user", content: "" },
      mirror(),
    ]);

    expect(displayed).toMatchObject([{ role: "assistant" }, { model: "delivery-mirror" }]);
  });

  it.each([
    { name: "tool call", block: { type: "toolCall", id: "tool-one", name: "read", arguments: {} } },
    {
      name: "document",
      block: { type: "attachment", attachment: { kind: "document", label: "timetable.pdf" } },
    },
    {
      name: "image",
      block: { type: "image", source: { type: "url", url: "https://example.test/timetable.png" } },
    },
  ])("preserves a $name in the canonical display content", ({ block }) => {
    const displayed = projectChatDisplayMessages([
      assistant({ openclawDisplayContent: [...text, block] }),
      mirror(),
    ]);

    expect(displayed).toHaveLength(2);
    expect(displayed[0]).toMatchObject({ content: expect.arrayContaining([block]) });
  });

  it("keeps a mirror that carries its own attachment", () => {
    const attachment = {
      type: "attachment",
      attachment: { kind: "document", label: "platform.pdf" },
    };

    const displayed = projectChatDisplayMessages([
      assistant(),
      mirror({ openclawDisplayContent: [...text, attachment] }),
    ]);

    expect(displayed).toHaveLength(2);
    expect(displayed[1]).toMatchObject({ content: expect.arrayContaining([attachment]) });
  });

  it.each(["assistant", "mirror"])("preserves media facts on the %s", (owner) => {
    const media = [{ path: "media://inbound/timetable", contentType: "image/png" }];
    const displayed = projectChatDisplayMessages([
      assistant({ __openclaw: { id: "real-answer", ...(owner === "assistant" ? { media } : {}) } }),
      mirror(owner === "mirror" ? { __openclaw: { media } } : {}),
    ]);

    expect(displayed).toHaveLength(2);
    expect(displayed[owner === "assistant" ? 0 : 1]).toHaveProperty("__openclaw.media");
  });

  it("keeps forwarded text and the channel delivery separate", () => {
    const displayed = projectChatDisplayMessages([
      {
        role: "user",
        content: answer,
        __openclaw: { id: "real-answer" },
        provenance: {
          kind: "inter_session",
          sourceTool: "sessions_send",
          sourceSessionKey: "agent:helper:main",
        },
      },
      mirror(),
    ]);

    expect(displayed).toMatchObject([
      { role: "assistant", senderLabel: "Forwarded from helper" },
      { model: "delivery-mirror" },
    ]);
  });

  it("merges a speech supplement into the retained real reply", () => {
    const attachment = {
      type: "attachment",
      attachment: { kind: "audio", label: "reply.mp3", mimeType: "audio/mpeg" },
    };
    const displayed = projectChatDisplayMessages([
      assistant({ content: [{ type: "thinking", thinking: "Checking the timetable." }, ...text] }),
      mirror(),
      {
        role: "assistant",
        content: [{ type: "text", text: "Audio reply" }, attachment],
        openclawTtsSupplement: { spokenText: answer },
      },
    ]);

    expect(displayed).toHaveLength(1);
    expect(displayed[0]).toMatchObject({
      __openclaw: { id: "real-answer" },
      content: expect.arrayContaining([attachment, { type: "text", text: answer }]),
    });
  });

  it("retains the existing fieldless mirrorIdentity path", () => {
    const displayed = projectChatDisplayMessages([
      assistant({ __openclaw: { mirrorIdentity: "acp-run:assistant" } }),
      mirror({
        openclawDeliveryMirror: { kind: "channel-final", sourceMessageId: "existing-delivery" },
      }),
    ]);

    expect(displayed).toMatchObject([{ __openclaw: { mirrorIdentity: "acp-run:assistant" } }]);
  });
});
