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

it("strips the recorded producer envelope after a job rename", () => {
  const sourcePromptPrefix = `[cron:${jobId} Daily\nreport]]`;
  const content = sourcePromptPrefix + " Check the queue.\n    Keep indentation.";
  const message = { role: "user", provenance: { ...provenance, sourcePromptPrefix }, content };
  expect(
    projectChatDisplayMessages([message], { resolveCronJobName: () => "Renamed report" })[0],
  ).toMatchObject({
    content: "Check the queue.\n    Keep indentation.",
    senderSession: { label: "Renamed report" },
  });
  expect(message.content).toBe(content);
});

it("preserves retry text without the recorded producer envelope", () => {
  const content = "[cron:literal example] Continue from the last result.";
  expect(
    projectChatDisplayMessages([{ role: "user", provenance, content }], {
      resolveCronJobName: () => "Daily report",
    })[0],
  ).toMatchObject({ content });
});

it("uses an automation fallback label and strips block envelopes without changing model input", () => {
  const text = provenance.sourcePromptPrefix + " Check the queue.\n    Keep indentation.";
  const message = { role: "user", provenance, content: [{ type: "text", text }] };
  expect(
    projectChatDisplayMessages([message], { resolveCronJobName: () => undefined }),
  ).toMatchObject([
    {
      role: "assistant",
      senderSession: { sessionKey, agentId: "main", label: "Automation" },
      content: [{ type: "text", text: "Check the queue.\n    Keep indentation." }],
    },
  ]);
  expect(message.content[0]?.text).toBe(text);
  expect(message.role).toBe("user");
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
