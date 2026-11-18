/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { projectAgentToolActivity } from "../../../../../src/infra/agent-activity-events.js";
import { createNestedToolActivity } from "../../../../../src/sessions/nested-tool-activity.js";
import { ApplicationProvider } from "../../../lib/reactive/context.ts";
import { prepareChatHistoryFixture } from "../../../test-helpers/chat-activity-fixtures.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { createInitializationContext } from "../chat-application-context.test-support.ts";
import { attachHistoryActivity } from "../chat-history-snapshot.ts";
import { groupsOf } from "../chat-thread-fixtures.test-support.ts";
import { rememberLiveTerminalRun } from "../terminal-message-identity.ts";
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
import { projectTranscriptChain } from "./chat-transcript-message-index.ts";

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

  it("keeps completed agents at result time, adjacent only, and once per execution", async () => {
    const worker = {
      runId: "child-one",
      sessionKey: "agent:main:subagent:worker",
      label: "Worker01",
      status: "done",
    };
    const second = { ...worker, runId: "child-two", label: "Worker02" };
    const output = JSON.stringify({
      completed: [worker, second, { ...worker, runId: "failed", status: "failed" }],
    });
    const at = (message: TestMessage, timestamp: number, extra?: TestMessage): TestMessage => ({
      ...message,
      timestamp,
      runId: "parent",
      ...extra,
    });
    const collect = createToolCall("collect", "agents_wait", {});
    const call = at(createAssistantMessage([collect]), 10);
    const result = at(createToolResultMessage("collect", "agents_wait", output), 30);
    // Results carried inside the call message, including bounded ones that keep only receipts.
    const block = { type: "tool_result", id: "collect", name: "agents_wait", timestamp: 30 };
    const inline = (text: string, extra?: TestMessage) =>
      at(createAssistantMessage([collect, { ...block, text, ...extra }]), 10);
    const receipts = { subagentCompletions: [worker, second] };
    const receipt = (runId: string, timestamp: number) => ({
      role: "assistant",
      phase: "commentary",
      runId: "parent",
      timestamp,
      content: [{ type: "subagent_completion" }],
      subagentCompletions: [{ ...worker, runId }],
    });
    const say = (text: string, timestamp: number, phase = "commentary") =>
      at(createAssistantMessage(text), timestamp, { phase });
    const show = (messages: TestMessage[]) =>
      renderToolGroups(groupsOf(buildItems({ messages })), {});
    const executions: TestMessage[][] = [
      [call, result],
      [inline(output)],
      [inline("[Nested tool output omitted: exceeds display limit]", receipts)],
      [call, { ...result, content: "Omitted large output", ...receipts }],
    ];
    for (const execution of executions) {
      await show([
        { role: "user", content: "Collect the workers", timestamp: 1 },
        execution[0]!,
        say("Waiting here.", 20),
        {
          role: "user",
          content: "Also check the summary.",
          timestamp: 25,
          __openclaw: { id: "steer", steerTargetRunId: "parent" },
        },
        ...execution.slice(1),
        receipt(worker.runId, 31),
        say("Read after collection.", 32),
        receipt("child-next-run", 33),
        at(createAssistantMessage([createToolCall("collect-again", "agents_wait", {})]), 34),
        at(createToolResultMessage("collect-again", "agents_wait", output), 35),
        say("All collected.", 40, "final_answer"),
        {
          role: "user",
          content: "Queued later request.",
          timestamp: 28,
          __openclaw: { id: "pending-next", kind: "pending-send" },
        },
      ]);
      const text = harness.view.textContent!;
      const positions = [
        "Waiting here.",
        "Also check the summary.",
        "Worker01 and Worker02 finished",
        "Read after collection.",
        "Worker01 finished",
        "Queued later request.",
      ].map((part) => text.indexOf(part));
      expect(positions).not.toContain(-1);
      expect(positions).toEqual(positions.toSorted((a, b) => a - b));
      expect(text.match(/Worker01 finished/g)).toHaveLength(1);
    }
    await show([{ ...result, __openclaw: { catalogSource: true } }]);
    expect(harness.view.textContent).not.toContain("finished");
    const third = { ...worker, runId: "child-three", label: "Worker03" };
    await show([
      { ...receipt(third.runId, 10), subagentCompletions: [third] },
      createAssistantMessage("Earlier result.", { timestamp: 11, phase: "commentary" }),
      receipt(worker.runId, 20),
      { ...receipt(second.runId, 21), subagentCompletions: [second, third] },
    ]);
    expect(harness.view.textContent).toContain("Worker03 finished");
    expect(harness.view.textContent).toContain("Worker01 and Worker02 finished");
  });

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

  it("deduplicates exec and wait across completed history, live snapshots, and separated activity groups", async () => {
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
    expect(elementText(".chat-activity-group__label")?.trim()).toBe("Ran commands, used tools");
    expectCount(".chat-tool-row", 2);
  });

  it("keeps a persisted call provisional until its matching result arrives", async () => {
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
      const { interruptedRunIds } = projectTranscriptChain(items, {
        sessionKey: "abort-test",
        messages: history.messages,
        runWorking: false,
        searchActive: false,
      });
      renderActivityGroup(
        items.filter((item) => item.kind === "group"),
        {
          showReasoning: false,
          runActive: false,
          interruptedRunIds,
          ...expandedTools,
        },
      );
      await settleToolBridges(harness.view);
      return history;
    };
    const unknown = await renderHistory([call]);
    expect(unknown.activity[0]?.items[0]).toMatchObject({
      phase: "end",
      unpairedCall: true,
    });
    expect(unknown.activity[0]?.items[0]).not.toHaveProperty("status");
    expect(elementText(".chat-activity-group__label")).toBe("Commands");
    expect(harness.view.textContent).not.toContain("Outcome unknown");
    expect(harness.view.textContent).toContain("No result available.");
    expectAbsent(".chat-tool-row--running");
    expect(harness.view.textContent).toContain("check-workspace");

    for (const disposition of ["timeout", "error", "aborted"] as const) {
      const terminal = createAssistantMessage([], { stopReason: "aborted" });
      rememberLiveTerminalRun(terminal, "historic-run", disposition);
      const chain = projectTranscriptChain([], {
        sessionKey: "live-abort-test",
        messages: [terminal],
        runWorking: false,
        searchActive: false,
      });
      expect(chain.interruptedRunIds.has("historic-run")).toBe(disposition === "aborted");
    }
    const abort = createAssistantMessage([], {
      openclawAbort: { aborted: true, origin: "rpc", runId: "historic-run" },
      excludeFromContext: true,
    });
    await renderHistory([call, abort]);
    expect(elementText(".chat-activity-group__label")).toBe("Interrupted actions");
    expect(harness.view.textContent).toContain("No result available.");
    await renderHistory([{ ...call, __openclaw: { id: "next-call", runId: "next-run" } }, abort]);
    expect(elementText(".chat-activity-group__label")).toBe("Commands");
    const completed = await renderHistory([
      call,
      abort,
      createToolResultMessage("orphan", "exec", "Workspace checked.", {
        isError: false,
        __openclaw: { id: "orphan-result", runId: "historic-run" },
      }),
    ]);
    expect(completed.activity[0]?.items[0]).toMatchObject({ phase: "end", status: "completed" });
    expectAbsent(".chat-activity-group__summary");
    expect(elementText(".chat-tool-row__cmd")).toBe("check-workspace");
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
    renderActivityGroup(
      [
        ...groups,
        createToolGroup("launch", [
          toolResultEntry("launch", "spawn", "sessions_spawn", "Child accepted"),
        ]),
      ],
      opts,
    );
    expect(requireElement(".chat-activity-group__summary", HTMLButtonElement)).toBe(initialSummary);
    expect(initialSummary.getAttribute("aria-controls")).toBe(initialBodyId);
    expectCount(".chat-tool-msg-summary", 4);
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

    expect(elementText(".chat-tool-row__title")?.trim()).toBe("Presentation Create");
    expectAbsent(".chat-tool-msg-summary__names");
    expect(elementText(".chat-tool-msg-summary")).not.toContain("with Example Deck");

    await show(true);

    expect(elementText(".chat-tool-msg-body")).not.toContain("presentation_create");
    expect(elementText(".chat-tool-card__block code")).toBe("with Example Deck");
  });

  it.each([undefined, 0, 7])(
    "keeps the standalone failure footer and neutral disclosure with exit code %s",
    async (exitCode) => {
      const output = '{\n  "status": "error"\n}';
      const group = toolResultGroup("status-error", "sessions_spawn", output, {
        details: { exitCode },
      });
      for (const expanded of [false, true]) {
        await renderToolGroups([group], {
          isToolMessageExpanded: () => expanded,
          isToolExpanded: () => expanded,
        });
        const summary = requireElement(".chat-tool-msg-summary", HTMLDivElement);
        expect(summary.classList.contains("chat-tool-msg-summary--error")).toBe(false);
        expect(summary.textContent).toContain("Couldn't launch subagent");
        expect(Boolean(element(".chat-tool-msg-body"))).toBe(expanded);
      }
      expect(elementText(".chat-tool-card__outcome")).toBe(
        exitCode ? `Exit code ${exitCode}` : "failed",
      );
      expect(elementText(".chat-tool-msg-body pre code")).toBe(output);
      expectAbsent(".chat-tool-msg-body details, .code-block-json-mode");
    },
  );

  it.each(["image only", "text then image", "image then text"])(
    "keeps inspected images in tool details with %s",
    async (order) => {
      const images = ["one", "two", "three"].map((alt) => ({
        type: "image",
        data: "cG5n",
        mimeType: "image/png",
        alt,
      }));
      const imageCall = createToolCall("inspect", "view_image", {
        path: "/tmp/avatar-previews.png",
      });
      const textCall = createToolCall("read", "read_file", { path: "brief.md" });
      const call = createAssistantMessage(
        order === "image only"
          ? [imageCall]
          : order === "text then image"
            ? [textCall, imageCall]
            : [imageCall, textCall],
      );
      const textResult = createToolResultMessage(
        "read",
        "read_file",
        "Inspect the preview images.",
      );
      const result = createToolResultMessage("inspect", "view_image", [
        { type: "text", text: "Loaded 3 images for inspection." },
        ...images,
      ]);
      const delivered = createAssistantMessage(images);
      const groups = buildItems({
        messages: [call, ...(order === "image only" ? [] : [textResult]), result, delivered],
      }).filter((item) => item.kind === "group");
      for (const expanded of [false, true, false]) {
        await renderToolGroups(groups, { isToolMessageExpanded: () => expanded });
        if (order === "image only") {
          expect(elementText(".chat-tool-msg-summary")?.trim()).toBe(
            "Viewed image avatar-previews.png",
          );
        }
        expectCount(".chat-group.assistant .chat-message-image", 3);
        expectCount(".chat-tool-msg-body .chat-message-image", expanded ? 3 : 0);
        if (expanded) {
          expect(harness.view.textContent!.match(/Viewed image/g)).toHaveLength(1);
        }
        expectCount(".chat-message-image", expanded ? 6 : 3);
      }
    },
  );

  it.each([false, true])("names subagent lifecycle rows (tool search: %s)", async (dispatched) => {
    // Tool search records each call twice: the dispatch envelope and the nested call
    // that carries the activity. Rows present the nested call, never the envelope.
    const runId = "run-1";
    const text = (value: unknown) => [{ type: "text", text: JSON.stringify(value) }];
    const messages = (
      [
        [
          "spawn",
          "sessions_spawn",
          { label: "Worker01", task: "Review." },
          { status: "accepted", runId: "child", childSessionKey: "agent:main:subagent:w" },
        ],
        ["roster", "subagents", { action: "list" }, { status: "ok", action: "list" }],
      ] as const
    ).flatMap(([id, name, args, output], index): TestMessage[] => {
      const rows: TestMessage[] = [
        createAssistantMessage(
          [
            dispatched
              ? createToolCall(id, "dispatch_action", { id: name, args })
              : createToolCall(id, name, args),
          ],
          { __openclaw: { id: `${id}-call`, runId } },
        ),
      ];
      if (dispatched) {
        rows.push(
          Object.assign(
            createNestedToolActivity({
              runId,
              scopeId: "scope",
              afterEntryId: `${id}-call`,
              startOrder: index,
              parentToolCallId: id,
              toolCallId: `tool_call:${id}:${name}:${index}`,
              toolName: name,
              input: args,
              result: { content: text(output) },
              isError: false,
              startedAt: index,
              timestamp: index,
            }),
            { __openclaw: { id: `${id}-nested`, runId } },
          ),
        );
      }
      rows.push(
        createToolResultMessage(
          id,
          dispatched ? "dispatch_action" : name,
          dispatched
            ? text({ tool: { id: name }, result: { content: text(output) } })
            : text(output),
          { isError: false, __openclaw: { id: `${id}-result`, runId } },
        ),
      );
      return rows;
    });
    const history = attachHistoryActivity(prepareChatHistoryFixture(messages));
    const items = buildItems({ paneId: "dispatch", messages: history.messages });
    renderActivityGroup(
      items.filter((item) => item.kind === "group"),
      { showReasoning: false, runActive: false },
    );
    await settleToolBridges(harness.view);
    expect(
      [
        ...harness.view.querySelectorAll(".chat-tool-msg-summary, .chat-activity-group__summary"),
      ].map((row) => row.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual(["Launched Worker01", "Listed subagents"]);
  });

  it.each([false, true])(
    "keeps a collection wait visible when an ID returned an error (persisted: %s)",
    async (persisted) => {
      // A capped result keeps only the compact error count recorded before the cap.
      const worker = {
        runId: "done",
        sessionKey: "agent:main:subagent:worker",
        label: "Worker",
        status: "done",
      };
      const output = {
        completed: [worker],
        pending: [],
        errors: [{ runId: "gone", error: "not_found" }],
      };
      const groups = buildItems({
        messages: [
          createAssistantMessage([
            createToolCall("wait", "agents_wait", { ids: ["done", "gone"] }),
          ]),
          createToolResultMessage(
            "wait",
            "agents_wait",
            persisted ? "[output truncated]" : JSON.stringify(output),
            persisted ? { subagentCompletions: [worker], subagentCollectionErrors: 1 } : {},
          ),
        ],
      }).filter((item) => item.kind === "group");
      await renderToolGroups(groups, {});
      expectCount("button.chat-tool-msg-summary", 1);
      expect(harness.view.textContent).toContain("Worker finished");
      await renderToolGroups(groups, expandedTools);
      expect(elementText(".chat-tool-msg-body")).toContain(
        persisted ? "[output truncated]" : "not_found",
      );
    },
  );

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
