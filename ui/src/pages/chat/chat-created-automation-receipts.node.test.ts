// @vitest-environment node
import { expect, it, vi, onTestFinished } from "vitest";
import { capToolResultForPersistence } from "../../../../src/agents/session-tool-result-guard.payload.js";
import { projectChatDisplayMessages } from "../../../../src/gateway/chat-display-projection.js";
import { createNestedToolActivity } from "../../../../src/sessions/nested-tool-activity.js";
import { automationCreationToolEvents } from "./chat-created-automation-receipts.ts";
import { resetToolStream } from "./tool-stream-state.ts";
import { agentEvent, createHost } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

const plan = {
  type: "automation_creation_plan",
  planId: "p",
  slots: [
    { slotId: "a", name: "Daily brief" },
    { slotId: "b", name: "Weekly review" },
  ],
};
const add = { action: "add", planId: "p", slotId: "a" };
const created = {
  type: "automation_creation_result",
  planId: "p",
  slotId: "a",
  status: "created",
  jobId: "saved",
};
const failed = { type: "automation_creation_result", planId: "p", slotId: "b", status: "failed" };
const rows = [
  { id: "plan-call", args: { action: "plan", slots: plan.slots }, details: plan, isError: false },
  {
    id: "add-1",
    args: add,
    details: { automationCreation: created, privateField: "not-for-history" },
    isError: false,
  },
  { id: "add-2", args: { ...add, slotId: "b" }, details: undefined, isError: true },
];
function direct(row: (typeof rows)[number]) {
  const { id, args, details, isError } = row;
  return [
    {
      role: "assistant",
      runId: "run",
      content: [{ type: "toolCall", id, name: "automations", arguments: args }],
    },
    {
      role: "toolResult",
      runId: "run",
      toolName: "automations",
      toolCallId: id,
      isError,
      details,
      content: [],
    },
  ];
}

it("replays direct, Code Mode, and live tool ownership identically before and after gateway projection", () => {
  const native = rows.flatMap(direct);
  const nested = rows.map(({ id, args, details, isError }, i) =>
    createNestedToolActivity({
      runId: "run",
      scopeId: "scope",
      afterEntryId: null,
      startOrder: i,
      toolCallId: id,
      parentToolCallId: "exec",
      toolName: "automations",
      input: args,
      result: { details, content: [] },
      isError,
      startedAt: i,
      timestamp: i,
    }),
  );
  vi.stubGlobal("window", globalThis);
  const host = createHost();
  onTestFinished(() => {
    resetToolStream(host);
    vi.unstubAllGlobals();
  });
  let seq = 0;
  for (const { id, args, details, isError } of rows) {
    for (const facts of [
      { phase: "start", args },
      { phase: "result", isError, result: { details, content: [] } },
    ]) {
      handleAgentEvent(
        host,
        agentEvent("run", ++seq, "tool", { toolCallId: id, name: "automations", ...facts }),
      );
    }
  }
  const live = [...host.toolStreamById.values()].map((entry) => entry.message);
  for (const messages of [
    native,
    nested,
    live,
    projectChatDisplayMessages(native),
    projectChatDisplayMessages(nested),
  ]) {
    expect(automationCreationToolEvents(messages)).toEqual([plan, created, failed]);
  }
  expect(JSON.stringify(projectChatDisplayMessages(nested))).not.toContain("not-for-history");
});

it("retains bounded receipts when persistence omits oversized job definitions and Code Mode arguments", () => {
  const huge = "private-job-payload".repeat(3000);
  const details = { automationCreation: created, payload: { message: huge } };
  const call = direct(rows[1]!)[0];
  const result = capToolResultForPersistence(
    {
      role: "toolResult",
      toolCallId: "add-1",
      toolName: "automations",
      isError: false,
      content: [],
      details,
      timestamp: 2,
    },
    8192,
  );
  const nested = createNestedToolActivity({
    runId: "run",
    scopeId: "scope",
    afterEntryId: null,
    startOrder: 0,
    toolCallId: "add-1",
    parentToolCallId: "exec",
    toolName: "automations",
    input: { ...add, job: { payload: { message: huge } } },
    result: { details, content: [] },
    isError: false,
    startedAt: 1,
    timestamp: 2,
  });
  for (const history of [[call, { ...result, runId: "run" }], [nested]]) {
    const display = projectChatDisplayMessages(history);
    expect(automationCreationToolEvents(display)).toEqual([created]);
    expect(JSON.stringify(display)).not.toContain(huge);
  }
});

it("does not trust model-authored results, raw job shapes, non-add actions, conflicting identities, or partial events", () => {
  const [call, result] = direct(rows[1]!);
  for (const messages of [
    [result],
    [call, { ...result, toolName: "exec" }],
    [call, { ...result, runId: "other" }],
    [call, { ...result, toolCallId: "other" }],
    [call, { ...result, __openclaw: { toolOutput: { outcome: "unknown" } } }],
    [call, { ...result, __openclaw: { catalogSource: true } }],
    [call, { ...result, isError: undefined }],
    [
      call,
      { ...result, details: undefined, content: [{ type: "text", text: JSON.stringify(created) }] },
    ],
    [
      call,
      {
        ...result,
        details: { id: "saved", enabled: true, name: "brief", schedule: { kind: "every" } },
      },
    ],
    [call, { ...result, details: { automationCreation: { ...created, slotId: "other" } } }],
    [call, { role: "assistant", content: [{ ...result, type: "toolResult" }] }],
    [call, { role: "user", content: [{ ...result, type: "toolResult" }] }],
    [
      {
        ...call,
        content: [
          {
            type: "toolCall",
            id: "add-1",
            name: "automations",
            arguments: { ...add, action: "get" },
          },
        ],
      },
      result,
    ],
    [
      {
        ...call,
        toolCallId: "add-1",
        __openclawToolStreamLive: true,
        __openclawToolStreamResultReceived: false,
        content: [
          { type: "toolcall", name: "automations", arguments: add },
          {
            type: "toolresult",
            name: "automations",
            details: { automationCreation: created },
            isError: false,
          },
        ],
      },
    ],
  ]) {
    expect(automationCreationToolEvents(messages)).toEqual([]);
  }
});
