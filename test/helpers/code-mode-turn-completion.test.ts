import { describe, expect, it } from "vitest";
import {
  describeCodeModeOutbound,
  observeCodeModeTurnCompletion,
} from "./code-mode-turn-completion.js";

function fixture(turn = "A", deliveryStatus: "sent" | "partial_failed" = "sent") {
  const marker = `QA-${turn}-OUTBOUND`;
  const plannedToolCallId = `call-${turn}`;
  const plannedToolItemId = `fc-${turn}`;
  const transcriptToolCallId = `${plannedToolCallId}|${plannedToolItemId}`;
  const plannedCode = `return await send_current_reply({ text: "${marker}" });`;
  const result = {
    status: "completed",
    value: {
      sent:
        deliveryStatus === "sent"
          ? { status: "sent", messageId: `message-${turn}` }
          : { status: "partial_failed", sentBeforeError: true, error: "response lost" },
      observed: true,
    },
    output: [],
  };
  const assistant = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: transcriptToolCallId,
        name: "exec",
        arguments: { code: plannedCode },
      },
    ],
  };
  const toolResult = {
    role: "toolResult",
    toolName: "exec",
    toolCallId: transcriptToolCallId,
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
  const history: {
    sessionKey: string;
    sessionId: string;
    sessionInfo: { hasActiveRun?: boolean };
    messages: unknown[];
  } = {
    sessionKey: "agent:main:qa:proof",
    sessionId: "proof-session",
    sessionInfo: { hasActiveRun: false },
    messages: [assistant, toolResult],
  };
  const params: Parameters<typeof observeCodeModeTurnCompletion>[0] = {
    history,
    sessionKey: history.sessionKey,
    plannedToolCallId,
    plannedToolItemId,
    plannedCode,
    marker,
    deliveryStatus,
  };
  return {
    params,
    history,
    assistant,
    toolResult,
    result,
  };
}

