/* @vitest-environment jsdom */

import { createComponent, createSignal, merge } from "solid-js";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createNestedToolActivity } from "../../../../../src/sessions/nested-tool-activity.ts";
import { prepareChatHistoryFixture } from "../../../test-helpers/chat-activity-fixtures.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
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

it("commits a cached activity summary with its transcript row", () => {
  const group = createToolGroup("cached", [
    createMessageEntry(
      "cached-tool",
      createAssistantMessage([], { activity: [preparedOutcome("failed")] }),
    ),
  ]);
  activityRoot.render([group], visibleTools);
  const row = summaryContainer.querySelector('[data-chat-row-key="cached"]');
  expect(row).not.toBeNull();
  expect(row?.querySelector(".chat-activity-group__summary")?.textContent).toContain(
    "Attempted file reads",
  );
  expect(row?.querySelector(".chat-tool-failure")).toBeNull();
});

function read(id: string, overrides: Record<string, unknown> = {}) {
  return createToolCall(id, "read", { path: `/repo/${id}.ts` }, overrides);
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

it.each([
  { kind: "activity", prepareHistory: true },
  { kind: "work", prepareHistory: true },
  { kind: "activity", prepareHistory: false },
] as const)(
  "keeps parallel tool activity expandable without hover text ($kind, prepared=$prepareHistory)",
  async ({ kind, prepareHistory }) => {
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
      prepareHistory,
      messageGroup: true,
      onToggle,
    });
    const container = summaryContainer;
    expect(activity?.textContent).toContain(kind === "work" ? "Worked for 1s" : "Read files");
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

it.each(["anonymous", "missing-card", "matched"] as const)(
  "keeps a prepared failure visible in activity (%s)",
  async (pairing) => {
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
            error: "Permission denied",
          }),
        ],
      },
    );
    for (const expanded of [false, true]) {
      const summary = await renderSummary([message], "activity", { expanded });
      expect(summary?.textContent).toContain("Attempted file reads");
      expect(summary?.textContent).not.toContain("Some actions failed");
      expect(summaryContainer.querySelector(".chat-tool-failure") !== null).toBe(expanded);
      if (expanded && pairing !== "matched") {
        expect(summaryContainer.querySelector(".chat-activity-group__body")?.textContent).toContain(
          "Permission denied",
        );
      }
    }
  },
);

