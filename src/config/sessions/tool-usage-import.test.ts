import { expect, it } from "vitest";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import { createToolUsageTranscriptAccumulator } from "./tool-usage-import.js";

it("does not attribute copied parent or rewind history to the executing child", () => {
  const scan = createToolUsageTranscriptAccumulator({
    catalog: [{ id: "openclaw:sample:lookup", name: "lookup" }],
    since: 0,
    before: 1000,
  });
  scan.append({ type: "session", id: "child", inheritedThrough: ["copied-result"] }, 100);
  scan.append(
    {
      type: "message",
      id: "copied-call",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "parent-call", name: "lookup", arguments: {} }],
      },
    },
    50,
  );
  scan.append(
    {
      type: "message",
      id: "copied-result",
      parentId: "copied-call",
      message: {
        role: "toolResult",
        toolCallId: "parent-call",
        toolName: "lookup",
        isError: false,
      },
    },
    60,
  );
  scan.append(
    {
      type: "message",
      id: "owned-result",
      parentId: "copied-result",
      message: {
        role: "toolResult",
        toolCallId: "child-call",
        toolName: "lookup",
        isError: false,
      },
    },
    150,
  );
  expect(scan.result()).toMatchObject({
    rows: [{ toolId: "openclaw:sample:lookup", score: 1, updatedAt: 150 }],
    successfulCalls: 1,
    excluded: { inherited: 1 },
  });
});

it("refuses ambiguous historical names but accepts the exact catalog target", () => {
  const scan = createToolUsageTranscriptAccumulator({
    catalog: [
      { id: "openclaw:first:lookup", name: "lookup" },
      { id: "openclaw:second:lookup", name: "lookup" },
    ],
    since: 0,
    before: 1000,
  });
  scan.append(
    {
      type: "message",
      id: "ambiguous",
      message: {
        role: "toolResult",
        toolCallId: "unknown-source",
        toolName: "lookup",
        isError: false,
      },
    },
    50,
  );
  scan.append(
    {
      type: "message",
      id: "call",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "exact",
            name: "dispatch_action",
            arguments: { id: "openclaw:second:lookup" },
          },
        ],
      },
    },
    100,
  );
  scan.append(
    {
      type: "message",
      id: "nested",
      parentId: "call",
      message: createNestedToolActivity({
        runId: "synthetic",
        scopeId: "synthetic",
        afterEntryId: null,
        startOrder: 0,
        parentToolCallId: "exact",
        toolCallId: "nested-call",
        toolName: "lookup",
        input: {},
        result: { content: [] },
        isError: false,
        startedAt: 120,
        timestamp: 150,
      }),
    },
    150,
  );
  scan.append(
    {
      type: "message",
      id: "result",
      parentId: "call",
      message: {
        role: "toolResult",
        toolCallId: "exact",
        toolName: "dispatch_action",
        isError: false,
      },
    },
    150,
  );
  expect(scan.result()).toMatchObject({
    rows: [{ toolId: "openclaw:second:lookup", score: 1, updatedAt: 150 }],
    successfulCalls: 1,
    excluded: { unknownTools: 1, wrappers: 1 },
  });
});

it("distinguishes Code Mode exec controls from real shell invocations", () => {
  const scan = createToolUsageTranscriptAccumulator({
    catalog: [{ id: "openclaw:core:exec", name: "exec" }],
    since: 0,
    before: 1000,
  });
  for (const [id, args] of [
    ["code", { code: "return 1" }],
    ["shell", { command: "printf ok" }],
  ] as const) {
    scan.append(
      {
        type: "message",
        id: `${id}-call`,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id, name: "exec", arguments: args }],
        },
      },
      100,
    );
    scan.append(
      {
        type: "message",
        id: `${id}-result`,
        message: { role: "toolResult", toolCallId: id, toolName: "exec", isError: false },
      },
      150,
    );
  }
  expect(scan.result()).toMatchObject({
    rows: [{ toolId: "openclaw:core:exec", score: 1, updatedAt: 150 }],
    successfulCalls: 1,
    excluded: { wrappers: 1 },
  });
});

it("recognizes Code Mode command aliases from their native result envelope", () => {
  const scan = createToolUsageTranscriptAccumulator({
    catalog: [{ id: "openclaw:core:exec", name: "exec" }],
    since: 0,
    before: 1000,
  });
  scan.append(
    {
      type: "message",
      id: "alias-call",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "alias", name: "exec", arguments: { command: "return 1" } },
        ],
      },
    },
    100,
  );
  scan.append(
    {
      type: "message",
      id: "alias-result",
      message: {
        role: "toolResult",
        toolCallId: "alias",
        toolName: "exec",
        isError: false,
        details: { status: "completed", output: [], value: 1, telemetry: { toolCallCount: 0 } },
      },
    },
    150,
  );
  expect(scan.result()).toMatchObject({ rows: [], successfulCalls: 0, excluded: { wrappers: 1 } });
});