describe("Code Mode current-turn completion observer", () => {
  it.each(["sent", "partial_failed"] as const)(
    "reads pretty-printed public exec text with truthful %s delivery",
    (deliveryStatus) => {
      const { params, history } = fixture("A", deliveryStatus);
      expect(observeCodeModeTurnCompletion(params)).toMatchObject({
        status: "complete",
        sessionId: history.sessionId,
        toolCallId: `${params.plannedToolCallId}|${params.plannedToolItemId}`,
        execResult: { status: "completed", value: { sent: { status: deliveryStatus } } },
      });
    },
  );

  it("requires the second turn's planned call on the same inactive session", () => {
    const first = fixture("A");
    const second = fixture("B");
    const completedFirst = observeCodeModeTurnCompletion(first.params);
    expect(completedFirst.status).toBe("complete");
    second.history.messages = first.history.messages;
    expect(observeCodeModeTurnCompletion(second.params).status).toBe("pending");
    second.history.messages = [...first.history.messages, second.assistant, second.toolResult];
    expect(
      observeCodeModeTurnCompletion({ ...second.params, sessionId: first.history.sessionId }),
    ).toMatchObject({ status: "complete", toolCallId: "call-B|fc-B" });
    second.history.sessionId = "replacement-session";
    expect(
      observeCodeModeTurnCompletion({ ...second.params, sessionId: first.history.sessionId }),
    ).toMatchObject({ status: "pending", reason: "session identity mismatch" });
  });

  it.each([
    {
      name: "a later transcript row",
      mutate: (f: ReturnType<typeof fixture>) => f.history.messages.push({ role: "assistant" }),
      reason: "current exec is not the final transcript result",
    },
    {
      name: "an errored final exec",
      mutate: (f: ReturnType<typeof fixture>) => Object.assign(f.toolResult, { isError: true }),
      reason: "current exec transcript result is an error",
    },
  ])("distinguishes $name without certifying completion", ({ mutate, reason }) => {
    const f = fixture();
    mutate(f);
    expect(observeCodeModeTurnCompletion(f.params)).toMatchObject({
      status: "pending",
      reason,
      diagnostics: { matchingAssistantCalls: 1, matchingExecResults: 1 },
    });
  });

  it.each([false, true])(
    "bounds structural rows without retaining content (isError=%s)",
    (isError) => {
      const f = fixture();
      const privateText = "private-diagnostic-fixture";
      const row = {
        role: privateText,
        content: [{ type: "text", text: privateText }],
        credentials: privateText,
      };
      f.history.messages = [...Array.from({ length: 8 }, () => row), f.assistant, f.toolResult];
      Object.assign(f.toolResult, { isError });
      const observed = observeCodeModeTurnCompletion(f.params);
      expect(observed.status).toBe(isError ? "pending" : "complete");
      expect(observed.diagnostics).toEqual({
        messageCount: 10,
        matchingAssistantCalls: 1,
        matchingExecResults: 1,
        recentRows: [
          {
            index: 6,
            role: "other",
            isError: false,
            contentBlockCount: 1,
            currentExecResult: false,
          },
          {
            index: 7,
            role: "other",
            isError: false,
            contentBlockCount: 1,
            currentExecResult: false,
          },
          {
            index: 8,
            role: "assistant",
            isError: false,
            contentBlockCount: 1,
            currentExecResult: false,
          },
          {
            index: 9,
            role: "toolResult",
            isError,
            contentBlockCount: 1,
            currentExecResult: true,
            execStatus: "completed",
          },
        ],
      });
      for (const value of [
        privateText,
        f.params.plannedCode,
        f.params.plannedToolCallId,
        f.params.marker,
      ]) {
        expect(
          JSON.stringify(observed.status === "pending" ? observed : observed.diagnostics),
        ).not.toContain(value);
      }
      f.params.history = undefined;
      expect(observeCodeModeTurnCompletion(f.params)).toMatchObject({
        status: "pending",
        diagnostics: {
          messageCount: 0,
          matchingAssistantCalls: 0,
          matchingExecResults: 0,
          recentRows: [],
        },
      });
    },
  );

  it.each(["completed", "waiting", "failed", "private-status", "{"])(
    "bounds structural exec status diagnostics for %s",
    (status) => {
      const f = fixture();
      f.toolResult.content[0]!.text = status === "{" ? status : JSON.stringify({ status });
      Object.assign(f.toolResult, { isError: true });
      const observed = observeCodeModeTurnCompletion(f.params);
      expect(observed).toMatchObject({
        status: "pending",
        diagnostics: {
          recentRows: [
            { role: "assistant" },
            {
              execStatus:
                status === "{" ? "unavailable" : status === "private-status" ? "other" : status,
            },
          ],
        },
      });
      expect(JSON.stringify(observed)).not.toContain("private-status");
    },
  );

  it("classifies deleted outbound rows without hiding them or leaking contents", () => {
    const rows = [
      ...Array.from({ length: 5 }, () => ({ direction: "outbound", text: "expected" })),
      { direction: "inbound", text: "private-input" },
      { direction: "outbound", text: "expected", deleted: true, id: "private-id" },
      { direction: "outbound", text: "ordinary-final", deleted: true },
      {
        direction: "outbound",
        text: "private-error",
        error: "private-error",
        isError: true,
        toolCalls: [{ name: "private-tool", arguments: { text: "private-argument" } }],
        attachments: [{ filename: "private-file", contentBase64: "private-content" }],
      },
    ];
    const result = describeCodeModeOutbound(rows, ["expected"], ["ordinary-final"]);
    expect(result).toEqual({
      count: 8,
      deletedCount: 2,
      recentRows: [
        { class: "expected", deleted: false, isError: false, toolCallCount: 0, attachmentCount: 0 },
        { class: "expected", deleted: true, isError: false, toolCallCount: 0, attachmentCount: 0 },
        {
          class: "ordinary-final",
          deleted: true,
          isError: false,
          toolCallCount: 0,
          attachmentCount: 0,
        },
        { class: "other", deleted: false, isError: true, toolCallCount: 1, attachmentCount: 1 },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(describeCodeModeOutbound([], [], [])).toEqual({
      count: 0,
      deletedCount: 0,
      recentRows: [],
    });
  });

  it.each([
    ["missing history", (f) => (f.params.history = undefined)],
    ["wrong session key", (f) => (f.history.sessionKey = "another-session")],
    ["missing session id", (f) => (f.history.sessionId = "")],
    ["active run", (f) => (f.history.sessionInfo.hasActiveRun = true)],
    ["unknown activity", (f) => (f.history.sessionInfo = {})],
    ["missing provider call id", (f) => (f.params.plannedToolCallId = "")],
    ["wrong provider call id", (f) => (f.params.plannedToolCallId = "another-call")],
    ["missing provider item id", (f) => (f.params.plannedToolItemId = "")],
    ["wrong provider item id", (f) => (f.params.plannedToolItemId = "another-item")],
    [
      "raw provider call id without item identity",
      (f) => {
        f.assistant.content[0]!.id = f.params.plannedToolCallId;
        f.toolResult.toolCallId = f.params.plannedToolCallId;
      },
    ],
    [
      "another item for the same provider call",
      (f) => {
        f.assistant.content[0]!.id = `${f.params.plannedToolCallId}|fc-other`;
        f.toolResult.toolCallId = f.assistant.content[0]!.id;
      },
    ],
    [
      "a prefix match with an extra suffix",
      (f) => {
        f.assistant.content[0]!.id += "-extra";
        f.toolResult.toolCallId = f.assistant.content[0]!.id;
      },
    ],
    ["historical marker", (f) => (f.params.marker = "QA-B-OUTBOUND")],
    ["wrong assistant call id", (f) => (f.assistant.content[0]!.id = "another-call")],
    ["wrong assistant arguments", (f) => (f.assistant.content[0]!.arguments.code = "return 1")],
    ["wrong assistant role", (f) => (f.assistant.role = "user")],
    ["duplicate assistant call", (f) => f.history.messages.unshift(f.assistant)],
    ["wrong result call id", (f) => (f.toolResult.toolCallId = "another-call")],
    ["duplicate result", (f) => f.history.messages.push(f.toolResult)],
    ["result before call", (f) => (f.history.messages = f.history.messages.toReversed())],
    ["ordinary final after result", (f) => f.history.messages.push({ role: "assistant" })],
    ["wrong result role", (f) => (f.toolResult.role = "assistant")],
    ["wrong tool name", (f) => (f.toolResult.toolName = "read")],
    ["error result", (f) => Object.assign(f.toolResult, { isError: true })],
    ["malformed JSON", (f) => (f.toolResult.content[0]!.text = '{"status":"completed"')],
    [
      "nested status only",
      (f) => (f.toolResult.content[0]!.text = '{"value":{"status":"completed"}}'),
    ],
    ["oversized result", (f) => (f.toolResult.content[0]!.text = "x".repeat(64_001))],
    ["ambiguous text blocks", (f) => f.toolResult.content.push(f.toolResult.content[0]!)],
  ] satisfies Array<[string, (f: ReturnType<typeof fixture>) => unknown]>)(
    "does not certify %s",
    (_name, mutate) => {
      const f = fixture();
      mutate(f);
      const observed = observeCodeModeTurnCompletion(f.params);
      expect(observed.status).toBe("pending");
      if (observed.status === "pending") {
        expect(observed.reason.length).toBeLessThan(100);
        expect(observed.reason).not.toContain(f.params.plannedCode);
      }
    },
  );

  it.each([
    ["waiting", (result) => (result.status = "waiting")],
    ["failed", (result) => (result.status = "failed")],
    ["missing following observation", (result) => (result.value.observed = false)],
    ["acknowledgement loss called success", (result) => (result.value.sent.status = "sent")],
    ["no dispatch evidence", (result) => (result.value.sent.sentBeforeError = false)],
    ["no acknowledgement error", (result) => (result.value.sent.error = "")],
  ] satisfies Array<[string, (result: ReturnType<typeof fixture>["result"]) => unknown]>)(
    "does not certify %s even when private details say completed",
    (_name, mutate) => {
      const f = fixture("A", "partial_failed");
      mutate(f.result);
      f.toolResult.content[0]!.text = JSON.stringify(f.result);
      Object.assign(f.toolResult, { details: { status: "completed", value: { observed: true } } });
      expect(observeCodeModeTurnCompletion(f.params).status).toBe("pending");
    },
  );
});
