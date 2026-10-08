import { describe, expect, it } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { annotateInterSessionPromptText } from "../sessions/input-provenance.js";
import { STATE_CONTENTION_DIAGNOSTIC } from "../sessions/session-run-error-presentation.js";
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

it.each([
  [
    "agent:main:main",
    {
      senderLabel: "Forwarded from main",
      senderSession: { sessionKey: "agent:main:main", agentId: "main" },
    },
  ],
  [
    "legacy-session",
    { senderLabel: "Forwarded agent message", senderSession: { sessionKey: "legacy-session" } },
  ],
  [undefined, { senderLabel: "Forwarded agent message" }],
] as const)(
  "uses structured forwarding provenance and preserves indentation: %s",
  (sourceSessionKey, sender) => {
    const provenance = {
      kind: "inter_session" as const,
      sourceTool: "sessions_send",
      ...(sourceSessionKey ? { sourceSessionKey } : {}),
    };
    const body = "\n    indented body\n\n";
    const message = {
      role: "user",
      provenance,
      content: annotateInterSessionPromptText(body, {
        ...provenance,
        sourceSessionKey: "agent:other:main",
      }),
    };
    expect(projectChatDisplayMessages([message])).toStrictEqual([
      { ...message, role: "assistant", content: body, ...sender },
    ]);
  },
);

const jobId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const sessionKey = `agent:main:cron:${jobId}:run:${runId}`;
const provenance = {
  kind: "internal_system",
  sourceTool: "cron",
  jobId,
  runId,
  sourceSessionKey: sessionKey,
  sourcePromptPrefix: `[cron:${jobId} Old report]`,
};

it("projects only recorded cron envelopes and current labels without changing model input", () => {
  const body = "Check the queue.\n    Keep indentation.";
  const renamedPrefix = `[cron:${jobId} Daily\nreport]]`;
  const retry = "[cron:literal example] Continue from the last result.";
  for (const [prefix, content, label, expected] of [
    [renamedPrefix, `${renamedPrefix} ${body}`, "Renamed report", body],
    [provenance.sourcePromptPrefix, retry, "Daily report", retry],
    [
      provenance.sourcePromptPrefix,
      [{ type: "text", text: `${provenance.sourcePromptPrefix} ${body}` }],
      undefined,
      [{ type: "text", text: body }],
    ],
  ] as const) {
    const message = {
      role: "user",
      provenance: { ...provenance, sourcePromptPrefix: prefix },
      content,
    };
    const original = structuredClone(message);
    expect(
      projectChatDisplayMessages([message], { resolveCronJobName: () => label }),
    ).toMatchObject([
      {
        role: "assistant",
        senderSession: { sessionKey, agentId: "main", label: label ?? "Automation" },
        content: expected,
      },
    ]);
    expect(message).toEqual(original);
  }
});

it.each(["state_contention", "unknown"])(
  "allowlists only certified presentation, never raw report diagnostics (%s)",
  (errorKind) => {
    const [result] = projectChatDisplayMessages([
      {
        role: "custom",
        customType: "run-failed-before-reply",
        content: "Public summary",
        details: {
          runId: "run-1",
          errorKind,
          error: "PRIVATE_ERROR_CANARY",
          diagnostic: "PRIVATE_DIAGNOSTIC_CANARY",
          path: "PRIVATE_PATH_CANARY",
        },
      },
    ]);
    expect(result).toMatchObject({ content: "Public summary", __openclaw: { runId: "run-1" } });
    if (errorKind === "state_contention") {
      expect(result).toHaveProperty("details", {
        errorKind,
        diagnostic: STATE_CONTENTION_DIAGNOSTIC,
      });
    } else {
      expect(result).not.toHaveProperty("details");
    }
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  },
);
