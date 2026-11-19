/* @vitest-environment jsdom */
import { expect, it, onTestFinished } from "vitest";
import { projectChatDisplayMessages } from "../../../../../src/gateway/chat-display-projection.js";
import type {
  AutomationCreationPlan,
  AutomationCreationResult,
} from "../../../../../src/shared/automation-creation.js";
import { AutomationCreationCardBlock } from "../../../lib/chat/automation-creation-card.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { chatItemGroups } from "../chat-agent-run-grouping.ts";
import { createState } from "../chat-gateway.test-support.ts";
import { handleChatGatewayEvent } from "../chat-gateway.ts";
import { buildItems, makeMessage } from "../chat-thread.test-support.ts";
import { render } from "../test-helpers/chat-transcript-native.tsx";
import { threadFixture } from "./chat-transcript-fixture.test-support.tsx";
import { projectTranscriptChain } from "./chat-transcript-message-index.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

const sessionKey = "agent:main:dashboard:planning";
const plan: AutomationCreationPlan = {
  type: "automation_creation_plan",
  planId: "plan-1",
  slots: [
    { slotId: "a", name: "Morning digest" },
    { slotId: "b", name: "Weekly digest" },
  ],
};
const created: AutomationCreationResult = {
  type: "automation_creation_result",
  planId: plan.planId,
  slotId: "b",
  status: "created",
  jobId: "saved-weekly",
};
const failed: AutomationCreationResult = {
  type: "automation_creation_result",
  planId: plan.planId,
  slotId: "a",
  status: "failed",
};
function cards(messages: unknown[], toolMessages: unknown[] = [], showToolCalls = false) {
  const opts = {
    sessionKey,
    messages,
    toolMessages,
    showToolCalls,
    runId: "setup",
    runWorking: true,
    activeRunId: "setup",
    searchActive: false,
  };
  const chain = projectTranscriptChain(buildItems(opts), opts);
  return chain.transcriptItems
    .flatMap(chatItemGroups)
    .flatMap((g) =>
      g.messages.flatMap(({ message, key }) =>
        normalizeMessage(message).content.flatMap((block) =>
          block instanceof AutomationCreationCardBlock
            ? [{ key, role: g.role, rows: block.plan.rows }]
            : [],
        ),
      ),
    );
}
function injected(...events: Array<AutomationCreationPlan | AutomationCreationResult>) {
  return projectChatDisplayMessages(
    events.map((e, i) => ({
      role: "assistant",
      provider: "openclaw",
      model: "gateway-injected",
      content: [],
      openclawDisplayContent: [e],
      timestamp: 10 + i,
    })),
  );
}
it("places one installer assistant card at the declaration, resolving out of order without changing its key or shape", () => {
  const pending = cards(injected(plan));
  expect(pending).toEqual([
    {
      key: expect.any(String),
      role: "assistant",
      rows: plan.slots.map((s) => ({ ...s, status: "pending" })),
    },
  ]);
  const partial = cards(injected(plan, created));
  expect(partial).toEqual([
    {
      ...pending[0],
      rows: [
        { ...plan.slots[0], status: "pending" },
        { ...plan.slots[1], status: "created", jobId: "saved-weekly" },
      ],
    },
  ]);
  expect(cards(injected(plan, created, failed, created))).toEqual([
    { ...partial[0], rows: [{ ...plan.slots[0], status: "failed" }, partial[0]!.rows[1]] },
  ]);
  expect(cards(injected(created))).toEqual([]);
  expect(cards(injected({ ...plan, slots: [plan.slots[0]!, plan.slots[0]!] }))).toEqual([]);
  expect(
    cards([
      { role: "user", content: [plan] },
      { role: "assistant", content: [plan] },
    ]),
  ).toEqual([]);
});

function liveTool(id: string, action: string, args: object, details: unknown, isError = false) {
  return {
    role: "assistant",
    runId: "setup",
    toolCallId: id,
    timestamp: 100,
    __openclawToolStreamLive: true,
    __openclawToolStreamResultReceived: true,
    content: [
      { type: "toolcall", name: "automations", arguments: { action, ...args } },
      { type: "toolresult", name: "automations", details, isError },
    ],
  };
}
it("seeds only a live, confirmed receipt; incremental history cannot revive stale controls", () => {
  const definition = {
    id: created.jobId,
    name: "Saved label",
    enabled: false,
    configRevision: "v1",
  };
  const result = { ...created, definition };
  const persisted = injected(plan, result);
  expect(cards(persisted)[0]?.rows[1]).not.toHaveProperty("definition");
  const state = createState({ sessionKey, chatMessages: [] });
  for (const [index, message] of persisted.entries()) {
    handleChatGatewayEvent(state, {
      state: "final",
      sessionKey,
      seq: 0,
      runId: "inject-receipt-" + index,
      message,
    });
  }
  expect(cards(state.chatMessages)[0]?.rows[1]).toMatchObject({ definition });
  const declared = liveTool("plan", "plan", { names: plan.slots.map((s) => s.name) }, plan);
  const saved = liveTool("added", "add", { position: 2 }, { automationCreation: result });
  expect(cards([], [declared, saved])[0]?.rows[1]).toMatchObject({ definition });
});

