/* @vitest-environment jsdom */

import { createComponent, createSignal, merge } from "solid-js";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createNestedToolActivity } from "../../../../../src/sessions/nested-tool-activity.ts";
import { prepareChatHistoryFixture } from "../../../test-helpers/chat-activity-fixtures.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { attachHistoryActivity } from "../chat-history-request.ts";
import { buildChatItems } from "../chat-thread-build.ts";
import { createProps } from "../chat-thread.test-support.ts";
import {
  createActivityGroupHarness,
  createMessageGroupHarness,
} from "./chat-message-native.test-support.tsx";
import {
  createAssistantMessage,
  createMessageEntry,
  createToolCall,
  createToolGroup,
  createToolResultBlock,
  createToolResultMessage,
  prepareHistoryGroups,
} from "./chat-message.test-support.ts";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";
import { WorkGroupSummary } from "./chat-work-group-summary.tsx";

type WorkProps = Parameters<typeof WorkGroupSummary>[0];
let summaryContainer: HTMLDivElement;
let updateSummary: ((state: WorkProps) => void) | undefined;
let activityRoot: ReturnType<typeof createActivityGroupHarness>;
let messageRoot: ReturnType<typeof createMessageGroupHarness>;
beforeEach(() => {
  summaryContainer = document.body.appendChild(document.createElement("div"));
  updateSummary = undefined;
  activityRoot = createActivityGroupHarness(summaryContainer);
  messageRoot = createMessageGroupHarness(summaryContainer);
  onTestFinished(() => summaryContainer.remove());
});
const visibleTools = { showToolCalls: true, showReasoning: true };

function read(id: string, overrides: Record<string, unknown> = {}) {
  return createToolCall(id, "read", { path: `/repo/${id}.ts` }, overrides);
}

function readResult(id: string, isError = true, overrides: Record<string, unknown> = {}) {
  return createToolResultMessage(id, "read", "Result", { isError, ...overrides });
}

function mountGroup(messages: Record<string, unknown>[]) {
  const group = buildChatItems(createProps({ messages })).find((item) => item.kind === "group");
  if (group?.kind !== "group") {
    throw new Error("expected a tool group");
  }
  const container = summaryContainer;
  return {
    container,
    draw: async (expanded = false) => {
      messageRoot.render(group, {
        ...visibleTools,
        showReasoning: false,
        isToolExpanded: () => expanded,
      });
      await settleToolBridges(container);
    },
  };
}

async function renderSummary(
  messages: Record<string, unknown>[],
  kind: "activity" | "work",
  options: {
    expanded?: boolean;
    durationMs?: number | null;
    prepareHistory?: boolean;
    messageGroup?: boolean;
    onToggle?: () => void;
  } = {},
) {
  const { expanded = false, durationMs = 1000 } = options;
  const container = summaryContainer;
  let groups = [
    createToolGroup(
      "history",
      messages.map((message, index) => createMessageEntry(`message-${index}`, message)),
    ),
  ];
  if (options.prepareHistory) {
    groups = prepareHistoryGroups(groups);
  }
  if (kind === "activity") {
    const renderOptions = {
      ...visibleTools,
      isToolMessageExpanded: () => expanded,
      onToggleToolMessageExpanded: options.onToggle,
    };
    if (options.messageGroup) {
      messageRoot.render(groups[0]!, renderOptions);
    } else {
      activityRoot.render(groups, renderOptions);
    }
  } else {
    const next = {
      item: { key: "work", durationMs, groups },
      options: { expanded, onToggle: options.onToggle ?? (() => {}) },
    };
    if (updateSummary) {
      updateSummary(next);
    } else {
      mountSolid(
        () => {
          const [state, setState] = createSignal<WorkProps>(next);
          updateSummary = setState;
          return createComponent(WorkGroupSummary, merge(state));
        },
        { container },
      );
    }
  }
  flush();
  await settleToolBridges(container);
  return container.querySelector<HTMLElement>(".chat-activity-group__summary");
}

it.each(["activity", "work"] as const)(
  "keeps parallel tool activity expandable without hover text (%s)",
  async (kind) => {
    const messages = [
      createAssistantMessage(
        [
          read("call-a", { type: "toolCall" }),
          read("call-b", { type: "toolCall" }),
          createToolResultBlock("call-a", "read", "File A", { isError: false }),
          createToolResultBlock("call-b", "read", "File B", { isError: false }),
        ],
        { timestamp: 1000 },
      ),
    ];
    const onToggle = vi.fn();
    const activity = await renderSummary(messages, kind, {
      prepareHistory: true,
      messageGroup: true,
      onToggle,
    });
    const container = summaryContainer;
    expect(activity?.textContent).toContain(kind === "work" ? "Worked for 1 second" : "2 reads");
    if (kind === "work") {
      expect(activity?.textContent).not.toContain("tool calls");
      expect(activity?.textContent).not.toContain("failed");
    }
    expect(activity?.querySelector("[title], [data-tooltip], openclaw-tooltip")).toBeNull();
    expect(activity?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll(".chat-activity-group")).toHaveLength(1);
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
    activity?.click();
    expect(onToggle).toHaveBeenCalledOnce();
  },
);

