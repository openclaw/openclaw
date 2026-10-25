/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
  createAssistantCanvasBlock,
  createToolCall,
  createToolResultMessage,
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
  elementText,
  expectCount,
  expectAbsent,
  expectPresent,
  renderToolMessage,
  renderToolGroups,
  renderGroupedMessage,
} = harness;

describe("grouped chat rendering", () => {
  beforeEach(() => document.body.append(harness.view));
  const expandedTools = { isToolExpanded: () => true, isToolMessageExpanded: () => true };

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
    messages.push({ ...messages.at(-1)!, timestamp: 30 });
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
          ...expandedTools,
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

  it("keeps aggregate expansion and accessibility ids stable when groups append", () => {
    const groups = ["first", "second", "third"].map((key, index) =>
      createToolGroup(`stable-${key}`, [
        toolResultEntry(`stable-${index}`, `call-${index}`, "read_file", key),
      ]),
    );
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

  it("keeps one readable label for standalone tool results with duplicate names", async () => {
    const message = createToolResultMessage("call-heartbeat", "heartbeat_respond", [
      { type: "tool_result", name: "heartbeat_respond", text: "Acknowledged" },
    ]);

    await renderToolMessage(message, { isToolMessageExpanded: () => false });

    const summary = requireElement(".chat-tool-msg-summary", HTMLButtonElement);
    expect(summary.textContent?.trim()).toBe("Heartbeat Respond");
    expect(summary.querySelector("[role=img]")?.ariaLabel).toBe("heartbeat_respond");
    expect(summary.querySelector(".chat-tool-msg-summary__names")).toBeNull();
  });

  it("cleans collapsed tool connector copy while preserving expanded raw input", async () => {
    const message = createAssistantMessage(
      [createToolCall("call-string-tool", "presentation_create", "with Example Deck")],
      { id: "assistant-string-tool", toolCallId: "call-string-tool" },
    );
    const show = (expanded: boolean) =>
      renderToolMessage(message, { isToolExpanded: () => expanded });
    await show(false);

    expect(elementText(".chat-tool-msg-summary__label")?.trim()).toBe("Example Deck");
    expectAbsent(".chat-tool-msg-summary__names");
    expect(elementText(".chat-tool-msg-summary")).not.toContain("with Example Deck");

    await show(true);

    expect(elementText(".chat-tool-msg-body")).not.toContain("presentation_create");
    expect(elementText(".chat-tool-card__block code")).toBe("with Example Deck");
  });

  it("infers a status-only result failure without changing its neutral disclosure", async () => {
    const output = '{\n  "status": "error"\n}';
    const group = toolResultGroup("status-error", "sessions_spawn", output);
    for (const expanded of [false, true]) {
      await renderToolGroups([group], { isToolMessageExpanded: () => expanded });
      const summary = requireElement(".chat-tool-msg-summary", HTMLButtonElement);
      expect(summary.classList.contains("chat-tool-msg-summary--error")).toBe(false);
      expect(elementText(".chat-tool-msg-summary__label")).toBe("Tool output");
      expect(elementText(".chat-tool-msg-summary__names")).toBe("sessions_spawn");
      expect(Boolean(element(".chat-tool-msg-body"))).toBe(expanded);
    }
    expect(elementText(".chat-tool-card__outcome")).toBe("failed");
    expect(elementText(".chat-tool-msg-body .chat-text pre code")).toBe(output);
    expectAbsent(".chat-tool-msg-body details, .code-block-json-mode");
  });

  it("keeps text visible beside an orphan tool-result image", async () => {
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
    await renderToolMessage(
      createToolResultMessage("call-history-image", "read_file", [
        { type: "tool_result", name: "read_file", text: "Read completed" },
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
    const onOpenSidebar = vi.fn();
    const canvas = createAssistantCanvasBlock({
      suffix: "sidebar",
      presentationTarget: "tool_card",
    });
    renderGroupedMessage(
      createToolResultMessage("call-artifact-sidebar", "canvas_render", canvas.rawText),
      "tool",
      {
        ...expandedTools,
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
