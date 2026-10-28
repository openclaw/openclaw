import { expect, it } from "vitest";
import { HEARTBEAT_PROMPT, INTERNAL_WAKE_TRANSCRIPT_PROMPTS } from "../auto-reply/heartbeat.js";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "../plugin-sdk/message-tool-delivery-hints.js";
import { annotateInterSessionPromptText } from "../sessions/input-provenance.js";
import { STATE_CONTENTION_DIAGNOSTIC } from "../sessions/session-run-error-presentation.js";
import { buildPersistedUserTurnMessage } from "../sessions/user-turn-transcript.message.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { projectPendingInputMessage } from "./server-methods/chat-pending-inputs.js";
import { assistantTextMessage } from "./session-history-fixtures.test-support.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";

const internalContext = (text: string) =>
  ["<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>", text, "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>"].join("\n");
const userTextMessage = (text: string, seq = 1) => ({
  role: "user",
  content: [{ type: "text", text }],
  __openclaw: { seq },
});
const internalMessage = (text: string, sourceTool: string, seq = 1) => ({
  ...userTextMessage(text, seq),
  provenance: { kind: "internal_system", sourceTool },
});
const mediaMessage = (text: string, seq: number, url: string) => ({
  ...assistantTextMessage(text, seq),
  content: [
    { type: "text", text },
    { type: "image", source: { type: "url", url } },
  ],
});
const expectProjection = (
  messages: unknown[],
  expected: unknown[],
  options?: Parameters<typeof projectChatDisplayMessages>[1],
) => expect(projectChatDisplayMessages(messages, options)).toEqual(expected);

it.each(["reviewer", "legacy-plugin"])("projects %s steering only on request", (pluginId) => {
  const legacy = pluginId === "legacy-plugin";
  const metadata = { pluginId, ...(legacy ? {} : { pluginName: "Review Helper" }) };
  const displayText = "Use the smaller change.";
  const steering = {
    ...internalMessage(`Private prefix.\n\n${displayText}`, `plugin:${pluginId}`),
    display: false,
    __openclaw: {
      seq: 2,
      ...(legacy ? {} : { pluginSteering: { ...metadata, displayText } }),
    },
  };
  const original = structuredClone(steering);
  const rows = [
    steering,
    { ...steering, provenance: { kind: "internal_system", sourceTool: "exec" } },
    { ...steering, provenance: { kind: "internal_system", sourceTool: "plugin:" } },
    { ...steering, provenance: { kind: "external_user", sourceTool: `plugin:${pluginId}` } },
    { ...steering, role: "assistant" },
  ];
  expectProjection(rows, []);
  expectProjection(rows, [], { includePluginSteering: false });
  expect(projectChatDisplayMessages(rows, { includePluginSteering: true })).toMatchObject([
    {
      role: "user",
      display: true,
      content: legacy ? steering.content : [{ type: "text", text: displayText }],
      __openclaw: { pluginSteering: metadata },
    },
  ]);
  expect(steering).toEqual(original);
  const [capped] = projectChatDisplayMessages([steering], {
    includePluginSteering: true,
    maxChars: 8,
  });
  expect(capped).not.toHaveProperty(["__openclaw", "pluginSteering", "displayText"]);
});

it("hides tool handoff resumes from history, live, and pending chat but keeps plugin events", () => {
  const event = (sourceTool: string, text: string) =>
    buildPersistedUserTurnMessage({
      text,
      timestamp: 2,
      provenance: { kind: "internal_system", sourceTool },
    });
  const resume = event(
    "tool_handoff",
    'Plugin reload result: {"ok":false,"error":"denied","code":"INVALID_REQUEST"}\n' +
      "Continue the original task in this conversation. Do not repeat a completed operation.",
  );
  const pluginEvent = event("plugin", "Discord presence changed to idle.");
  const answer = assistantTextMessage("The reload was refused; nothing changed.", 3);
  expect(projectChatDisplayMessages([resume, pluginEvent, answer])).toMatchObject([
    { role: "user", content: pluginEvent.content },
    { role: "assistant", content: answer.content },
  ]);
  const live = (message: unknown) =>
    projectSessionMessagePayload({ message, sessionKey: "agent:main:main" }).payload;
  expect(live(resume)).toBeUndefined();
  expect(live(pluginEvent)?.message).toMatchObject({ content: pluginEvent.content });
  const pending = (message: typeof resume) =>
    projectPendingInputMessage(
      { id: "event-1", runId: "event-run", message, acceptedAt: 2, state: "queued" },
      20_000,
      (projected) => projected,
    );
  expect(pending(resume)).toBeUndefined();
  expect(pending(pluginEvent)).toMatchObject({ content: pluginEvent.content });
});

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
  expectProjection(
    [child, { ...assistantTextMessage("No state changed.", 2), display: false }, peer, answer],
    [expect.objectContaining({ role: "assistant", content: peer.content }), answer],
  );
  expect(child.content).toBe("Root accepted the unchanged child report.");
});

it.each(["visible ask", ""])("strips legacy internal envelopes: %s", (visible) => {
  const answer = assistantTextMessage("visible answer", 2);
  expectProjection(
    [userTextMessage(`${internalContext("private payload")}\n\n${visible}`), answer],
    [...(visible ? [userTextMessage(visible)] : []), answer],
  );
});

