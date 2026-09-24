import { describe, expect, it } from "vitest";
import { annotateInterSessionPromptText } from "../sessions/input-provenance.js";
import { projectForwardedMessages } from "./chat-display-projection.history.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";

describe("forwarded session attribution", () => {
  it.each([
    {
      name: "structured provenance before prompt metadata",
      sourceSessionKey: "agent:main:main",
      promptSessionKey: "agent:other:main",
      senderSession: { sessionKey: "agent:main:main", agentId: "main" },
      senderLabel: "Forwarded from main",
    },
    {
      name: "a session key without a parseable agent",
      sourceSessionKey: "legacy-session",
      promptSessionKey: undefined,
      senderSession: { sessionKey: "legacy-session" },
      senderLabel: "Forwarded agent message",
    },
    {
      name: "no source metadata",
      sourceSessionKey: undefined,
      promptSessionKey: undefined,
      senderSession: undefined,
      senderLabel: "Forwarded agent message",
    },
  ])("preserves $name in display history", (testCase) => {
    const provenance = {
      kind: "inter_session" as const,
      sourceTool: "sessions_send",
      ...(testCase.sourceSessionKey ? { sourceSessionKey: testCase.sourceSessionKey } : {}),
    };
    const message = {
      role: "user",
      provenance,
      content: annotateInterSessionPromptText("Forwarded status update", {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceSessionKey: testCase.promptSessionKey,
      }),
    };

    expect(projectChatDisplayMessages([message])).toStrictEqual([
      {
        role: "assistant",
        provenance,
        content: "Forwarded status update",
        senderLabel: testCase.senderLabel,
        ...(testCase.senderSession ? { senderSession: testCase.senderSession } : {}),
      },
    ]);
  });
  it("retains forwarded code indentation in display history", () => {
    const body = "\n    indented body\n\n";
    const provenance = {
      kind: "inter_session" as const,
      sourceTool: "sessions_send",
      sourceSessionKey: "agent:helper:main",
    };
    const message = {
      role: "user",
      provenance,
      content: annotateInterSessionPromptText(body, provenance),
    };
    expect(projectChatDisplayMessages([message])).toStrictEqual([
      {
        role: "assistant",
        provenance,
        content: body,
        senderLabel: "Forwarded from helper",
        senderSession: { sessionKey: "agent:helper:main", agentId: "helper" },
      },
    ]);
  });
});

describe("automation transcript attribution", () => {
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

  it("keeps injected name resolution ordered and memoized through its first failure", () => {
    const messages = [jobId, jobId, "blocked", "later"].map((id) => ({
      role: "user",
      content: "A report.",
      provenance: { ...provenance, jobId: id },
    }));
    const resolved: string[] = [];
    const failure = new Error("name lookup refused");
    expect(() =>
      projectForwardedMessages(messages, (id) => {
        resolved.push(id);
        if (id === "blocked") {
          throw failure;
        }
        return "Report";
      }),
    ).toThrow(failure);
    expect(resolved).toEqual([jobId, "blocked"]);
    expect(messages.map((message) => message.role)).toEqual(["user", "user", "user", "user"]);
  });

  it.each(["Daily\nreport", "Daily] report"])(
    "strips the producer envelope for the valid job name %s after a rename",
    (name) => {
      const sourcePromptPrefix = `[cron:${jobId} ${name}]`;
      const content = `${sourcePromptPrefix} Check the queue.\n    Keep indentation.`;
      const message = {
        role: "user",
        provenance: { ...provenance, sourcePromptPrefix },
        content,
      };
      expect(
        projectChatDisplayMessages([message], { resolveCronJobName: () => "Renamed report" })[0],
      ).toMatchObject({
        content: "Check the queue.\n    Keep indentation.",
        senderSession: { label: "Renamed report" },
      });
      expect(message.content).toBe(content);
    },
  );

  it("preserves a retry prompt without the recorded producer envelope", () => {
    const content = "[cron:literal example] Continue from the last result.";
    expect(
      projectChatDisplayMessages([{ role: "user", provenance, content }], {
        resolveCronJobName: () => "Daily report",
      })[0],
    ).toMatchObject({ content });
  });

  it.each(["Daily report", "Renamed report", undefined])(
    "uses the current job name %s without changing model input",
    (name) => {
      const text = `[cron:${jobId} Old report] Check the queue.\n    Keep indentation.`;
      const message = { role: "user", provenance, content: [{ type: "text", text }] };
      const projected = projectChatDisplayMessages([message], { resolveCronJobName: () => name });
      expect(projected).toMatchObject([
        {
          role: "assistant",
          senderSession: { sessionKey, agentId: "main", label: name ?? "Automation" },
          content: [{ type: "text", text: "Check the queue.\n    Keep indentation." }],
        },
      ]);
      expect(message.content[0]?.text).toBe(text);
      expect(message.role).toBe("user");
    },
  );

  it("labels a forwarded run after its session is gone", () => {
    const message = {
      role: "user",
      provenance: {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceSessionKey: sessionKey,
      },
      content: "The queue is clear.",
    };
    expect(
      projectChatDisplayMessages([message], { resolveCronJobName: () => "Daily report" })[0],
    ).toMatchObject({
      role: "assistant",
      senderSession: { sessionKey, agentId: "main", label: "Daily report" },
      content: "The queue is clear.",
    });
  });

  it("leaves unmarked historical user text and heartbeat cron events unchanged", () => {
    const content = `[cron:${jobId} Old report] Check the queue.`;
    const legacy = { role: "user", content };
    const heartbeatEvent = {
      role: "user",
      provenance: { kind: "internal_system", sourceTool: "cron" },
      content: "Reminder: check the queue.",
    };
    expect(projectChatDisplayMessages([legacy, heartbeatEvent])).toEqual([legacy, heartbeatEvent]);
  });
});

it("refreshes only the sender label of an already projected automation", () => {
  const message = {
    role: "assistant",
    content: "[cron:literal header] Keep this literal example.",
    provenance: {
      kind: "inter_session",
      sourceTool: "sessions_send",
      sourceSessionKey: "agent:main:cron:job:run:run",
    },
    senderSession: {
      sessionKey: "agent:main:cron:job:run:run",
      agentId: "main",
      label: "Old name",
    },
  };
  expect(projectForwardedMessages([message], () => "New name")[0]).toMatchObject({
    content: message.content,
    senderSession: { label: "New name" },
  });
});