it.each([
  ["activity", "anonymous"],
  ["activity", "missing-card"],
  ["activity", "matched"],
  ["work", "anonymous"],
  ["work", "missing-card"],
  ["work", "matched"],
] as const)(
  "retains prepared failures exactly once in %s summaries (%s)",
  async (kind, pairing) => {
    const message = createAssistantMessage(
      pairing === "missing-card"
        ? [{ type: "text", text: "Operation details unavailable" }]
        : [
            read("call-failed"),
            createToolResultBlock("call-failed", "read", "Permission denied", { isError: true }),
          ],
      {
        activity: [
          preparedOutcome("failed", pairing === "matched" ? "call-failed" : null, {
            itemId: "prepared-failure",
            title: "Read file",
          }),
        ],
      },
    );
    for (const expanded of [false, true]) {
      const summary = await renderSummary([message], kind, { expanded });
      expect(summary?.textContent).toContain(kind === "work" ? "Worked for 1 second" : "1 read");
      expect(summary?.textContent?.match(/1 failed/gu)).toHaveLength(1);
      if (kind === "work") {
        expect(summary?.textContent?.includes("1 tool call")).toBe(expanded);
      }
    }
  },
);

it.each(["activity", "work"] as const)(
  "uses current prepared outcomes in %s summaries",
  async (kind) => {
    const completed = preparedOutcome("completed", "one", { itemId: "call:one" });
    const message = createAssistantMessage(
      [
        read("one"),
        createToolResultBlock("one", "read", "Older error projection", { isError: true }),
      ],
      {
        activity: [
          { ...completed, status: "failed" },
          completed,
          {
            ...completed,
            itemId: "suppressed",
            toolCallId: "suppressed",
            status: "failed",
            suppressChannelProgress: true,
          },
          { ...completed, itemId: "quiet", toolCallId: "quiet", hideFromChannelProgress: true },
        ],
      },
    );
    const summary = await renderSummary([message], kind);
    expect(summary?.textContent).toContain(kind === "work" ? "Worked for 1 second" : "1 read");
    expect(summary?.textContent).not.toContain("failed");
    if (kind === "work") {
      expect(summary?.textContent).not.toContain("tool call");
      expect(summary?.querySelector(".chat-work-group__outcomes")).toBeNull();
    }
    expect(summary?.querySelector(".chat-tool-failure")).toBeNull();
  },
);

it.each(["blocked", "skipped", undefined] as const)(
  "retains %s outcomes when completed work is expanded",
  async (status) => {
    const message = createAssistantMessage([], {
      activity: [preparedOutcome("completed", null, { itemId: "outcome", status })],
    });
    for (const expanded of [false, true]) {
      const summary = await renderSummary([message], "work", { expanded });
      expect(summary?.textContent).toContain("Worked for 1 second");
      expect(summary?.textContent?.includes("1 tool call")).toBe(expanded);
      expect(summary?.textContent).toContain(`1 ${status ?? "unknown"}`);
      if (status === "skipped") {
        expect(summary?.textContent?.match(/1 skipped/g)).toHaveLength(1);
        expect(summary?.textContent).not.toMatch(/blocked|failed/);
      }
    }
  },
);

it.each([0, 10])("keeps failures visible without a duration (%i calls)", async (total) => {
  const message = createAssistantMessage(
    Array.from({ length: total }).flatMap((_, index) => [
      read(`call-${index}`),
      createToolResultBlock(`call-${index}`, "read", index < 2 ? "Unavailable" : "Loaded", {
        isError: index < 2,
      }),
    ]),
  );
  const summary = await renderSummary(total ? [message] : [], "work", {
    durationMs: null,
    prepareHistory: true,
  });
  const text = summary?.textContent?.replace(/\s+/gu, " ").trim();
  expect(text).toBe(total ? "Worked · 2 failed" : "Worked");
});

async function workSummaryText(messages: Record<string, unknown>[]) {
  return (await renderSummary(messages, "work", { durationMs: null, expanded: true }))?.textContent
    ?.replace(/\s+/gu, " ")
    .trim();
}

function preparedOutcome(
  status = "completed",
  toolCallId: string | null = "prepared",
  overrides: Record<string, unknown> = {},
) {
  return {
    itemId: `tool:${toolCallId}`,
    toolCallId: toolCallId ?? undefined,
    kind: "tool",
    phase: "end",
    name: "read",
    title: "Read",
    status,
    ...overrides,
  };
}

