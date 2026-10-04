import { expect, it } from "vitest";
import { annotateInterSessionPromptText } from "../sessions/input-provenance.js";
import { projectForwardedMessages } from "./chat-display-projection.history.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";

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

it("refreshes only the sender label of an already projected automation", () => {
  const message = {
    role: "assistant",
    content: "[cron:literal header] Keep this literal example.",
    provenance: {
      kind: "inter_session",
      sourceTool: "sessions_send",
      sourceSessionKey: sessionKey,
    },
    senderSession: { sessionKey, agentId: "main", label: "Old name" },
  };
  expect(projectForwardedMessages([message], () => "New name")[0]).toMatchObject({
    content: message.content,
    senderSession: { label: "New name" },
  });
});
