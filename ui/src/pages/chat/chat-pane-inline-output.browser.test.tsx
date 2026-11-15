import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import {
  parseShellWords,
  scanTopLevelChars,
} from "../../../../src/agents/tool-display-exec-shell.ts";
import "../../styles.css";
import "../../styles/chat.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { resolveToolCallInput } from "../../lib/chat/tool-call-input.ts";
import { resolveToolCallView } from "../../lib/chat/tool-call-view.ts";
import { extractToolCardsCached, resolveToolCardDisplay } from "../../lib/chat/tool-cards.ts";
import { resolveToolDisplay } from "../../lib/chat/tool-display.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { getPaneTestRuntime, nativeHistoryMessage } from "./chat-pane.test-support.ts";
import { publishTranscriptScroll } from "./components/chat-transcript-scroll-events.ts";
import type { AgentEventPayload } from "./tool-stream-contract.ts";

vi.mock("../../../../src/agents/tool-display-exec-shell.ts", { spy: true });
vi.mock("../../lib/chat/tool-call-input.ts", { spy: true });
vi.mock("../../lib/chat/tool-call-view.ts", { spy: true });
vi.mock("../../lib/chat/tool-cards.ts", { spy: true });
vi.mock("../../lib/chat/tool-display.ts", { spy: true });
const unrelatedOptionReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("./components/chat-message-bubble-presentation.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./components/chat-message-bubble-presentation.ts")>();
  return {
    ...actual,
    prepareGroupedMessage: (...args: Parameters<typeof actual.prepareGroupedMessage>) => {
      const state = actual.prepareGroupedMessage(...args);
      const widgetLayout = state.toolRenderOptions.widgetLayout;
      Object.defineProperty(state.toolRenderOptions, "widgetLayout", {
        enumerable: true,
        get: () => {
          unrelatedOptionReads.count += 1;
          return widgetLayout;
        },
      });
      return state;
    },
  };
});