it.each([
  {
    name: "anonymous calls stay distinct",
    messages: [true, false].map((isError) => ({
      role: "toolResult",
      toolName: "exec",
      content: isError ? "Command failed" : "Command completed",
      isError,
    })),
    expected: "Worked · 2 tool calls · 1 failed",
  },
  ...[false, true].map((reverse) => {
    const prepared = readResult("prepared", true, { activity: [preparedOutcome()] });
    const messages = [
      createAssistantMessage([createToolCall("prepared", "read", {})]),
      prepared,
      createAssistantMessage([createToolCall("raw", "read", {})]),
      readResult("raw"),
    ];
    if (reverse) {
      messages.splice(0, 2, prepared, messages[0]!);
    }
    return {
      name: `mixed history, reverse=${reverse}`,
      messages,
      expected: "Worked · 2 tool calls · 1 failed",
    };
  }),
  ...["empty", "hidden", "suppressed"].map((kind) => ({
    name: `${kind} prepared calls stay hidden`,
    messages: [
      createAssistantMessage([createToolCall("quiet", "read", {})]),
      readResult("quiet", true, {
        activity:
          kind === "empty"
            ? []
            : [
                preparedOutcome("failed", "quiet", {
                  [kind === "hidden" ? "hideFromChannelProgress" : "suppressChannelProgress"]: true,
                }),
              ],
      }),
      readResult("visible"),
    ],
    expected: "Worked · 1 tool call · 1 failed",
  })),
  ...["raw", "blocked", "skipped"].map((kind) => ({
    name: `${kind} steering skip`,
    messages: [
      createToolResultMessage("skip", "exec", "Skipped", {
        details: { status: "skipped", deniedReason: "steering" },
        ...(kind === "raw"
          ? {}
          : {
              activity: [
                preparedOutcome(kind === "blocked" ? "blocked" : "skipped", "skip", {
                  name: "exec",
                  title: "Command",
                }),
              ],
            }),
      }),
    ],
    expected: `Worked · 1 tool call · 1 ${kind === "blocked" ? "blocked" : "skipped"}`,
  })),
  {
    name: "unresolved anonymous raw call",
    messages: [
      createAssistantMessage([{ type: "toolCall", name: "exec", arguments: { command: "pwd" } }]),
    ],
    expected: "Worked · 1 tool call · 1 unknown",
  },
])("summarizes work outcomes: $name", async ({ messages, expected }) => {
  expect(await workSummaryText(messages)).toBe(expected);
});

it.each([
  { outcome: "completed", isError: false },
  { outcome: "failed", isError: true },
])("draws a settled $outcome step whose nested calls are all routine", async ({ isError }) => {
  const runId = "step-run";
  const title = "Check the release checklist";
  const history = attachHistoryActivity(
    prepareChatHistoryFixture([
      createAssistantMessage(
        [
          createToolCall(
            "step",
            "exec",
            { title, code: "await tools.progress_card({ plan });" },
            { type: "toolCall", runId },
          ),
        ],
        { runId, timestamp: 2_000 },
      ),
      {
        ...createNestedToolActivity({
          runId,
          scopeId: "step-scope",
          afterEntryId: "step-call",
          startOrder: 1,
          parentToolCallId: "step",
          toolCallId: "plan",
          toolName: "progress_card",
          input: { plan: [{ step: title, status: "in_progress" }] },
          result: { content: [{ type: "text", text: "Updated" }] },
          isError: false,
          startedAt: 2_100,
          timestamp: 2_200,
        }),
        runId,
        __openclaw: { runId },
      },
      createToolResultMessage("step", "exec", [{ type: "text", text: "Checked" }], {
        runId,
        isError,
        timestamp: 3_000,
      }),
    ]),
  );
  const { container, draw } = mountGroup(history.messages);
  await draw(false);
  if (isError) {
    const summary = container.querySelector(".chat-activity-group__summary");
    expect(summary?.textContent).toContain("1 command");
    expect(summary?.textContent).toContain("1 failed");
    expect(container.querySelector(".chat-tool-row__title")).toBeNull();
    return;
  }
  expect(container.querySelector(".chat-activity-group__summary")).toBeNull();
  expect(container.querySelector(".chat-tool-row__title")?.textContent).toBe(title);
  expect(container.querySelector(".chat-progress-card-receipt")).toBeNull();
  await draw(true);
  expect(
    container.querySelectorAll(".chat-tool-children .chat-progress-card-receipt"),
  ).toHaveLength(1);
  expect(container.querySelectorAll(".chat-tool-children .chat-tool-wrapper-details")).toHaveLength(
    1,
  );
});

it("renders a prepared outcome with no raw tool blocks through transcript grouping", async () => {
  const message = createAssistantMessage([], { activity: [preparedOutcome("blocked")] });
  const { container, draw } = mountGroup([message]);
  await draw();
  expect(container.textContent).toContain("1 blocked");
  expect(container.querySelector(".chat-bubble")).toBeNull();
});