it.each([
  [" exec ", "Exec completed (background-job, code 0) :: PRIVATE_COMMAND_OUTPUT"],
  ["subagent_announce", "private child announcement"],
  ["subagent_settle", "private child settlement"],
  ["image_generate", 'session_key: image_generate:task-123\npath="/private.png"'],
])("hides internal %s inputs without hiding authored outcomes", (sourceTool, text) => {
  const exec = sourceTool.trim() === "exec";
  const completion = {
    ...userTextMessage(text),
    provenance: {
      kind: exec ? "internal_system" : "inter_session",
      sourceTool,
    },
  };
  const original = structuredClone(completion);
  const controls = exec
    ? [
        { ...userTextMessage(text), provenance: { kind: "external_user" } },
        internalMessage("Gateway restarted during update.", "restart-sentinel"),
      ]
    : [];
  const answer = mediaMessage("Created.", 2, "/api/chat/media/outgoing/generated.png");
  expectProjection([completion, ...controls, answer], [...controls, answer]);
  expect(completion).toEqual(original);
});

it.each([
  ["heartbeat", { role: "user", content: [{ type: "text", text: HEARTBEAT_PROMPT }] }],
  ["exec completion", internalMessage("Exec completed (amber-ri, code 0) :: output", "exec", 2)],
])("keeps a %s boundary on a tool-shaped user row", (_name, hidden) => {
  const toolResult = {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }],
    __openclaw: { seq: 3 },
  };
  const toolEnvelope = { ...userTextMessage("done", 5), toolCallId: "tool-1" };
  const answer = assistantTextMessage("Disk usage crossed 95 percent.", 4);
  for (const toolRow of [toolResult, toolEnvelope]) {
    expectProjection(
      [hidden, toolRow, answer],
      [{ ...toolRow, __openclaw: { ...toolRow["__openclaw"], turnBoundary: true } }, answer],
    );
  }
});

it("starts a new turn after a hidden exec completion so the earlier answer stays its own reply", () => {
  const earlier = assistantTextMessage("long final answer", 2);
  const completion = {
    ...internalMessage("Exec completed (amber-ri, code 0) :: output", "exec", 3),
    timestamp: 100,
  };
  const followUp = assistantTextMessage("should I fix points 1-4?", 4);
  expectProjection(
    [earlier, completion, followUp],
    [earlier, { ...followUp, __openclaw: { seq: 4, turnBoundary: true } }],
  );
});

it.each(["no_r", "NO_R", "No_Repl"])("keeps ordinary %s replies visible", (text) => {
  const messages = [
    assistantTextMessage(text, 1),
    { role: "assistant", display: true, content: text },
  ];
  expectProjection(messages, messages);
});

it.each(Object.entries(INTERNAL_WAKE_TRANSCRIPT_PROMPTS))(
  "requires heartbeat context to hide a truncated reply after %s",
  (kind, marker) => {
    for (const prompt of [marker, `${MESSAGE_TOOL_DELIVERY_HINTS[0]} ${marker}`]) {
      const answer = { role: "assistant", display: true, content: "no_r" };
      expectProjection(
        [{ role: "user", content: prompt }, answer],
        kind === "heartbeat" ? [] : [{ ...answer, __openclaw: { turnBoundary: true } }],
      );
    }
  },
);

it("hides heartbeat prompt and ok acknowledgements from visible history", () => {
  const answer = assistantTextMessage("Disk usage crossed 95 percent.", 4);
  expectProjection(
    [
      userTextMessage(
        `${HEARTBEAT_PROMPT}\nWhen reading HEARTBEAT.md, use workspace file /tmp/HEARTBEAT.md (exact case). Do not read docs/heartbeat.md.`,
      ),
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Checking the heartbeat." },
          { type: "text", text: "HEARTBEAT_OK" },
        ],
        __openclaw: { seq: 2 },
      },
      userTextMessage(HEARTBEAT_PROMPT, 3),
      answer,
    ],
    [{ ...answer, __openclaw: { seq: 4, turnBoundary: true } }],
  );
});

it.each([
  ["agent:main:main", "main"],
  ["legacy-session", undefined],
  [undefined, undefined],
] as const)(
  "uses structured forwarding provenance and preserves indentation: %s",
  (sourceSessionKey, agentId) => {
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
      {
        ...message,
        role: "assistant",
        content: body,
        senderLabel: agentId ? `Forwarded from ${agentId}` : "Forwarded agent message",
        ...(sourceSessionKey
          ? { senderSession: { sessionKey: sourceSessionKey, ...(agentId ? { agentId } : {}) } }
          : {}),
      },
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

it("keeps scheduled inputs quiet without hiding historical announcements, lookalikes, or delivered media", () => {
  const input = {
    ...userTextMessage("[cron:daily Daily check] Check the queue."),
    provenance: { ...provenance, sourceTool: "cron_execution" },
  };
  const announcement = {
    ...userTextMessage("The historical scheduled result is ready.", 2),
    provenance,
  };
  const human = {
    ...userTextMessage("[cron:daily Daily check] This is my example.", 3),
    provenance: { kind: "external_user", sourceTool: "cron_execution" },
  };
  const delivered = {
    ...mediaMessage("The new scheduled result is ready.", 4, "/api/chat/media/outgoing/report.png"),
    provenance: input.provenance,
  };
  const original = structuredClone(input);
  expectProjection(
    [input, announcement, human, delivered],
    [
      expect.objectContaining({ role: "assistant", content: announcement.content, provenance }),
      human,
      delivered,
    ],
    { resolveCronJobName: () => "Daily check" },
  );
  expectProjection([input], [], { resolveCronJobName: () => "Daily check" });
  expect(input).toEqual(original);
});

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