it("attributes a nested MCP dispatch to its exact id, never a same-named native tool", () => {
  const scan = createToolUsageTranscriptAccumulator({
    catalog: [{ id: "openclaw:notes:lookup", name: "lookup" }],
    since: 0,
    before: 1000,
  });
  scan.append(
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "remote",
            name: "dispatch_action",
            arguments: { id: "mcp:bundle-mcp:lookup" },
          },
        ],
      },
    },
    100,
  );
  scan.append(
    {
      type: "message",
      message: createNestedToolActivity({
        runId: "synthetic",
        scopeId: "synthetic",
        afterEntryId: null,
        startOrder: 0,
        parentToolCallId: "remote",
        toolCallId: "nested",
        toolName: "lookup",
        input: {},
        result: { content: [] },
        isError: false,
        startedAt: 110,
        timestamp: 120,
      }),
    },
    120,
  );
  expect(scan.result()).toMatchObject({
    successfulCalls: 1,
    rows: [{ toolId: "mcp:bundle-mcp:lookup", score: 1, updatedAt: 120 }],
  });
});

it("backfills direct, bare-name dispatch, and Code Mode MCP calls from server evidence", () => {
  const scan = createToolUsageTranscriptAccumulator({
    catalog: [
      { id: "openclaw:core:exec", name: "exec" },
      { id: "openclaw:notes:granola__shadow", name: "granola__shadow" },
    ],
    since: 0,
    before: 1000,
  });
  const mcp = { mcpServer: "granola" };
  const append = (message: unknown, at = 120) => scan.append({ type: "message", message }, at);
  const nested = (
    toolCallId: string,
    parentToolCallId: string,
    toolName: string,
    details: Record<string, unknown> = mcp,
  ) =>
    createNestedToolActivity({
      runId: "synthetic",
      scopeId: "synthetic",
      afterEntryId: null,
      startOrder: 0,
      parentToolCallId,
      toolCallId,
      toolName,
      input: {},
      result: { content: [], details },
      isError: false,
      startedAt: 110,
      timestamp: 120,
    });
  const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({
    type: "toolCall",
    id,
    name,
    arguments: args,
  });
  append(
    {
      role: "assistant",
      content: [
        call("direct", "granola__list_meetings"),
        call("unproven", "granola__get_notes"),
        call("bare", "dispatch_action", { id: "granola__list_meetings" }),
        call("code", "exec", { code: "await MCP.x()" }),
      ],
    },
    100,
  );
  const result = (toolCallId: string, toolName: string, details?: unknown) => ({
    role: "toolResult",
    toolCallId,
    toolName,
    isError: false,
    details,
  });
  append(result("direct", "granola__list_meetings", mcp));
  append(result("unproven", "granola__get_notes"));
  append(nested("n-bare", "bare", "granola__list_meetings"));
  append(nested("n-code", "code", "granola__list_meetings"));
  // MCP evidence for a name a native catalog entry owns stays uncounted, direct or nested.
  append(nested("n-shadow", "code", "granola__shadow"));
  const shadow = { id: "granola__shadow" };
  const calls = [call("shadow", "granola__shadow"), call("d-nested", "dispatch_action", shadow)];
  append(
    { role: "assistant", content: [...calls, call("d-wrap", "dispatch_action", shadow)] },
    100,
  );
  append(result("shadow", "granola__shadow", mcp));
  append(nested("n-d-nested", "d-nested", "granola__shadow"));
  append({ ...result("d-wrap", "dispatch_action"), details: { result: { details: mcp } } });
  // A failed MCP call is excluded even with server evidence.
  append(nested("n-failed", "code", "granola__list_meetings", { ...mcp, status: "error" }));
  append(result("bare", "dispatch_action"), 130);
  append(result("code", "exec"), 130);
  expect(scan.result()).toMatchObject({
    rows: [{ toolId: "mcp:granola:granola__list_meetings", score: 3 }],
    successfulCalls: 3,
    excluded: { unknownTools: 5, errors: 1 },
  });
});

it("uses the persisted append timestamp consistently for lookback and coverage", () => {
  const event = {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "delayed",
      toolName: "lookup",
      isError: false,
      timestamp: 90,
    },
  };
  const catalog = [{ id: "openclaw:sample:lookup", name: "lookup" }];
  const first = createToolUsageTranscriptAccumulator({ catalog, since: 100, before: 200 });
  first.append(event, 150);
  expect(first.result().successfulCalls).toBe(1);
  const later = createToolUsageTranscriptAccumulator({
    catalog,
    since: 0,
    before: 300,
    coveredWindows: [{ since: 100, before: 200 }],
  });
  later.append(event, 150);
  expect(later.result()).toMatchObject({ successfulCalls: 0, excluded: { outsideWindow: 1 } });
});

it.each([
  ["running", false, "unknownOutcomes"],
  ["completed", false, "unknownOutcomes"],
  ["failed", true, "errors"],
] as const)(
  "does not infer success from an omitted nested %s result",
  (status, isError, exclusion) => {
    const scan = createToolUsageTranscriptAccumulator({
      catalog: [{ id: "openclaw:core:process", name: "process" }],
      since: 0,
      before: 1000,
    });
    scan.append(
      createNestedToolActivity({
        runId: "synthetic",
        scopeId: "synthetic",
        afterEntryId: null,
        startOrder: 0,
        toolCallId: "omitted-poll",
        toolName: "process",
        input: { action: "poll" },
        result: { content: [], details: { status, aggregated: "x".repeat(32_769) } },
        isError,
        startedAt: 100,
        timestamp: 120,
      }),
      120,
    );
    expect(scan.result()).toMatchObject({
      successfulCalls: 0,
      rows: [],
      excluded: { [exclusion]: 1 },
    });
  },
);