it("updates a mounted inline invocation without rendering the pane or disturbing its composer", async () => {
  await page.viewport(1200, 900);
  const sessionKey = "agent:main:dashboard:inline-output-publication";
  const runId = "inline-output-run";
  const startedAt = Date.now();
  const row: GatewaySessionRow = {
    key: sessionKey,
    sessionId: "inline-output-session",
    agentId: "main",
    kind: "direct",
    updatedAt: 1,
    hasActiveRun: true,
    activeRunIds: [runId],
    status: "running",
    verboseLevel: "full",
  };
  const recoveryEvents: AgentEventPayload[] = [];
  const history = {
    messages: [
      ...Array.from({ length: 200 }, (_, index) => ({
        ...nativeHistoryMessage(
          index + 1,
          `Earlier message ${index + 1}.\n${"History context.\n".repeat(8)}`,
        ),
        timestamp: startedAt - 200_000 + index * 1000,
      })),
      {
        ...nativeHistoryMessage(201, "Run the evidence commands."),
        timestamp: startedAt - 1,
        __openclaw: { id: "current-user", seq: 201, runId },
      },
    ],
    sessionId: row.sessionId,
    sessionInfo: row,
    inFlightRun: { runId, startedAt, text: "", events: recoveryEvents },
  };
  const mounted = createMountedPanes([row], "main", undefined, {
    "chat.startup": () => history,
    "chat.history": () => history,
  });
  const gatewayUrl = mounted.context.gateway.connection.gatewayUrl;
  const originalSettings = loadSettings(gatewayUrl);
  const setInline = (chatInlineCommands: boolean) => {
    patchSettings(
      { gatewayUrl, chatInlineCommands, chatShowToolCalls: true },
      { selectGateway: false },
    );
    // The mount fixture creates several contexts; refresh the theme owner
    // serving this pane rather than the last context's global write listener.
    mounted.context.theme.refresh();
  };
  setInline(false);
  onTestFinished(() => {
    patchSettings(
      {
        gatewayUrl,
        chatInlineCommands: originalSettings.chatInlineCommands,
        chatShowToolCalls: originalSettings.chatShowToolCalls,
      },
      { selectGateway: false },
    );
  });
  const pane = mounted.mount(sessionKey);
  pane.style.cssText = "display: flex; flex-direction: column; width: 900px; height: 700px";
  pane.active = true;
  document.body.append(pane.element);
  onTestFinished(() => {
    pane.element.remove();
    vi.restoreAllMocks();
  });
  await refreshPane(pane);
  await pane.updateComplete;
  await vi.dynamicImportSettled();
  await expect.poll(() => pane.transcript.isPositionSettled).toBe(true);
  const state = pane.state;
  state.settings = { ...state.settings, chatInlineCommands: false, chatShowToolCalls: true };
  const runtime = getPaneTestRuntime(pane);
  // Native virtualization measures newly mounted rows over successive frames.
  const settleViewport = async () => {
    for (let frame = 0; frame < 4; frame++) {
      await new Promise(requestAnimationFrame);
      await pane.updateComplete;
    }
  };
  let sequence = 0;
  const emit = (stream: string, data: Record<string, unknown>) => {
    const event = {
      runId,
      sessionKey,
      seq: ++sequence,
      ts: startedAt + sequence,
      stream,
      data,
    };
    recoveryEvents.push(event);
    mounted.emitGatewayEvent("agent", event);
  };
  const start = (id: string, command: string) => {
    emit("tool", { toolCallId: id, name: "exec", phase: "start", args: { command } });
    emit("item", {
      itemId: `tool:${id}`,
      toolCallId: id,
      name: "exec",
      kind: "tool",
      title: "Run evidence command",
      commandBearing: true,
      phase: "start",
      status: "running",
    });
  };
  const output = (text: string, toolCallId = "first", outputOnly = true) =>
    emit("tool", {
      toolCallId,
      name: "exec",
      phase: "update",
      ...(outputOnly ? { outputOnly: true } : {}),
      partialResult: { content: [{ type: "text", text }] },
    });
  emit("lifecycle", { phase: "start" });
  start("first", "printf first-command");
  output("First stdout line.");
  await expect.poll(() => state.chatToolMessages.length).toBe(1);
  await expect.poll(() => state.toolStreamSyncTimer).toBeNull();
  expect(JSON.stringify(state.chatToolMessages)).not.toContain("First stdout line.");
  // No new stdout follows the toggle: admission must recover the quiet command.
  setInline(true);
  await expect.poll(() => state.chatSessionMessageSubscription?.includeLiveToolOutput).toBe(true);
  await expect(chatHistoryRequests(state).subscriptionReady).resolves.toBe(true);
  const recovery = chatHistoryRequests(state).historyLoad;
  if (recovery.phase === "in-flight") {
    await recovery.promise;
  }
  await expect.poll(() => chatHistoryRequests(state).historyLoad.phase).toBe("committed");
  await pane.updateComplete;
  pane.transcript.scrollToEnd({ source: "manual", behavior: "auto" });
  await expect
    .poll(() => pane.querySelector(".chat-command-trail__preview pre")?.textContent)
    .toBe("First stdout line.");
  await expect
    .poll(() => pane.querySelector(".chat-tool-row__cmd")?.textContent)
    .toBe("printf first-command");
  const disclosureRow = expectDefined(
    pane.querySelector(".chat-tool-row__cmd")?.closest<HTMLButtonElement>(".chat-tool-row"),
    "running command row",
  );
  expect(disclosureRow.classList.contains("chat-tool-row--running")).toBe(true);
  // Full verbosity has an open ordinary default. Inline overrides its presentation;
  // choosing that same stored value must still publish the new explicit choice.
  expect(disclosureRow.getAttribute("aria-expanded")).toBe("false");
  disclosureRow.click();
  await expect.poll(() => disclosureRow.getAttribute("aria-expanded")).toBe("true");
  // Finish the lazy expanded-body/catalog load before measuring independent stdout work.
  await expect
    .poll(() => pane.querySelector(".chat-tool-term__out code")?.textContent)
    .toBe("First stdout line.");
  await vi.dynamicImportSettled();
  await pane.updateComplete;
  disclosureRow.click();
  await expect.poll(() => disclosureRow.getAttribute("aria-expanded")).toBe("false");
  const textarea = expectDefined(pane.querySelector("textarea"), "mounted composer");
  const draft = "Keep this draft and selection intact.";
  textarea.focus();
  textarea.value = draft;
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  textarea.setSelectionRange(5, 15, "backward");
  await pane.updateComplete;
  await expect.poll(() => state.chatMessage).toBe(draft);
  const assertComposer = () => {
    expect(pane.querySelector("textarea")).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe(draft);
    expect([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]).toEqual([
      5,
      15,
      "backward",
    ]);
    expect(state.chatMessage).toBe(draft);
  };
  // Roster and viewport setup can retire rows before the output-only measurement.
  await expect.poll(() => runtime.swarm.hydrator?.childrenRead).toBe(true);
  await settleViewport();
  await expect.poll(() => pane.transcript.isPositionSettled).toBe(true);
  await expect
    .poll(() => pane.querySelector(".chat-command-trail__preview pre")?.textContent)
    .toBe("First stdout line.");
  // Lifecycle events mutate the retained Map; no tool or settings change may
  // wake the pane in place of its explicit nontext publication.
  const waitingApprovals = state.waitingApprovalStatuses;
  expect(waitingApprovals.size).toBe(0);
  emit("lifecycle", { phase: "waiting-approval", approvalId: "retained-map-approval" });
  await expect
    .poll(() => pane.querySelector(".chat-working-indicator__status")?.textContent)
    .toContain("Waiting for approval");
  expect(state.waitingApprovalStatuses).toBe(waitingApprovals);
  expect(waitingApprovals.get("retained-map-approval")).toEqual({ runId });
  const approvalStatus = expectDefined(
    pane.querySelector(".chat-working-indicator__status"),
    "mounted approval status",
  );
  await expect.element(page.elementLocator(approvalStatus)).toBeVisible();
  assertComposer();
  emit("lifecycle", { phase: "approval-resolved", approvalId: "retained-map-approval" });
  await expect
    .poll(() => pane.querySelector(".chat-working-indicator__status")?.textContent ?? "")
    .not.toContain("Waiting for approval");
  expect(state.waitingApprovalStatuses).toBe(waitingApprovals);
  expect(waitingApprovals.size).toBe(0);
  expect(pane.querySelector(".chat-tool-row")?.classList.contains("chat-tool-row--running")).toBe(
    true,
  );
  assertComposer();
  await settleViewport();
  await expect.poll(() => pane.transcript.isPositionSettled).toBe(true);
  const firstRow = expectDefined(pane.querySelector(".chat-tool-row"), "settled command row");
  const preview = expectDefined(
    pane.querySelector(".chat-command-trail__preview pre"),
    "mounted command output",
  );
  const renders = vi.spyOn(runtime, "render");
  const staticWork = [
    resolveToolCardDisplay,
    resolveToolCallInput,
    resolveToolCallView,
    resolveToolDisplay,
    parseShellWords,
    scanTopLevelChars,
  ].map((read) => vi.mocked(read));
  expect(vi.mocked(resolveToolCallView).mock.calls.length).toBeGreaterThan(0);
  const clearStaticWork = () => {
    unrelatedOptionReads.count = 0;
    vi.mocked(extractToolCardsCached).mockClear();
    staticWork.forEach((read) => read.mockClear());
  };
  const assertNoStaticWork = () => {
    expect.soft(unrelatedOptionReads.count, "unrelated tool options enumerated by stdout").toBe(0);
    staticWork.forEach((read) => expect.soft(read.mock.calls.length, read.getMockName()).toBe(0));
    // Geometry may consult cached structural messages; changing invocation
    // snapshots must never require generic card extraction.
    for (const message of state.chatToolMessages) {
      expect
        .soft(vi.mocked(extractToolCardsCached).mock.calls.some(([arg]) => arg === message))
        .toBe(false);
    }
  };
  const commandToken = firstRow.querySelector(".chat-cmd--name");
  clearStaticWork();
  expect(pane.querySelector(".chat-command-trail__preview pre")).toBe(preview);
  expect(pane.querySelector(".chat-tool-row")).toBe(firstRow);
  output("Fresh stdout line.");
  await expect
    .poll(() => pane.querySelector(".chat-command-trail__preview pre")?.textContent)
    .toBe("Fresh stdout line.");
  expect(pane.querySelector(".chat-command-trail__preview pre")).toBe(preview);
  expect(pane.querySelector(".chat-tool-row")).toBe(firstRow);
  assertComposer();
  expect(renders).not.toHaveBeenCalled();
  assertNoStaticWork();
  expect(firstRow.querySelector(".chat-cmd--name")).toBe(commandToken);

  // Grouped disclosure consumes the same invocation facts through its full body.
  setInline(false);
  // Replacing the lease also publishes approval replay; finish that pane frame
  // before measuring the independent stdout update below.
  await expect(chatHistoryRequests(state).subscriptionReady).resolves.toBe(true);
  await pane.updateComplete;
  const disclosure = expectDefined(
    pane.querySelector<HTMLButtonElement>(".chat-tool-row"),
    "grouped command disclosure",
  );
  if (disclosure.getAttribute("aria-expanded") !== "true") {
    disclosure.click();
  }
  await expect
    .poll(() => pane.querySelector(".chat-tool-term__out code")?.textContent)
    .toBe("Fresh stdout line.");
  const detail = expectDefined(
    pane.querySelector(".chat-tool-term__out code"),
    "expanded grouped output",
  );
  textarea.focus();
  renders.mockClear();
  clearStaticWork();
  const expandedToken = pane.querySelector(".chat-tool-term__cmd .chat-cmd--name");
  output("Detailed stdout line.", "first", false);
  await expect.poll(() => detail.textContent).toBe("Detailed stdout line.");
  expect(renders).not.toHaveBeenCalled();
  assertNoStaticWork();
  expect(pane.querySelector(".chat-tool-term__cmd .chat-cmd--name")).toBe(expandedToken);
  assertComposer();

  pane.presented = false;
  await new Promise(requestAnimationFrame);
  output("Parked stdout line.", "first", false);
  await expect.poll(() => JSON.stringify(state.chatToolMessages)).toContain("Parked stdout line.");
  await new Promise(requestAnimationFrame);
  expect(detail.textContent).toBe("Detailed stdout line.");
  pane.presented = true;
  await pane.updateComplete;
  await expect
    .poll(() => pane.querySelector(".chat-tool-term__out code")?.textContent)
    .toBe("Parked stdout line.");
  // Keep the user's explicit disclosure choice when changing presentation modes.
  const expandedRow = expectDefined(
    pane.querySelector<HTMLButtonElement>(".chat-tool-row"),
    "expanded command row",
  );
  if (expandedRow.getAttribute("aria-expanded") === "true") {
    expandedRow.click();
  }
  setInline(true);
  await expect.poll(() => state.chatSessionMessageSubscription?.includeLiveToolOutput).toBe(true);
  // Admission precedes the history recovery started by the replacement lease.
  await expect(chatHistoryRequests(state).subscriptionReady).resolves.toBe(true);
  const revealRecovery = chatHistoryRequests(state).historyLoad;
  if (revealRecovery.phase === "in-flight") {
    await (revealRecovery.refresh?.promise ?? revealRecovery.promise);
  }
  await expect.poll(() => chatHistoryRequests(state).historyLoad.phase).toBe("committed");
  await pane.updateComplete;
  await expect
    .poll(() => pane.querySelector(".chat-command-trail__preview pre")?.textContent)
    .toBe("Parked stdout line.");
  textarea.focus();

  start("second", "printf second-command");
  output("Second stdout line.", "second");
  await expect
    .poll(() =>
      Array.from(pane.querySelectorAll(".chat-tool-row__cmd"), (element) => element.textContent),
    )
    .toEqual(["printf first-command", "printf second-command"]);
  const previews = () =>
    Array.from(
      pane.querySelectorAll(".chat-command-trail__preview pre"),
      (node) => node.textContent,
    );
  await expect.poll(previews).toEqual(["Parked stdout line.", "Second stdout line."]);
  // Reveal restarts the roster owner; its delayed startup is independent of stdout.
  await expect.poll(() => runtime.swarm.hydrator?.childrenRead).toBe(true);
  // The new invocation also adds a measured row; settle its viewport before stdout-only work.
  await settleViewport();
  await expect.poll(() => pane.transcript.isPositionSettled).toBe(true);
  await pane.updateComplete;
  const commandRows = Array.from(pane.querySelectorAll(".chat-tool-row"));
  const commandPreviews = Array.from(pane.querySelectorAll(".chat-command-trail__preview pre"));
  await pane.updateComplete;
  renders.mockClear();
  clearStaticWork();
  output("First overlap line.");
  output("Second overlap line.", "second");
  await expect.poll(previews).toEqual(["First overlap line.", "Second overlap line."]);
  pane.querySelectorAll(".chat-tool-row").forEach((node, index) => {
    expect(node).toBe(commandRows[index]);
  });
  pane.querySelectorAll(".chat-command-trail__preview pre").forEach((node, index) => {
    expect(node).toBe(commandPreviews[index]);
  });
  expect(commandRows.every((node) => node.classList.contains("chat-tool-row--running"))).toBe(true);
  expect(renders).not.toHaveBeenCalled();
  assertNoStaticWork();
  assertComposer();
  const thread = expectDefined(pane.transcript.scrollElement, "native transcript scrollport");
  thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -1000, bubbles: true }));
  thread.scrollTop = thread.scrollHeight / 2;
  await expect.poll(() => state.chatFollowLocked).toBe(true);
  const visibleHistoryRow = () =>
    Array.from(pane.querySelectorAll<HTMLElement>(".chat-virtual-row")).find((historyRow) => {
      const rect = historyRow.getBoundingClientRect();
      const viewport = thread.getBoundingClientRect();
      return (
        historyRow.textContent?.includes("Earlier message ") &&
        rect.bottom > viewport.top &&
        rect.top < viewport.bottom
      );
    });
  await expect.poll(() => visibleHistoryRow()?.textContent).toContain("Earlier message ");
  await settleViewport();
  const historicalRow = expectDefined(visibleHistoryRow(), "visible historical row");
  const historicalText = historicalRow.textContent;
  const historicalKey = expectDefined(historicalRow.dataset.virtualRowKey, "historical row key");
  const historicalTop = thread.scrollTop;
  output("Reader first stdout.");
  output("Reader second stdout.", "second");
  await expect
    .poll(() => JSON.stringify(state.chatToolMessages))
    .toContain("Reader second stdout.");
  await pane.updateComplete;
  await new Promise(requestAnimationFrame);
  expect(pane.querySelector(`[data-virtual-row-key="${CSS.escape(historicalKey)}"]`)).toBe(
    historicalRow,
  );
  expect(historicalRow.textContent).toBe(historicalText);
  expect(thread.scrollTop).toBe(historicalTop);
  assertComposer();
  pane.transcript.scrollToEnd({ source: "manual", behavior: "auto" });
  await expect
    .poll(() => thread.scrollHeight - thread.clientHeight - thread.scrollTop)
    .toBeLessThanOrEqual(1);
  await expect.poll(previews).toEqual(["Reader first stdout.", "Reader second stdout."]);
  renders.mockClear();
  clearStaticWork();
  thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
  thread.scrollTop -= 120;
  await expect.poll(() => state.chatFollowLocked).toBe(true);
  await pane.updateComplete;
  expect.soft(renders.mock.calls.length, "reader leave pane renders").toBe(0);
  assertNoStaticWork();
  expect(state.chatReadingHistory).toBe(true);
  const latest = expectDefined(
    pane.querySelector<HTMLButtonElement>(".chat-scroll-to-bottom"),
    "retained latest-content affordance",
  );
  await expect.poll(() => latest.dataset.visible).toBe("true");
  expect(latest.inert).toBe(false);
  expect(latest.getAttribute("aria-hidden")).toBe("false");
  assertComposer();

  await settleViewport();
  renders.mockClear();
  clearStaticWork();
  thread.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true }));
  thread.scrollTop = thread.scrollHeight - thread.clientHeight;
  await expect.poll(() => state.chatFollowLocked).toBe(false);
  await expect.poll(() => latest.dataset.visible).toBe("false");
  await pane.updateComplete;
  expect.soft(renders.mock.calls.length, "reader rejoin pane renders").toBe(0);
  assertNoStaticWork();
  expect(state.chatReadingHistory).toBe(false);
  expect(latest.inert).toBe(true);
  expect(latest.getAttribute("aria-hidden")).toBe("true");
  assertComposer();

  // A continuing accepted output must not turn the next reader gesture into a pane frame.
  await settleViewport();
  renders.mockClear();
  output("Adjacent reader stdout.");
  thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
  thread.scrollTop -= 120;
  await expect.poll(() => state.chatFollowLocked).toBe(true);
  await pane.updateComplete;
  expect.soft(renders.mock.calls.length, "output-adjacent reader pane renders").toBe(0);
  // Virtualization can retire a row as the reader moves. Retain the currently
  // displayed row only across the output-only update, not a viewport transition.
  await expect
    .poll(() => pane.querySelector(".chat-command-trail__preview pre")?.textContent)
    .toBe("Adjacent reader stdout.");
  const readerPreview = expectDefined(
    pane.querySelector(".chat-command-trail__preview pre"),
    "reader command output",
  );
  await settleViewport();
  const readerTop = thread.scrollTop;
  const outputHeight = readerPreview.getBoundingClientRect().height;
  output("Later stdout line.");
  await expect.poll(() => readerPreview.textContent).toBe("Later stdout line.");
  expect(pane.querySelector(".chat-command-trail__preview pre")).toBe(readerPreview);
  expect(readerPreview.getBoundingClientRect().height).toBe(outputHeight);
  await expect
    .poll(() => pane.querySelector(".chat-scroll-to-bottom")?.getAttribute("data-visible"))
    .toBe("true");
  expect(thread.scrollTop).toBe(readerTop);
  assertComposer();

  emit("tool", {
    toolCallId: "first",
    name: "exec",
    phase: "result",
    result: { content: [{ type: "text", text: "Final stdout line." }], details: { exitCode: 0 } },
  });
  emit("item", {
    itemId: "tool:first",
    toolCallId: "first",
    name: "exec",
    kind: "tool",
    title: "Run evidence command",
    commandBearing: true,
    phase: "end",
    status: "completed",
  });
  await expect
    .poll(() => pane.querySelector(".chat-command-trail__preview pre")?.textContent)
    .toBe("Final stdout line.");
  await expect
    .poll(() => pane.querySelector(".chat-tool-row")?.classList.contains("chat-tool-row--running"))
    .toBe(false);
  expect(pane.querySelector(".chat-tool-row")?.textContent).toContain("Completed");
  expect(pane.querySelectorAll(".chat-tool-row--running")).toHaveLength(1);
  expect(previews()).toEqual(["Final stdout line.", "Reader second stdout."]);
  expect(renders.mock.calls.length).toBeGreaterThan(0);
  assertComposer();

  clearStaticWork();
  emit("tool", {
    toolCallId: "second",
    name: "exec",
    phase: "start",
    args: { command: "printf revised-command" },
  });
  await expect
    .poll(() =>
      Array.from(pane.querySelectorAll(".chat-tool-row__cmd"), (element) => element.textContent),
    )
    .toEqual(["printf first-command", "printf revised-command"]);
  expect(vi.mocked(resolveToolCallView).mock.calls.length).toBeGreaterThan(0);
  assertComposer();

  // Compact panes show the progress disclosure in the composer rather than Details.
  pane.compact = true;
  state.settings = {
    ...state.settings,
    chatShowTaskProgress: true,
    chatCollapseTaskProgress: false,
  };
  await pane.updateComplete;
  const progress = runtime.readProgressCardScope();
  const progressTarget = expectDefined(progress.target, "mounted progress-card target");
  progress.store.invalidate(progressTarget);
  progress.store.hydrate(progressTarget, {
    sessionKey: progressTarget.sessionKey,
    markdown: "Verify the reader policy.",
    revision: 1,
    updatedAt: startedAt,
  });
  const progressCard = () =>
    pane.querySelector<HTMLDetailsElement>(".session-progress-card--composer");
  await expect.poll(() => progressCard()?.open).toBe(true);
  await vi.dynamicImportSettled();
  state.chatReadingHistory = false;
  await pane.updateComplete;
  renders.mockClear();
  state.chatReadingHistory = true;
  await pane.updateComplete;
  expect.soft(renders.mock.calls.length, "progress history policy pane renders").toBe(0);
  // Fixed gestures exercise the real disclosure owner after the producer's leaf update.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    for (let gesture = 0; gesture < 2; gesture++) {
      publishTranscriptScroll(thread, {
        type: "input",
        event: new WheelEvent("wheel", { deltaY: -200 }),
        touching: false,
      });
      publishTranscriptScroll(thread, {
        type: "offset",
        delta: -200,
        scrolling: false,
        touching: false,
        programmatic: false,
      });
      await vi.advanceTimersByTimeAsync(301);
    }
    expect(progressCard()?.open).toBe(false);
    expect.soft(renders.mock.calls.length, "progress disclosure pane renders").toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
