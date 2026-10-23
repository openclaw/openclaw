/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { projectAgentToolActivity } from "../../../../../src/infra/agent-activity-events.js";
import { ApplicationProvider } from "../../../lib/reactive/context.ts";
import { prepareChatHistoryFixture } from "../../../test-helpers/chat-activity-fixtures.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { attachHistoryActivity } from "../chat-history-request.ts";
import { createInitializationContext } from "../chat-pane.test-support.ts";
import {
  createChatMessageHarness,
  type RenderMessageGroupOptions,
  buildItems,
} from "./chat-message-render.test-support.tsx";
import {
  createAssistantMessage,
  createToolResultBlock,
  createAssistantCanvasBlock,
  createToolCall,
  createToolResultMessage,
  prepareHistoryGroups,
  createMessageGroup,
  createMessageEntry,
  createToolGroup,
  type TestMessage,
} from "./chat-message.test-support.ts";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";

const harness = createChatMessageHarness();
const {
  renderActivityGroup,
  requireElement,
  element,
  elements,
  elementText,
  expectCount,
  expectAbsent,
  expectPresent,
  renderToolMessage,
  renderToolGroups,
  renderGroupedMessage,
  markdownRenderMock,
} = harness;

describe("grouped chat rendering", () => {
  function toolFixture(message: unknown, grouped = false) {
    document.body.append(harness.view);
    const groups = grouped ? [createMessageGroup(message, "tool")] : [];
    return (expanded: boolean, options: Partial<RenderMessageGroupOptions> = {}) =>
      grouped
        ? renderToolGroups(groups, { isToolMessageExpanded: () => expanded, ...options })
        : renderToolMessage(message, { isToolExpanded: () => expanded, ...options });
  }

  function toolResultEntry(key: string, ...args: Parameters<typeof createToolResultMessage>) {
    return createMessageEntry(key, createToolResultMessage(...args));
  }

  function toolResultGroup(...args: Parameters<typeof createToolResultMessage>) {
    return createMessageGroup(createToolResultMessage(...args), "tool");
  }

  function expectCanvasWidget(
    container: Element,
    expected: { docId: string; title: string; preferredHeight?: number; sessionKey?: string },
  ) {
    expect(container.querySelectorAll("openclaw-canvas-widget-view")).toHaveLength(1);
    const widget = requireElement("openclaw-canvas-widget-view", HTMLElement, container);
    expect(widget).toMatchObject(expected);
    expect(container.querySelector(".chat-tool-card__preview-panel > iframe")).toBeNull();
    return widget;
  }

  it("counts one exec and one wait across completed history, live snapshots, and separated activity groups", async () => {
    document.body.append(harness.view);
    const messages: TestMessage[] = [];
    const toolMessages: TestMessage[] = [];
    for (const [index, name] of ["exec", "wait"].entries()) {
      const toolCallId = `call-${name}`;
      const activity = [
        projectAgentToolActivity({ toolCallId, name, phase: "result", isError: false }),
      ];
      const args = name === "exec" ? { command: "echo ready" } : { runId: "cell-1" };
      const call = { type: "toolcall", name, id: toolCallId, arguments: args };
      const result = { type: "toolresult", name, id: toolCallId, text: `${name} finished` };
      messages.push(
        createAssistantMessage([call], { runId: "run-count", timestamp: index * 10 + 1, activity }),
      );
      messages.push(
        createToolResultMessage(toolCallId, name, `${name} finished`, {
          runId: "run-count",
          activity,
          timestamp: index * 10 + 2,
        }),
      );
      toolMessages.push(
        createAssistantMessage([call, result], {
          runId: "run-count",
          activity,
          toolCallId,
          timestamp: index * 10 + 1,
          __openclawToolStreamLive: true,
          __openclawToolStreamResultReceived: true,
        }),
      );
    }
    messages.push(
      createToolResultMessage("call-wait", "wait", "wait finished", {
        runId: "run-count",
        timestamp: 30,
        activity: [
          projectAgentToolActivity({
            toolCallId: "call-wait",
            name: "wait",
            phase: "result",
            isError: false,
          }),
        ],
      }),
    );
    const items = buildItems({
      paneId: "counting",
      runId: "run-count",
      messages,
      toolMessages,
      streamSegments: [{ text: "Resuming the cell", ts: 8, itemId: "between", runId: "run-count" }],
    });
    const groups = items.filter((item) => item.kind === "group");
    expect(items.filter((item) => item.kind === "stream")).toHaveLength(1);
    renderActivityGroup(groups, { showReasoning: false, isToolMessageExpanded: () => true });
    await settleToolBridges(harness.view);
    expect(elementText(".chat-activity-group__label")?.trim()).toBe(
      "1 command · 1 other operation",
    );
    expectCount(".chat-tool-row", 2);
  });

  it("renders a persisted call with an unknown outcome until its matching result arrives", async () => {
    document.body.append(harness.view);
    const call = createAssistantMessage(
      [createToolCall("orphan", "exec", { command: "check-workspace" })],
      { __openclaw: { id: "orphan-call", runId: "historic-run" } },
    );
    const renderHistory = async (messages: TestMessage[]) => {
      const history = attachHistoryActivity(prepareChatHistoryFixture(messages));
      const items = buildItems({
        paneId: "unknown-historic-outcome",
        messages: history.messages,
      });
      renderActivityGroup(
        items.filter((item) => item.kind === "group"),
        {
          showReasoning: false,
          runActive: false,
          isToolMessageExpanded: () => true,
          isToolExpanded: () => true,
        },
      );
      await settleToolBridges(harness.view);
      return history;
    };
    const unknown = await renderHistory([call]);
    expect(unknown.activity[0]?.items[0]).toMatchObject({
      phase: "end",
      summary: "Outcome unknown",
    });
    expect(unknown.activity[0]?.items[0]).not.toHaveProperty("status");
    expect(elementText(".chat-activity-group__label")).toBe("1 command · 1 unknown");
    expectAbsent(".chat-tool-row--running");
    expect(harness.view.textContent).toContain("check-workspace");

    const completed = await renderHistory([
      call,
      createToolResultMessage("orphan", "exec", "Workspace checked.", {
        isError: false,
        __openclaw: { id: "orphan-result", runId: "historic-run" },
      }),
    ]);
    expect(completed.activity[0]?.items[0]).toMatchObject({ phase: "end", status: "completed" });
    expect(elementText(".chat-activity-group__label")).toBe("1 command");
    expect(harness.view.textContent).not.toContain("outcome unknown");
    expect(harness.view.textContent).toContain("Workspace checked.");
    expectCount(".chat-tool-row", 1);
    expectAbsent(".chat-tool-row--running");
  });

  it("keeps a persisted tool review icon-only until its command activity expands", async () => {
    document.body.append(harness.view);
    const group = createToolGroup("reviewed-tool-group", [
      toolResultEntry("reviewed-tool-message", "call-reviewed", "run_command", "completed", {
        details: {
          approvalReviews: [
            {
              id: "review-1",
              label: "Guardian",
              status: "approved",
              riskLevel: "low",
              userAuthorization: "high",
              rationale: "Narrowly scoped to the requested file.",
            },
          ],
          approvalReviewOutcome: "approved",
        },
        timestamp: 1000,
      }),
    ]);

    await renderToolGroups([group], {
      isToolMessageExpanded: (id) => (id === "activity:reviewed-tool-group" ? false : undefined),
    });
    expect(element('.chat-activity-group__review-status[data-outcome="approved"]')).not.toBeNull();
    expect(harness.view.textContent).not.toContain("Guardian approved");

    await renderToolGroups([group], {
      isToolMessageExpanded: () => true,
      isToolExpanded: () => true,
    });
    const review = element('.chat-tool-review[data-review-status="approved"]');
    expect(review?.textContent).toContain("Guardian approved");
    expect(review?.textContent).toContain("Narrowly scoped to the requested file.");
    expectPresent(".chat-tool-msg-body");
    expectCount(".chat-tool-review", 1);
  });

  it("keeps aggregate expansion and accessibility ids stable when groups append", () => {
    const groups = [
      createToolGroup("stable-first", [toolResultEntry("stable-1", "call-1", "read_file", "one")]),
      createToolGroup("stable-second", [toolResultEntry("stable-2", "call-2", "read_file", "two")]),
      createToolGroup("stable-third", [
        toolResultEntry("stable-3", "call-3", "read_file", "three"),
      ]),
    ];
    const opts: RenderMessageGroupOptions = {
      showReasoning: true,
      showToolCalls: true,
      isToolMessageExpanded: (id) => id === "activity:stable-first",
    };

    renderActivityGroup(groups.slice(0, 2), opts);
    const initialSummary = requireElement(".chat-activity-group__summary", HTMLButtonElement);
    const initialBodyId = initialSummary.getAttribute("aria-controls");
    expect(initialSummary.getAttribute("aria-expanded")).toBe("true");
    expect(initialBodyId).toMatch(/^activity-body-[0-9a-f]+$/);
    expect(element(`[id="${initialBodyId}"]`)).not.toBeNull();

    renderActivityGroup(groups, opts);
    const appendedSummary = requireElement(".chat-activity-group__summary", HTMLButtonElement);
    expect(appendedSummary.getAttribute("aria-controls")).toBe(initialBodyId);
    expect(appendedSummary.getAttribute("aria-expanded")).toBe("true");
    expectCount(".chat-activity-group__body > .chat-bubble", 3);
  });

  it("keeps failed activity collapsed with neutral chain chrome", async () => {
    document.body.append(harness.view);
    const onToggleToolMessageExpanded = vi.fn();
    const group = createToolGroup("tool-group", [
      toolResultEntry(
        "tool-message-1",
        "call-1",
        "read_file",
        JSON.stringify({ error: "Read failed" }),
        {
          isError: true,
          timestamp: 1000,
        },
      ),
      toolResultEntry("tool-message-2", "call-2", "run_command", "Command output", {
        timestamp: 1001,
        isError: false,
      }),
    ]);

    await renderToolGroups([group], { onToggleToolMessageExpanded });
    expect(elementText(".chat-activity-group__label")).toBe("Raw details");
    expect(elementText(".chat-activity-group__summary")).not.toContain("1 failed");

    await renderToolGroups(prepareHistoryGroups([group]), {
      onToggleToolMessageExpanded,
    });

    expectAbsent(".chat-activity-group.is-open");
    const activitySummary = requireElement(".chat-activity-group__summary", HTMLButtonElement);
    expect(activitySummary.classList.contains("chat-activity-group__summary--error")).toBe(false);
    expect(activitySummary.getAttribute("aria-label")).toBeNull();
    expect(activitySummary.getAttribute("aria-expanded")).toBe("false");
    expect(activitySummary.textContent).toContain("1 failed");
    expect(harness.view.textContent).not.toContain("Read failed");
    expect(activitySummary.querySelector(".chat-activity-group__badge")).toBeNull();
    expectAbsent(".chat-tool-msg-body");
    activitySummary.click();

    expect(onToggleToolMessageExpanded).toHaveBeenCalledWith("activity:tool-group", false);
    harness.view.remove();
  });

  it("keeps inline tool cards collapsed by default and renders expanded state", async () => {
    const show = toolFixture(
      createAssistantMessage(
        [
          createToolCall("call-1", "browser.open", { url: "https://example.com" }),
          createToolResultBlock("call-1", "browser.open", "Opened page", {
            type: "toolresult",
          }),
        ],
        { id: "assistant-1", toolCallId: "call-1" },
      ),
    );
    await show(false);

    expectAbsent(".chat-tool-msg-body");

    await show(true);

    // Simple object args render as key-value rows; only the output keeps a block.
    const kvRow = element(".chat-tool-kv__row");
    expect(kvRow?.querySelector(".chat-tool-kv__key")?.textContent).toBe("url:");
    expect(kvRow?.querySelector(".chat-tool-kv__value")?.textContent).toBe("https://example.com");
    const blocks = elements(".chat-tool-card__block");
    // Plain output is the block's default content, so it carries no header.
    expect(blocks[0]?.querySelector(".chat-tool-card__block-label")).toBeNull();
    expect(blocks[0]?.querySelector("code")?.textContent).toBe("Opened page");
  });

  it("keeps top-level tool-name results collapsed", async () => {
    document.body.append(harness.view);
    markdownRenderMock.mockClear();
    await renderToolMessage(
      createAssistantMessage("A long tool result that should stay behind the disclosure.", {
        toolName: "bash",
      }),
      { isToolMessageExpanded: () => false },
    );
    requireElement(".chat-bubble--tool-shell", HTMLElement);
    requireElement(".chat-tool-msg-summary", HTMLButtonElement);
    expectAbsent(".chat-tool-msg-body");
    expectAbsent(".chat-text");
    expect(markdownRenderMock).not.toHaveBeenCalled();
  });

  it("keeps one readable label for standalone tool results with duplicate names", async () => {
    document.body.append(harness.view);
    const message = createToolResultMessage("call-heartbeat", "heartbeat_respond", [
      {
        type: "tool_result",
        name: "heartbeat_respond",
        text: "Acknowledged",
      },
    ]);

    await renderToolMessage(message, {
      isToolMessageExpanded: () => false,
    });

    const summary = requireElement(".chat-tool-msg-summary", HTMLButtonElement);
    expect(summary.textContent?.trim()).toBe("Heartbeat Respond");
    expect(summary.querySelector("[role=img]")?.ariaLabel).toBe("heartbeat_respond");
    expect(summary.querySelector(".chat-tool-msg-summary__names")).toBeNull();
  });

  it("cleans collapsed tool connector copy while preserving expanded raw input", async () => {
    const show = toolFixture(
      createAssistantMessage(
        [createToolCall("call-string-tool", "presentation_create", "with Example Deck")],
        { id: "assistant-string-tool", toolCallId: "call-string-tool" },
      ),
    );
    await show(false);

    // The cleaned string-arg preview is now the primary collapsed label.
    expect(elementText(".chat-tool-msg-summary__label")?.trim()).toBe("Example Deck");
    expectAbsent(".chat-tool-msg-summary__names");
    expect(elementText(".chat-tool-msg-summary")).not.toContain("with Example Deck");

    await show(true);

    expect(elementText(".chat-tool-msg-body")).not.toContain("presentation_create");
    expect(elementText(".chat-tool-card__block code")).toBe("with Example Deck");
  });

  it("renders expanded tool output rows and their json content", async () => {
    document.body.append(harness.view);
    const output = {
      status: "error",
      exitCode: 1,
      error: "Session mode is unavailable for this target.",
      childSessionKey: "agent:test:subagent:abc123",
    };
    const call = createAssistantMessage(
      [createToolCall("call-5", "sessions_spawn", { mode: "session", thread: true })],
      { id: "assistant-5", toolCallId: "call-5" },
    );
    const result = createToolResultMessage(
      "call-5",
      "sessions_spawn",
      JSON.stringify(output, null, 2),
      {
        id: "tool-5",
        role: "tool",
        timestamp: Date.now() + 1,
      },
    );
    await renderToolGroups(
      [createMessageGroup(call, "assistant"), createMessageGroup(result, "tool")],
      {
        isToolExpanded: () => true,
        isToolMessageExpanded: () => true,
      },
    );

    // The call's simple args render as key-value rows; the error keeps a block.
    const kvRows = elements(".chat-tool-kv__row");
    expect(
      kvRows.map((row) => [
        row.querySelector(".chat-tool-kv__key")?.textContent,
        row.querySelector(".chat-tool-kv__value")?.textContent,
      ]),
    ).toEqual([
      ["mode:", "session"],
      ["thread:", "true"],
    ]);
    const blocks = elements(".chat-tool-card__block");
    expect(
      blocks.map((block) => block.querySelector(".chat-tool-card__block-label")?.textContent),
    ).toEqual(["Tool error"]);
    expect(JSON.parse(blocks[0]?.querySelector("code")?.textContent ?? "{}")).toEqual(output);
    expect(
      blocks[0]?.closest(".chat-tool-card")?.querySelector(":scope > .chat-tool-card__outcome")
        ?.textContent,
    ).toBe("Exit code 1");
  });

  it("keeps status-only standalone tool-result summaries neutral until expanded", async () => {
    const onToggleToolMessageExpanded = vi.fn();
    const show = toolFixture(
      createToolResultMessage(
        "call-status-error",
        "sessions_spawn",
        JSON.stringify({ status: "error" }, null, 2),
        { id: "tool-status-error" },
      ),
      true,
    );

    await show(false, { onToggleToolMessageExpanded });

    let summary = requireElement(".chat-tool-msg-summary", HTMLButtonElement);
    expect(summary.classList.contains("chat-tool-msg-summary--error")).toBe(false);
    expect(summary.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Tool output");
    expect(summary.querySelector(".chat-tool-msg-summary__names")?.textContent).toBe(
      "sessions_spawn",
    );
    summary.click();
    expect(onToggleToolMessageExpanded).toHaveBeenCalledOnce();

    await show(true);

    summary = requireElement(".chat-tool-msg-summary", HTMLButtonElement);
    expect(summary.classList.contains("chat-tool-msg-summary--error")).toBe(false);
    expect(summary.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Tool output");
    // The failure stays recorded: the expanded body closes with the outcome.
    expect(elementText(".chat-tool-card__outcome")).toBe("failed");
    expect(elementText(".chat-tool-msg-body .chat-text pre code")).toBe(
      '{\n  "status": "error"\n}',
    );
    expectAbsent(".chat-tool-msg-body details, .code-block-json-mode");
    harness.view.remove();
  });

  it("renders an expanded orphan tool result without a nested disclosure", async () => {
    document.body.append(harness.view);
    await renderToolGroups(
      [
        toolResultGroup("call-orphan", "read", "Orphan tool output", {
          id: "orphan-tool-result",
        }),
      ],
      { isToolMessageExpanded: () => true },
    );

    expectAbsent(".chat-tool-msg-body .chat-tool-msg-summary");
    expectCount(".chat-tool-card__block code", 1);
    expect(elementText(".chat-tool-card__block code")).toBe("Orphan tool output");
  });

  it("keeps text visible beside an orphan tool-result image", async () => {
    document.body.append(harness.view);
    await renderToolGroups(
      [
        toolResultGroup("call-image", "image", [
          { type: "text", text: "Generated image" },
          { type: "image", data: "cG5n", mimeType: "image/png", alt: "Generated preview" },
        ]),
      ],
      { isToolMessageExpanded: () => true },
    );

    expect(elementText(".chat-text")).toContain("Generated image");
    expect(
      harness.view.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe("data:image/png;base64,cG5n");
    expectPresent(".chat-tool-msg-body .chat-tool-msg-summary");
  });

  it("keeps omitted media visible beside a standalone tool result", async () => {
    document.body.append(harness.view);
    await renderToolMessage(
      createToolResultMessage("call-history-image", "read_file", [
        {
          type: "tool_result",
          name: "read_file",
          text: "Read completed",
        },
        { type: "image", omitted: true, bytes: 2048 },
      ]),
      { isToolMessageExpanded: () => false },
    );
    expectPresent(".chat-tool-msg-summary");
    expect(harness.view.textContent).toContain("Omitted from history");
    expect(harness.view.textContent).toContain("2.0 KB");
  });

  it.each([
    ["canvas-only shortcode", false, "cv_tictactoe", "Tic-Tac-Toe"],
    ["lifted canvas beside a flat tool row", true, "cv_inline_tool_canvas", "Inline demo"],
  ] as const)(
    "renders a %s inside its assistant bubble",
    async (_label, toolSummary, docId, title) => {
      const context = createInitializationContext();
      const provider = mountSolid(
        () => <ApplicationProvider value={context} host={harness.view} />,
        {},
      );
      onTestFinished(provider.dispose);
      document.body.append(harness.view);
      const content = toolSummary
        ? [
            {
              type: "tool_use",
              id: "call-tool-canvas",
              name: "bash",
              input: { command: "render preview" },
            },
            createAssistantCanvasBlock({ suffix: "tool_canvas" }),
          ]
        : [{ type: "text", text: '[embed ref="cv_tictactoe" title="Tic-Tac-Toe" /]' }];
      await renderToolMessage(
        createAssistantMessage(content, toolSummary ? { toolName: "bash" } : {}),
        {
          showToolCalls: toolSummary,
          isToolMessageExpanded: () => true,
        },
      );
      const bubble = requireElement(
        toolSummary ? ".chat-bubble--tool-shell" : ".chat-bubble",
        HTMLElement,
      );
      const widget = expectCanvasWidget(harness.view, { docId, title });
      expect(bubble.contains(widget)).toBe(true);
      if (toolSummary) {
        expectPresent(".chat-tool-msg-summary");
      }
    },
  );

  it("opens generic tool details instead of a canvas preview from tool rows", async () => {
    document.body.append(harness.view);
    const onOpenSidebar = vi.fn();
    const canvas = createAssistantCanvasBlock({
      suffix: "sidebar",
      presentationTarget: "tool_card",
    });
    renderGroupedMessage(
      createToolResultMessage("call-artifact-sidebar", "canvas_render", canvas.rawText),
      "tool",
      {
        isToolExpanded: () => true,
        isToolMessageExpanded: () => true,
        onOpenSidebar,
      },
    );
    await settleToolBridges(harness.view);
    requireElement(".chat-tool-card__action-btn", HTMLButtonElement).click();
    expectAbsent(".chat-tool-card__preview-frame");
    expect(onOpenSidebar).toHaveBeenCalledTimes(1);
    expect(onOpenSidebar).toHaveBeenCalledWith(expect.objectContaining({ kind: "tool-output" }));
  });
});
