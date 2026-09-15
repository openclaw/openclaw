import { describe, expect, it } from "vitest";
import { annotateInterSessionPromptText } from "../sessions/input-provenance.js";
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
      name: "asserted prompt metadata ignored when provenance lacks the source key",
      sourceSessionKey: undefined,
      promptSessionKey: "agent:helper:dashboard:source",
      senderSession: undefined,
      senderLabel: "Forwarded agent message",
    },
    {
      name: "malformed asserted source without a structured source key",
      sourceSessionKey: undefined,
      promptSessionKey: "not-a-session",
      senderSession: undefined,
      senderLabel: "Forwarded agent message",
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
