import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { createDeferred as deferred } from "../../test/helpers/promise.js";
import {
  captureChoicePromptSelector,
  type TestChoiceSelector as TestSelector,
} from "./components/choice-prompt.test-support.js";
import { createTuiTaskSuggestionController } from "./tui-task-suggestions.js";
const acceptedTask = { taskId: "task_1", key: "agent:main:task" };
function suggestionPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "task_1",
    title: "Remove stale adapter",
    prompt: "Delete the stale adapter and update its tests.",
    tldr: "The adapter is unreachable and adds maintenance cost.",
    cwd: "/repo/project",
    sessionKey: "agent:main:main",
    agentId: "main",
    createdAt: 1_000,
    ...overrides,
  };
}
async function finishPending<T>(pending: ReturnType<typeof deferred<T>>, value: T) {
  pending.resolve(value);
  await Promise.allSettled([pending.promise]);
  await new Promise(setImmediate);
}
const controllers: Array<ReturnType<typeof createTuiTaskSuggestionController>> = [];
afterEach(async () => {
  controllers.forEach((controller) => controller.dispose());
  controllers.length = 0;
  await new Promise(setImmediate);
});
function createHarness() {
  const selectors: TestSelector[] = [];
  const addSystem = vi.fn();
  const closeOverlay = vi.fn();
  const overlayHandles: OverlayHandle[] = [];
  const openOverlay = vi.fn((component: Component) => {
    selectors.push(captureChoicePromptSelector(component));
    const handle = {
      hide: vi.fn(),
      setHidden: vi.fn(),
      isHidden: vi.fn(() => false),
      focus: vi.fn(),
      unfocus: vi.fn(),
      isFocused: vi.fn(() => true),
      getBounds: () => undefined,
    } satisfies OverlayHandle;
    overlayHandles.push(handle);
    return handle;
  });
  const requestRender = vi.fn();
  const listTaskSuggestions = vi.fn().mockResolvedValue([]);
  const acceptTaskSuggestion = vi.fn().mockResolvedValue(acceptedTask);
  const dismissTaskSuggestion = vi.fn().mockResolvedValue({ taskId: "task_1", dismissed: true });
  const onAccepted = vi.fn().mockResolvedValue(undefined);
  let agentId = "main";
  let sessionKey = "agent:main:main";
  let actionCapabilities = { canAccept: true, canDismiss: true };
  const controller = createTuiTaskSuggestionController({
    client: {
      getTaskSuggestionActionCapabilities: () => actionCapabilities,
      listTaskSuggestions,
      acceptTaskSuggestion,
      dismissTaskSuggestion,
    },
    chatLog: { addSystem },
    getAgentId: () => agentId,
    getSessionKey: () => sessionKey,
    openOverlay,
    closeOverlay,
    requestRender,
    onAccepted,
  });
  const prompt = () => expectDefined(openOverlay.mock.calls[0]?.[0], "prompt test invariant");
  controllers.push(controller);
  return {
    controller,
    suggest: (overrides: Record<string, unknown> = {}) =>
      controller.handleEvent("task.suggestion", {
        action: "created",
        suggestion: suggestionPayload(overrides),
      }),
    render: (width = 80) => stripAnsi(prompt().render(width).join("\n")),
    pageDown: () => prompt().handleInput?.("\u001b[6~"),
    select: (value: string, index = 0) => {
      const item = expectDefined(
        selectors[index]?.items.find((entry) => entry.value === value),
        "pending task action",
      );
      selectors[index]?.onSelect?.(item);
    },
    accept: () => {
      const item = { value: "accept", label: "Start in a new session" };
      selectors[0]?.onSelect?.(item);
      selectors[0]?.onSelect?.(item);
    },
    selectors,
    addSystem,
    closeOverlay,
    openOverlay,
    overlayHandles,
    requestRender,
    listTaskSuggestions,
    acceptTaskSuggestion,
    dismissTaskSuggestion,
    onAccepted,
    setAgentId: (value: string) => {
      agentId = value;
    },
    setSessionKey: (value: string) => {
      sessionKey = value;
    },
    setActionCapabilities: (value: { canAccept: boolean; canDismiss: boolean }) => {
      actionCapabilities = value;
    },
  };
}
describe("TUI task suggestions", () => {
  it("ignores malformed Gateway suggestion payloads", () => {
    const ui = createHarness();
    ui.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: { id: "task_missing_fields" },
    });
    expect(ui.openOverlay).not.toHaveBeenCalled();
  });
  it("starts a suggested task in a new session only after confirmation", async () => {
    const ui = createHarness();
    ui.suggest();
    expect(ui.openOverlay).toHaveBeenCalledTimes(1);
    const renderedPrompt = ui.render(80);
    expect(renderedPrompt).toContain("Suggested follow-up: Remove stale adapter");
    expect(renderedPrompt).toContain("Project: /repo/project");
    expect(renderedPrompt).toContain("Why: The adapter is unreachable");
    expect(renderedPrompt).toContain("Instructions:");
    expect(renderedPrompt).toContain("Delete the stale adapter and update its tests.");
    expect(ui.selectors[0]?.items.map((item) => item.label)).toEqual([
      "Start in a new session",
      "Dismiss",
    ]);
    expect(ui.selectors[0]?.setSelectedIndex).toHaveBeenCalledWith(1);
    const accept = { value: "accept", label: "Start in a new session" };
    ui.selectors[0]?.onSelect?.(accept);
    expect(ui.acceptTaskSuggestion).not.toHaveBeenCalled();
    expect(ui.render()).toContain("Press Enter again");
    ui.selectors[0]?.onSelect?.(accept);
    await vi.waitFor(() => {
      expect(ui.acceptTaskSuggestion).toHaveBeenCalledWith("task_1");
      expect(ui.onAccepted).toHaveBeenCalledWith("agent:main:task");
    });
    expect(ui.addSystem).toHaveBeenCalledWith("follow-up task started in agent:main:task");
  });
  it("keeps actions visible while paging through long instructions", () => {
    const ui = createHarness();
    const promptLines = Array.from(
      { length: 20 },
      (_, index) => `instruction-${String(index + 1).padStart(2, "0")}`,
    );
    ui.suggest({ prompt: promptLines.join("\n") });
    const firstPage = ui.render(80);
    expect(firstPage).toContain("instruction-01");
    expect(firstPage).not.toContain("instruction-20");
    expect(firstPage).toContain("PgUp/PgDn to inspect");
    expect(firstPage).toContain("Dismiss");
    const pages = [firstPage];
    for (let page = 0; page < 3; page += 1) {
      ui.pageDown();
      const rendered = ui.render(80);
      pages.push(rendered);
      expect(rendered).toContain("Dismiss");
    }
    expect(pages.join("\n")).toContain("instruction-20");
    expect(ui.requestRender).toHaveBeenCalled();
  });
  it("keeps every project path segment inspectable before acceptance", () => {
    const ui = createHarness();
    const cwd = `/repo/${"nested-segment/".repeat(20)}distinguishing-project`;
    ui.suggest({ cwd });
    const pages: string[] = [];
    for (let page = 0; page < 20; page += 1) {
      const rendered = ui.render(24);
      pages.push(rendered);
      expect(rendered).toContain("Dismiss");
      ui.pageDown();
    }
    expect(pages.join("\n").replace(/\s/g, "")).toContain("distinguishing-project");
  });
  it("strips bidi controls from every displayed confirmation field", () => {
    const ui = createHarness();
    ui.suggest({
      title: "safe\u202eevil",
      cwd: "/repo/\u2066project",
      tldr: "why\u200f now",
      prompt: "run\u202d exactly",
    });
    const rendered = ui.render(80);
    expect(rendered).toContain("safeevil");
    expect(rendered).toContain("/repo/project");
    expect(rendered).toContain("why now");
    expect(rendered).toContain("run exactly");
    expect(rendered).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
  });

  it("dismisses a suggestion without starting work", async () => {
    const harness = createHarness();
    harness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload(),
    });

    harness.selectors[0]?.onSelect?.({ value: "dismiss", label: "Dismiss" });

    await vi.waitFor(() => {
      expect(harness.dismissTaskSuggestion).toHaveBeenCalledWith("task_1");
    });
    expect(harness.acceptTaskSuggestion).not.toHaveBeenCalled();
    expect(harness.addSystem).toHaveBeenCalledWith("follow-up task dismissed");
  });

  it("offers only actions allowed by the connected operator scopes", () => {
    const writeHarness = createHarness();
    writeHarness.setActionCapabilities({ canAccept: false, canDismiss: true });
    writeHarness.suggest();
    expect(writeHarness.selectors[0]?.items.map((item) => item.value)).toEqual(["dismiss"]);
    expect(writeHarness.selectors[0]?.setSelectedIndex).toHaveBeenCalledWith(0);
    const readHarness = createHarness();
    readHarness.setActionCapabilities({ canAccept: false, canDismiss: false });
    readHarness.suggest();
    expect(readHarness.openOverlay).not.toHaveBeenCalled();
  });
  it("rebuilds an active selector when reconnect changes action scopes", async () => {
    const ui = createHarness();
    const suggestion = suggestionPayload();
    ui.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion,
    });
    const staleSelector = ui.selectors[0];
    ui.setActionCapabilities({ canAccept: false, canDismiss: true });
    ui.listTaskSuggestions.mockResolvedValueOnce([suggestion]);
    await ui.controller.refresh();
    expect(ui.closeOverlay).toHaveBeenCalledWith(ui.overlayHandles[0]);
    expect(ui.openOverlay).toHaveBeenCalledTimes(2);
    expect(ui.selectors[1]?.items.map((item) => item.value)).toEqual(["dismiss"]);
    staleSelector?.onSelect?.({ value: "accept", label: "Start in a new session" });
    staleSelector?.onSelect?.({ value: "accept", label: "Start in a new session" });
    expect(ui.acceptTaskSuggestion).not.toHaveBeenCalled();
  });
  it("shows a still-pending suggestion again when its action fails", async () => {
    const ui = createHarness();
    ui.acceptTaskSuggestion.mockRejectedValueOnce(new Error("gateway unavailable"));
    ui.listTaskSuggestions.mockResolvedValueOnce([suggestionPayload()]);
    ui.suggest();
    ui.accept();
    await vi.waitFor(() => expect(ui.openOverlay).toHaveBeenCalledTimes(2));
    expect(ui.addSystem).toHaveBeenCalledWith("follow-up task failed: gateway unavailable");
  });
  it("does not switch sessions after the operator navigates away during acceptance", async () => {
    const ui = createHarness();
    const pendingAccept = deferred<{ taskId: string; key: string }>();
    try {
      ui.acceptTaskSuggestion.mockReturnValueOnce(pendingAccept.promise);
      ui.suggest();
      ui.accept();
      ui.setSessionKey("agent:main:other");
      ui.controller.sessionChanged();
      pendingAccept.resolve({ taskId: "task_1", key: "agent:main:task" });
      await vi.waitFor(() =>
        expect(ui.addSystem).toHaveBeenCalledWith("follow-up task started in agent:main:task"),
      );
      expect(ui.onAccepted).not.toHaveBeenCalled();
    } finally {
      await finishPending(pendingAccept, { taskId: "task_1", key: "agent:main:task" });
    }
  });
  it.each(["accept", "dismiss"])(
    "keeps an in-flight %s hidden across navigation and refresh",
    async (value) => {
      const ui = createHarness();
      const pending = deferred<{ taskId: string; key: string; dismissed: boolean }>();
      try {
        const action = value === "accept" ? ui.acceptTaskSuggestion : ui.dismissTaskSuggestion;
        action.mockReturnValueOnce(pending.promise);
        ui.listTaskSuggestions.mockResolvedValue([suggestionPayload()]);
        await ui.controller.refresh();
        ui.select(value);
        if (value === "accept") {
          ui.select(value);
        }
        expect(action).toHaveBeenCalledTimes(1);
        ui.setSessionKey("agent:main:other");
        ui.controller.sessionChanged();
        ui.setSessionKey("agent:main:main");
        ui.controller.sessionChanged();
        await ui.controller.refresh();
        ui.suggest();
        expect(ui.openOverlay).toHaveBeenCalledTimes(1);
        pending.resolve({ taskId: "task_1", key: "agent:main:task", dismissed: true });
        await new Promise(setImmediate);
        expect(action).toHaveBeenCalledTimes(1);
        expect(ui.openOverlay).toHaveBeenCalledTimes(1);
        expect(ui.addSystem).toHaveBeenCalledWith(
          value === "accept"
            ? "follow-up task started in agent:main:task"
            : "follow-up task dismissed",
        );
      } finally {
        await finishPending(pending, { taskId: "task_1", key: "agent:main:task", dismissed: true });
      }
    },
  );
  it.each([
    { value: "accept", fails: false },
    { value: "dismiss", fails: true },
  ])("ignores $value completion after disposal (fails=$fails)", async ({ value, fails }) => {
    const ui = createHarness();
    const pending = deferred<{ taskId: string; key: string; dismissed: boolean }>();
    try {
      const action = value === "accept" ? ui.acceptTaskSuggestion : ui.dismissTaskSuggestion;
      action.mockReturnValueOnce(pending.promise);
      ui.suggest();
      ui.select(value);
      if (value === "accept") {
        ui.select(value);
      }
      expect(action).toHaveBeenCalledTimes(1);
      ui.controller.dispose();
      ui.requestRender.mockClear();
      if (fails) {
        pending.reject(new Error("gateway unavailable"));
      } else {
        pending.resolve({ taskId: "task_1", key: "agent:main:task", dismissed: true });
      }
      await new Promise(setImmediate);
      expect(ui.onAccepted).not.toHaveBeenCalled();
      expect(ui.addSystem).not.toHaveBeenCalled();
      expect(ui.listTaskSuggestions).not.toHaveBeenCalled();
      expect(ui.requestRender).not.toHaveBeenCalled();
    } finally {
      await finishPending(pending, { taskId: "task_1", key: "agent:main:task", dismissed: true });
    }
  });
  it("ignores a failed recovery refresh after disposal", async () => {
    const ui = createHarness();
    const pending = deferred<unknown[]>();
    try {
      ui.dismissTaskSuggestion.mockRejectedValueOnce(new Error("gateway unavailable"));
      ui.listTaskSuggestions.mockReturnValueOnce(pending.promise);
      ui.suggest();
      ui.selectors[0]?.onSelect?.({ value: "dismiss", label: "Dismiss" });
      await vi.waitFor(() => expect(ui.listTaskSuggestions).toHaveBeenCalledTimes(1));
      ui.controller.dispose();
      ui.addSystem.mockClear();
      pending.reject(new Error("refresh unavailable"));
      await new Promise(setImmediate);
      expect(ui.addSystem).not.toHaveBeenCalled();
    } finally {
      await finishPending(pending, []);
    }
  });

  it("shows only suggestions for the active session", () => {
    const harness = createHarness();
    harness.controller.handleEvent("task.suggestion", {
      action: "created",
      suggestion: suggestionPayload({ sessionKey: "agent:other:main", agentId: "other" }),
    });
    expect(harness.openOverlay).not.toHaveBeenCalled();

    harness.setSessionKey("agent:other:main");
    harness.setAgentId("other");
    harness.controller.sessionChanged();

    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["shows a fixed-store alias owned by the active agent", "main", "support", true],
    ["rejects a contradictory explicit owner", "work", "agent:main:support", false],
  ] as const)("%s", (_label, suggestionAgent, suggestionSession, visible) => {
    const ui = createHarness();
    ui.setAgentId("main");
    ui.setSessionKey("agent:main:support");
    ui.suggest({ agentId: suggestionAgent, sessionKey: suggestionSession });
    expect(ui.openOverlay).toHaveBeenCalledTimes(visible ? 1 : 0);
  });
  it("closes a suggestion resolved by another client", () => {
    const ui = createHarness();
    ui.suggest();
    ui.controller.handleEvent("task.suggestion", {
      action: "resolved",
      taskId: "task_1",
      resolution: "accepted",
    });
    expect(ui.closeOverlay).toHaveBeenCalledWith(ui.overlayHandles[0]);
  });
  it("does not resurrect a resolved suggestion from a stale refresh", async () => {
    const ui = createHarness();
    const pendingList = deferred<unknown[]>();
    try {
      ui.listTaskSuggestions.mockReturnValueOnce(pendingList.promise);
      const refresh = ui.controller.refresh();
      ui.controller.handleEvent("task.suggestion", {
        action: "resolved",
        taskId: "task_1",
        resolution: "dismissed",
      });
      pendingList.resolve([suggestionPayload()]);
      await refresh;
      expect(ui.openOverlay).not.toHaveBeenCalled();
    } finally {
      await finishPending(pendingList, []);
    }
  });
});