it("keeps a standalone plan in each originating turn even when provider call IDs repeat", () => {
  const slots = plan.slots.slice(0, 1);
  const messages = ["turn-a", "turn-b"].flatMap((runId, i) => [
    makeMessage("prompt-" + i, 10 * i + 1, { role: "user", runId }),
    {
      ...liveTool("reused-call", "plan", { slots }, { ...plan, slots }),
      runId,
      timestamp: 10 * i + 2,
    },
    makeMessage("answer-" + i, 10 * i + 3, { role: "assistant", runId, stopReason: "stop" }),
  ]);
  const result = cards(messages);
  expect(result.map((card) => card.rows.length)).toEqual([1, 1]);
  expect(result[0]?.key).not.toBe(result[1]?.key);
});

it("keeps the actual assistant card mounted while a planned job fails", async () => {
  installTranscriptDomMocks();
  const scheduled = liveTool("plan-call", "plan", { slots: plan.slots }, plan);
  const props = threadProps(
    "plan-progress",
    sessionKey,
    [makeMessage("prompt", 1, { role: "user", runId: "setup" })],
    {
      runId: "setup",
      runWorking: true,
      runActive: true,
      toolMessages: [scheduled],
      showToolCalls: false,
    },
  );
  const { container, transcript, rerender } = threadFixture(props);
  onTestFinished(() => {
    render(null, container);
    transcript.dispose();
    resetTranscriptTestDom();
  });
  rerender();
  const selector = ".chat-bubble .chat-created-automations";
  const card = await waitForSolid(() => {
    const node = container.querySelector(selector);
    expect(node).not.toBeNull();
    return node!;
  });
  const row = card.querySelector('[data-slot-id="a"]');
  expect(card.querySelectorAll(".chat-created-automations__switch-placeholder")).toHaveLength(2);
  props.toolMessages = [
    scheduled,
    liveTool("add-a", "add", { planId: plan.planId, slotId: "a" }, undefined, true),
  ];
  rerender();
  await waitForSolid(() => expect(card.textContent).toContain("Not created"));
  expect(container.querySelector(selector)).toBe(card);
  expect(card.querySelector('[data-slot-id="a"]')).toBe(row);
  expect(card.querySelectorAll(".chat-created-automations__switch-placeholder")).toHaveLength(1);
});

it.each([true, false])(
  "uses the same stable assistant slot for live tools and rehydrated history when showToolCalls=%s",
  (tools) => {
    const history = [makeMessage("prompt", 1, { role: "user", runId: "setup" })];
    const scheduled = liveTool("plan-call", "plan", { slots: plan.slots }, plan);
    const second = liveTool(
      "add-b",
      "add",
      { planId: plan.planId, slotId: "b" },
      { automationCreation: created },
    );
    const first = liveTool("add-a", "add", { planId: plan.planId, slotId: "a" }, undefined, true);
    const initial = cards(history, [scheduled], tools);
    expect(initial).toHaveLength(1);
    expect(initial[0]?.rows.map((r) => r.status)).toEqual(["pending", "pending"]);
    expect(cards(history, [scheduled, second], tools)[0]?.rows.map((r) => r.status)).toEqual([
      "pending",
      "created",
    ]);
    const settled = cards(history, [scheduled, second, first], tools);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.key).toBe(initial[0]?.key);
    expect(settled[0]?.rows.map((r) => r.status)).toEqual(["failed", "created"]);
    const durable = [scheduled, second, first].flatMap((m, i) => [
      makeMessage("call-" + i, 2 * i + 2, {
        role: "assistant",
        runId: "setup",
        content: [{ ...m.content[0], id: m.toolCallId }],
      }),
      makeMessage("result-" + i, 2 * i + 3, {
        role: "toolResult",
        runId: "setup",
        toolName: "automations",
        toolCallId: m.toolCallId,
        content: [],
        details: m.content[1]?.details,
        isError: m.content[1]?.isError,
      }),
    ]);
    const final = makeMessage("final", 10, {
      role: "assistant",
      runId: "setup",
      stopReason: "stop",
    });
    expect(cards([...history, ...projectChatDisplayMessages(durable), final], [], tools)).toEqual(
      settled,
    );
    expect(cards([...history, final], [scheduled], tools)[0]?.rows.map((r) => r.status)).toEqual([
      "failed",
      "failed",
    ]);
  },
);