it("uses current prepared outcomes in activity summaries", async () => {
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
  const summary = await renderSummary([message], "activity");
  expect(summary?.textContent).toContain("Read files");
  expect(summary?.textContent).not.toContain("failed");
  expect(summary?.querySelector(".chat-tool-failure")).toBeNull();
});

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
  { outcome: "completed", isError: false },
  { outcome: "failed", isError: true },
])("draws a settled $outcome step whose nested calls are all routine", async ({ isError }) => {
  const runId = "step-run";
  const title = "Observe long check progress";
  const history = attachHistoryActivity(
    prepareChatHistoryFixture([
      createAssistantMessage(
        [
          createToolCall(
            "step",
            "exec",
            { title, code: "return await process({action: 'poll', sessionId: 'long-check'});" },
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
          toolCallId: "poll",
          toolName: "process",
          input: { action: "poll", sessionId: "long-check" },
          result: { content: [{ type: "text", text: "Verified batch 3" }] },
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
  expect(container.querySelector(".chat-activity-group__summary")).toBeNull();
  if (!isError) {
    expect(container.querySelector(".chat-tool-row")).toBeNull();
    await draw(true);
    expect(container.querySelector(".chat-tool-row")).toBeNull();
    return;
  }
  // The failed wrapper stays inspectable, with its routine child inside it.
  expect(container.querySelector(".chat-tool-disclosure__content")?.textContent).toMatch(/code/i);
  expect(container.querySelector(".chat-tool-failure")).not.toBeNull();
  expect(container.querySelector(".chat-tool-children")).toBeNull();
  await draw(true);
  expect(container.querySelectorAll(".chat-tool-children .chat-tool-row")).toHaveLength(1);
  expect(container.querySelectorAll(".chat-tool-children .chat-tool-wrapper-details")).toHaveLength(
    1,
  );
});

it.each([
  { source: "prepared outcome", expected: "Blocked" },
  { source: "paginated shell results", expected: "Ran commands" },
  { source: "recorded code inputs", expected: "Ran code" },
])("renders $source through transcript grouping", async ({ source, expected }) => {
  const messages =
    source === "prepared outcome"
      ? [createAssistantMessage([], { activity: [preparedOutcome("blocked")] })]
      : attachHistoryActivity(
          prepareChatHistoryFixture(
            [0, 1].map((index) => {
              const id = `call-${index}`;
              return source === "paginated shell results"
                ? createToolResultMessage(id, "bash", [{ type: "text", text: "ok" }], {
                    runId: "result-page",
                    isError: false,
                    details: { status: "completed", exitCode: 0 },
                  })
                : createAssistantMessage([
                    createToolCall(id, "exec", { code: "return 1;" }),
                    createToolResultBlock(id, "exec", "1", { isError: false }),
                  ]);
            }),
          ),
        ).messages;
  const { container, draw } = mountGroup(messages);
  await draw();
  expect(container.textContent).toContain(expected);
  expect(container.querySelector(".chat-bubble")).toBeNull();
});

it("keeps recorded child operations visible beside their execution's missing permission", async () => {
  const runId = "permission-after-read";
  const permissionMissing = {
    nodeId: "test-mac",
    command: "screen.capture",
    capabilities: ["screenRecording"],
    state: "denied",
  };
  const groups = prepareHistoryGroups([
    createToolGroup("permission", [
      createMessageEntry(
        "permission-entry",
        createAssistantMessage(
          [
            createToolCall(
              "parent",
              "exec",
              { code: "await tools.read({path: 'retained.ts'}); await tools.screen_capture();" },
              { runId },
            ),
            createToolCall(
              "child",
              "read",
              { path: "/repo/retained.ts" },
              { runId, parentToolCallId: "parent" },
            ),
            createToolResultBlock("child", "read", "Retained result", {
              runId,
              parentToolCallId: "parent",
              isError: false,
            }),
            createToolResultBlock("parent", "exec", "Permission needed", {
              runId,
              isError: true,
              details: { permissionMissing },
            }),
          ],
          { runId },
        ),
      ),
    ]),
  ]);
  activityRoot.render(groups, { ...visibleTools, isToolMessageExpanded: () => true });
  await settleToolBridges(summaryContainer);
  await waitForSolid(() =>
    expect(summaryContainer.querySelector(".chat-permission-card")).not.toBeNull(),
  );
  const childRow = summaryContainer.querySelector(".chat-tool-row");
  expect(childRow).not.toBeNull();
  expect(childRow!.textContent).toContain("retained.ts");
  expect(
    summaryContainer.querySelector(".chat-permission-card")?.closest(".chat-activity-group"),
  ).toBeNull();
});

it.each([
  { projection: "live receipt", name: "exec", args: { code: "await tools.ls({path: '.'})" } },
  { projection: "history projection", name: "exec", args: { code: "await tools.ls({path: '.'})" } },
  { projection: "live receipt", name: "process", args: { action: "poll", sessionId: "check" } },
  {
    projection: "history projection",
    name: "process",
    args: { action: "poll", sessionId: "check" },
  },
  {
    projection: "history projection with media",
    name: "process",
    args: { action: "poll", sessionId: "check" },
    media: true,
  },
])("retires a live $name row hidden by its $projection", async (testCase) => {
  const { projection, name, args } = testCase;
  const media = "media" in testCase;
  const runId = "live-nested";
  const draw = async (hidden: boolean, expanded = false) => {
    const content = [createToolCall("live-exec", name, args, { runId })];
    const message = createAssistantMessage(
      media
        ? [...content, { type: "image", data: "cG5n", mimeType: "image/png", alt: "Poll preview" }]
        : content,
      {
        runId,
        __openclawToolStreamLive: true,
        __openclawToolStreamItemEnded: hidden,
        activity:
          hidden && projection.startsWith("history projection")
            ? []
            : [
                {
                  itemId: "tool:live-exec",
                  toolCallId: "live-exec",
                  name,
                  kind: "tool",
                  title: name === "exec" ? "Exec" : "Process",
                  phase: hidden ? "end" : "start",
                  status: hidden ? "completed" : "running",
                  hideFromChannelProgress: hidden,
                },
              ],
      },
    );
    messageRoot.render(
      createToolGroup("before-narration", [createMessageEntry("live-exec", message)]),
      {
        ...visibleTools,
        runActive: true,
        activityRunId: runId,
        isToolMessageExpanded: () => expanded,
        isToolExpanded: () => expanded,
      },
    );
    await settleToolBridges(summaryContainer);
  };
  await draw(false);
  expect(summaryContainer.textContent).toContain(name === "exec" ? "Running code" : "Process");
  for (const expanded of [false, true]) {
    await draw(true, expanded);
    expect(summaryContainer.querySelector(".chat-activity-group__summary")).toBeNull();
    expect(summaryContainer.querySelector(".chat-tool-row")).toBeNull();
    if (media) {
      expect(summaryContainer.querySelector<HTMLImageElement>(".chat-message-image")?.src).toBe(
        "data:image/png;base64,cG5n",
      );
    }
  }
});

it("preserves prepared-only outcomes and an open group when a permission row arrives", async () => {
  const first = createMessageEntry(
    "first-outcome",
    createAssistantMessage([], {
      activity: [
        preparedOutcome("failed", "without-card", {
          title: "Read release.md",
          error: "Permission denied",
        }),
        preparedOutcome("completed", "another-call", { title: "Read release.md" }),
      ],
    }),
  );
  const permission = createMessageEntry(
    "permission",
    createAssistantMessage([
      createToolCall(
        "permission",
        "exec",
        { code: "await tools.screen_capture()" },
        {
          details: {
            permissionMissing: {
              nodeId: "test-mac",
              command: "screen.capture",
              capabilities: ["screenRecording"],
              state: "denied",
            },
          },
        },
      ),
    ]),
  );
  const last = createMessageEntry(
    "last-outcome",
    createAssistantMessage([], { activity: [preparedOutcome("blocked", "also-without-card")] }),
  );
  const expanded = new Set<string>();
  const draw = async (messages: Parameters<typeof createToolGroup>[1]) => {
    activityRoot.render([createToolGroup("retained-group", messages)], {
      ...visibleTools,
      isToolMessageExpanded: (key) => expanded.has(key),
      onToggleToolMessageExpanded: (key) => expanded.add(key),
    });
    await settleToolBridges(summaryContainer);
  };
  await draw([first]);
  const initial = summaryContainer.querySelector<HTMLButtonElement>(
    ".chat-activity-group__summary",
  )!;
  const bodyId = initial.getAttribute("aria-controls");
  initial.click();
  await draw([first]);
  expect(
    summaryContainer.querySelector(".chat-activity-group__summary")?.getAttribute("aria-expanded"),
  ).toBe("true");
  await draw([first, permission, last]);
  const summaries = [...summaryContainer.querySelectorAll(".chat-activity-group__summary")];
  expect(summaries).toHaveLength(2);
  expect(summaries[0]?.textContent).not.toContain("Some actions failed");
  const rows = [...summaryContainer.querySelectorAll(`#${bodyId} .chat-tool-row`)];
  expect(
    rows.map((row) => row.querySelector(".chat-tool-row__title")?.textContent?.trim()),
  ).toEqual(["Read release.md", "Read release.md"]);
  expect(rows[0]?.textContent).toContain("failed");
  expect(rows[1]?.textContent).toContain("Completed");
  expect(summaryContainer.querySelector(`#${bodyId}`)?.textContent).toContain("Permission denied");
  expect(summaries[1]?.textContent).toContain("Blocked");
  expect(summaries[0]?.getAttribute("aria-expanded")).toBe("true");
  expect(summaries[0]?.getAttribute("aria-controls")).toBe(bodyId);
  const permissionCard = summaryContainer.querySelector(".chat-permission-card")!;
  expect(permissionCard).not.toBeNull();
  expect(
    summaries[0]!.compareDocumentPosition(permissionCard) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    permissionCard.compareDocumentPosition(summaries[1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
