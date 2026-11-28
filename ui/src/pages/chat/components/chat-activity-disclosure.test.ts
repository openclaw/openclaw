/* @vitest-environment jsdom */

import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createNestedToolActivity } from "../../../../../src/sessions/nested-tool-activity.ts";
import { prepareChatHistoryFixture } from "../../../test-helpers/chat-activity-fixtures.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { attachHistoryActivity } from "../chat-history-snapshot.ts";
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

let summaryContainer: HTMLDivElement;
let activityRoot: ReturnType<typeof createActivityGroupHarness>;
let messageRoot: ReturnType<typeof createMessageGroupHarness>;
beforeEach(() => {
  summaryContainer = document.body.appendChild(document.createElement("div"));
  activityRoot = createActivityGroupHarness(summaryContainer);
  messageRoot = createMessageGroupHarness(summaryContainer);
  onTestFinished(() => summaryContainer.remove());
});
const visibleTools = { showToolCalls: true, showReasoning: true };
const permissionMissing = {
  nodeId: "test-mac",
  command: "screen.capture",
  capabilities: ["screenRecording"],
  state: "denied",
};

it("commits a cached activity summary with its transcript row", () => {
  const group = createToolGroup("cached", [
    createMessageEntry(
      "cached-tool",
      createAssistantMessage([], { activity: [preparedOutcome("failed")] }),
    ),
  ]);
  activityRoot.render([group], visibleTools);
  const row = summaryContainer.querySelector('[data-chat-row-key="cached"]');
  expect(row?.querySelector(".chat-activity-group__summary")?.textContent).toContain("File reads");
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
  options: {
    expanded?: boolean;
    prepareHistory?: boolean;
    messageGroup?: boolean;
    onToggle?: () => void;
  } = {},
) {
  let groups = [
    createToolGroup(
      "history",
      messages.map((message, index) => createMessageEntry(`message-${index}`, message)),
    ),
  ];
  if (options.prepareHistory) {
    groups = prepareHistoryGroups(groups);
  }
  const renderOptions = {
    ...visibleTools,
    isToolMessageExpanded: () => options.expanded ?? false,
    onToggleToolMessageExpanded: options.onToggle,
  };
  if (options.messageGroup) {
    messageRoot.render(groups[0]!, renderOptions);
  } else {
    activityRoot.render(groups, renderOptions);
  }
  flush();
  await settleToolBridges(summaryContainer);
  return summaryContainer.querySelector<HTMLElement>(".chat-activity-group__summary");
}

it.each([true, false])(
  "keeps parallel tool activity expandable without hover text (prepared=%s)",
  async (prepareHistory) => {
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
    const activity = await renderSummary(messages, {
      prepareHistory,
      messageGroup: true,
      onToggle,
    });
    const container = summaryContainer;
    expect(activity?.textContent).toContain("Read files");
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
      const summary = await renderSummary([message], { expanded });
      if (pairing === "matched") {
        expect(summary).toBeNull();
        expect(summaryContainer.querySelector(".chat-tool-row")?.textContent).toContain(
          "call-failed.ts",
        );
      } else {
        expect(summary?.textContent).toContain("File reads");
      }
      expect(summaryContainer.querySelector(".chat-tool-failure") !== null).toBe(
        expanded || pairing === "matched",
      );
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
  const summary = await renderSummary([message]);
  expect(summary).toBeNull();
  expect(summaryContainer.querySelector(".chat-tool-row")?.textContent).toContain("one.ts");
  expect(summaryContainer.querySelector(".chat-tool-failure")).toBeNull();
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
  expect(container.querySelector(".chat-tool-disclosure__content")?.textContent).toBe(title);
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
  { source: "code failed after dispatch", dispatched: true, expected: "Ran commands" },
  { source: "code rejected before dispatch", dispatched: false, expected: "Commands" },
])("renders $source through transcript grouping", async ({ source, dispatched, expected }) => {
  const messages =
    source === "prepared outcome"
      ? [createAssistantMessage([], { activity: [preparedOutcome("blocked")] })]
      : attachHistoryActivity(
          prepareChatHistoryFixture(
            [0, 1].flatMap<Record<string, unknown>>((index) => {
              const id = `call-${index}`;
              if (dispatched === undefined) {
                return createToolResultMessage(id, "bash", [{ type: "text", text: "ok" }], {
                  runId: "result-page",
                  isError: false,
                  details: { status: "completed", exitCode: 0 },
                });
              }
              // The recorded JSON result, not details, says whether the bridge dispatched.
              const result = { status: "failed", bridgeDispatchStarted: dispatched };
              return [
                createAssistantMessage([createToolCall(id, "exec", { code: "return 1;" })]),
                createToolResultMessage(
                  id,
                  "exec",
                  [{ type: "text", text: JSON.stringify(result) }],
                  {
                    isError: true,
                  },
                ),
              ];
            }),
          ),
        ).messages;
  const { container, draw } = mountGroup(messages);
  await draw();
  expect(container.textContent).toContain(expected);
});

it("keeps recorded child operations visible beside their execution's missing permission", async () => {
  const runId = "permission-after-read";
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
  expect(childRow?.textContent).toContain("retained.ts");
  expect(
    summaryContainer.querySelector(".chat-permission-card")?.closest(".chat-activity-group"),
  ).toBeNull();
});

it("retires a live row hidden by its history projection without dropping its image", async () => {
  const runId = "live-nested";
  const draw = async (hidden: boolean, expanded = false) => {
    const message = createAssistantMessage(
      [
        createToolCall("live", "process", { action: "poll", sessionId: "check" }, { runId }),
        { type: "image", data: "cG5n", mimeType: "image/png", alt: "Poll preview" },
      ],
      {
        runId,
        __openclawToolStreamLive: true,
        __openclawToolStreamItemEnded: hidden,
        activity: hidden
          ? []
          : [
              {
                itemId: "tool:live",
                toolCallId: "live",
                name: "process",
                kind: "tool",
                title: "Process",
                phase: "start",
                status: "running",
              },
            ],
      },
    );
    messageRoot.render(createToolGroup("live", [createMessageEntry("live", message)]), {
      ...visibleTools,
      runActive: true,
      activityRunId: runId,
      isToolMessageExpanded: () => expanded,
      isToolExpanded: () => expanded,
    });
    await settleToolBridges(summaryContainer);
  };
  await draw(false);
  expect(summaryContainer.querySelector(".chat-activity-group__summary")?.textContent).toContain(
    "Using tools",
  );
  for (const expanded of [false, true]) {
    await draw(true, expanded);
    expect(summaryContainer.querySelector(".chat-activity-group__summary")).toBeNull();
    expect(summaryContainer.querySelector(".chat-tool-row")).toBeNull();
    expect(summaryContainer.querySelector<HTMLImageElement>(".chat-message-image")?.src).toBe(
      "data:image/png;base64,cG5n",
    );
  }
});

it("preserves prepared-only outcomes and an open group when a permission row arrives", async () => {
  const first = createMessageEntry(
    "first-outcome",
    createAssistantMessage([], {
      activity: [
        preparedOutcome("failed", "without-card", { title: "Read", error: "Permission denied" }),
        preparedOutcome("completed", "another-call", { title: "Read" }),
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
        { details: { permissionMissing } },
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
  await draw([first, permission, last]);
  // The earlier segment keeps its body and open state; prepared-only rows survive the split.
  const summaries = [...summaryContainer.querySelectorAll(".chat-activity-group__summary")];
  expect(summaries.map((summary) => summary.getAttribute("aria-expanded"))).toEqual([
    "true",
    "false",
  ]);
  expect(summaries[0]?.getAttribute("aria-controls")).toBe(bodyId);
  expect(summaryContainer.querySelectorAll(`#${bodyId} .chat-tool-row`)).toHaveLength(2);
  expect(summaries[1]?.textContent).toContain("Blocked");
  const permissionCard = summaryContainer.querySelector(".chat-permission-card")!;
  const follows = (a: Node, b: Node) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
  expect(
    follows(summaries[0]!, permissionCard) && follows(permissionCard, summaries[1]!),
  ).toBeTruthy();
});

it("keeps expanded historical launches readable when a new launch refreshes activity", async () => {
  const launch = (id: string, runId: string, completed: boolean) =>
    createAssistantMessage(
      [
        createToolCall(id, "sessions_spawn", { label: id, task: `Review ${id}` }),
        ...(completed
          ? [
              createToolResultBlock(
                id,
                "sessions_spawn",
                JSON.stringify({
                  status: "accepted",
                  childSessionKey: `agent:main:subagent:${id}`,
                }),
                { isError: false },
              ),
            ]
          : []),
      ],
      { runId },
    );
  const draw = async (later?: boolean) => {
    const earlier = createToolGroup(
      "earlier",
      [
        createAssistantMessage([
          read("retained"),
          createToolResultBlock("retained", "read", "", { isError: false }),
        ]),
        ...["Alfa", "Beta", "Gama"].map((label) => launch(label, "first-run", true)),
      ].map((message, index) => createMessageEntry(`old-${index}`, message)),
    );
    const next = createToolGroup("later", [
      createMessageEntry("new", launch("Delta", "second-run", later === true)),
    ]);
    activityRoot.render(prepareHistoryGroups(later === undefined ? [earlier] : [earlier, next]), {
      ...visibleTools,
      isToolMessageExpanded: () => true,
      runActive: later === false,
      activityRunId: "second-run",
      isToolExpanded: () => true,
    });
    await settleToolBridges(summaryContainer);
  };
  const alfaRow = () =>
    [...summaryContainer.querySelectorAll(".chat-tool-row")].find((row) =>
      row.textContent?.includes("Alfa"),
    );
  await draw();
  const historicalRow = alfaRow();
  expect(historicalRow).toBeDefined();
  for (const later of [false, true]) {
    await draw(later);
    expect(summaryContainer.textContent).not.toContain("Couldn’t load");
    expect(alfaRow()).toBe(historicalRow);
    for (const label of ["retained.ts", "Gama", "Delta"]) {
      expect(summaryContainer.textContent).toContain(label);
    }
  }
});

it("groups child-chat openings with file activity while keeping autonomous launches separate", async () => {
  const childKey = "agent:main:dashboard:child";
  const launch = (id: string, visible: boolean) =>
    createMessageEntry(
      id,
      createAssistantMessage([
        createToolCall(id, "sessions_spawn", { label: id, task: "Read the sources.", visible }),
        createToolResultBlock(
          id,
          "sessions_spawn",
          JSON.stringify({
            status: "accepted",
            childSessionKey: visible ? childKey : "agent:main:subagent:worker",
          }),
          { isError: false },
        ),
      ]),
    );
  const group = createToolGroup("mixed-work", [
    createMessageEntry("read", createAssistantMessage([read("source")])),
    launch("Child", true),
    createMessageEntry(
      "write",
      createAssistantMessage([
        createToolCall("write", "write", { path: "/repo/result.ts", content: "done" }),
      ]),
    ),
    launch("Worker", false),
  ]);
  const onOpenSession = vi.fn();
  const draw = async (expanded: boolean) => {
    activityRoot.render(prepareHistoryGroups([group]), {
      ...visibleTools,
      isToolMessageExpanded: () => expanded,
      subagents: { onOpenSession },
    });
    await settleToolBridges(summaryContainer);
  };
  await draw(false);
  expect(summaryContainer.querySelectorAll(".chat-activity-group__summary")).toHaveLength(1);
  expect(summaryContainer.textContent).not.toContain("Opened child chat");
  expect(summaryContainer.textContent).toContain("Launched Worker");
  await draw(true);
  expect(summaryContainer.textContent).toContain("Opened child chat");
  expect(summaryContainer.textContent).toContain("source.ts");
  expect(summaryContainer.textContent).toContain("result.ts");
  const childLink = [
    ...summaryContainer.querySelectorAll<HTMLButtonElement>(".chat-tool-row__subagent-link"),
  ].find((link) => link.textContent === "Child")!;
  childLink.click();
  expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(childKey);
});

it.each([
  { status: "answered", grouped: true, wrapped: false },
  { status: "answered", grouped: true, wrapped: true },
  { status: "ready_to_verify", grouped: true, wrapped: false },
  { status: "pending", grouped: false, wrapped: false },
  { status: "cancelled", grouped: false, wrapped: false },
  { status: "expired", grouped: false, wrapped: false },
  { status: "action_unresolved", grouped: false, wrapped: false },
  { status: undefined, grouped: false, wrapped: false },
])(
  "groups only answered questions ($status, wrapped=$wrapped)",
  async ({ status, grouped, wrapped }) => {
    const args = {
      questions: [{ questionId: "format", header: "Format", question: "Which format?" }],
    };
    const details = {
      status,
      ...(status === "answered" ? { answers: { answers: { format: ["Markdown"] } } } : {}),
    };
    const output = status === "answered" ? "Format: Markdown" : (status ?? "Requested");
    const result = { content: [{ type: "text", text: output }], details };
    const name = wrapped ? "tool_call" : "ask_user";
    const group = createToolGroup("question-work", [
      createMessageEntry("before-question", createAssistantMessage([read("before")])),
      createMessageEntry(
        "question",
        createAssistantMessage([
          createToolCall("ask", name, wrapped ? { id: "openclaw:core:ask_user", args } : args),
          createToolResultBlock(
            "ask",
            name,
            wrapped ? JSON.stringify({ tool: { name: "ask_user" }, result }) : output,
            { isError: false, ...(wrapped ? {} : { details }) },
          ),
        ]),
      ),
      createMessageEntry("after-question", createAssistantMessage([read("after")])),
    ]);
    const draw = async (expanded: boolean) => {
      activityRoot.render(prepareHistoryGroups([group]), {
        ...visibleTools,
        isToolMessageExpanded: () => expanded,
        isToolExpanded: () => expanded,
      });
      await settleToolBridges(summaryContainer);
    };
    await draw(false);
    expect(summaryContainer.querySelectorAll(".chat-activity-group__summary")).toHaveLength(
      grouped ? 1 : 2,
    );
    await draw(true);
    expect(summaryContainer.textContent).toContain("Which format?");
    expect(summaryContainer.textContent).toContain(output);
  },
);
