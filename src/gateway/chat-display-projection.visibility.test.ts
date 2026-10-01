import { describe, expect, it } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { assistantTextMessage } from "./session-history-fixtures.test-support.js";

const internalContext = (text: string) =>
  ["<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>", text, "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>"].join("\n");
const userTextMessage = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
  __openclaw: { seq: 1 },
});

describe("internal history display projection", () => {
  it("hides attributed child coordination without hiding peer messages or parent answers", () => {
    const child = {
      role: "user",
      content: "Root accepted the unchanged child report.",
      provenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:visible-worker",
        sourceTool: "  sessions_send\t",
        sourceRole: "subagent",
      },
    };
    const peer = {
      ...child,
      content: "Independent peer result.",
      provenance: { ...child.provenance, sourceRole: undefined },
    };
    const answer = assistantTextMessage("The regression is fixed; release checks remain.", 4);
    expect(
      projectChatDisplayMessages([
        child,
        { ...assistantTextMessage("No state changed.", 2), display: false },
        peer,
        answer,
      ]),
    ).toEqual([expect.objectContaining({ role: "assistant", content: peer.content }), answer]);
    expect(child.content).toBe("Root accepted the unchanged child report.");
  });

  it("strips legacy internal envelopes before exposing history", () => {
    const projected = projectChatDisplayMessages([
      userTextMessage(`${internalContext("secret runtime context")}\n\nvisible ask`),
    ]);

    expect(projected).toMatchObject([{ content: [{ text: "visible ask" }] }]);
  });

  it("drops internal-only user messages after envelope stripping", () => {
    const projected = projectChatDisplayMessages([
      userTextMessage(internalContext("subagent completion payload")),
      assistantTextMessage("visible answer", 2),
    ]);

    expect(projected).toEqual([assistantTextMessage("visible answer", 2)]);
  });

  it.each(["subagent_announce", "subagent_settle"])(
    "drops %s inter-session user messages from projected history",
    (sourceTool) => {
      const projected = projectChatDisplayMessages([
        {
          ...userTextMessage(
            [
              `[Inter-session message] sourceSession=agent:main:subagent:child sourceChannel=internal sourceTool=${sourceTool} isUser=false`,
              "This content was routed by OpenClaw from another session or internal tool.",
              internalContext("subagent completion payload"),
            ].join("\n"),
          ),
          provenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:main:subagent:child",
            sourceTool,
          },
        },
        assistantTextMessage("clean child result", 2),
      ]);

      expect(projected).toEqual([assistantTextMessage("clean child result", 2)]);
    },
  );

  it("drops generated media completion wakes while retaining final media", () => {
    const assistantReply = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "Created." },
        {
          type: "image" as const,
          source: { type: "url" as const, url: "/api/chat/media/outgoing/generated.png" },
        },
      ],
      __openclaw: { seq: 2 },
    };
    const projected = projectChatDisplayMessages([
      {
        ...userTextMessage(
          [
            "A background task completed. Use this result to reply normally.",
            "session_key: image_generate:task-123",
            'path="/root/.openclaw/media/tool-image-generation/private.png"',
          ].join("\n"),
        ),
        provenance: {
          kind: "inter_session",
          sourceChannel: "internal",
          sourceSessionKey: "image_generate:task-123",
          sourceTool: "image_generate",
        },
      },
      assistantReply,
    ]);

    expect(projected).toEqual([assistantReply]);
    expect(JSON.stringify(projected)).not.toContain("image_generate:task-123");
    expect(JSON.stringify(projected)).not.toContain("/root/.openclaw/media");
  });

  it("hides heartbeat prompt and ok acknowledgements from visible history", () => {
    const projected = projectChatDisplayMessages([
      {
        role: "user",
        content: `${HEARTBEAT_PROMPT}\nWhen reading HEARTBEAT.md, use workspace file /tmp/HEARTBEAT.md (exact case). Do not read docs/heartbeat.md.`,
        __openclaw: { seq: 1 },
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Checking the heartbeat." },
          { type: "text", text: "HEARTBEAT_OK" },
        ],
        __openclaw: { seq: 2 },
      },
      {
        role: "user",
        content: HEARTBEAT_PROMPT,
        __openclaw: { seq: 3 },
      },
      assistantTextMessage("Disk usage crossed 95 percent.", 4),
    ]);

    expect(projected).toEqual([
      {
        ...assistantTextMessage("Disk usage crossed 95 percent.", 4),
        __openclaw: { seq: 4, turnBoundary: true },
      },
    ]);
  });
});
