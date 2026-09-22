/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { createReviewFixture } from "../../test-helpers/chat-pane-embedded-panels.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { isSidebarSlotVisible, openSlot, setSidebarOpen } from "./sidebar-layout.ts";

beforeEach(() => {
  installTranscriptDomMocks();
  const previous = loadSettings();
  onTestFinished(() => {
    patchSettings(previous);
  });
  patchSettings({ sessionKey: "agent:main:review-intent", sidebarSessionLayouts: {} });
});
afterEach(() => {
  document.body.replaceChildren();
  resetTranscriptTestDom();
});

it("restores a selected task outside the bounded list in Tasks after a fresh page mount", async () => {
  const original = createReviewFixture({ childSessionKey: "agent:main:subagent:review-child" });
  original.rails().backgroundTasks.onOpenTaskDetail?.(original.task);
  await original.renderPanels();
  await original.renderPanels();
  expect(original.mount.textContent).toContain("The selected task transcript.");
  expect(
    loadSettings().sidebarSessionLayouts?.[original.state.sessionKey]?.columns[0]?.panels,
  ).toContainEqual({
    id: "tasks",
    slot: "tasks",
    taskId: original.task.id,
  });
  render(nothing, original.mount);

  const restored = createReviewFixture({ childSessionKey: original.task.childSessionKey }, true);
  const detail = createDeferred<unknown>();
  const request = restored.state.client!.request.bind(restored.state.client);
  const spy = vi
    .spyOn(restored.state.client!, "request")
    .mockImplementation((method, params) =>
      method === "tasks.list"
        ? Promise.resolve({ tasks: [] })
        : method === "tasks.get"
          ? detail.promise
          : request(method, params),
    );
  await vi.waitFor(async () => {
    await restored.renderPanels();
    expect(spy).toHaveBeenCalledWith("tasks.get", { taskId: original.task.id });
  });
  expect(restored.mount.querySelector('[data-panel-skeleton="tasks"]')).not.toBeNull();
  expect(restored.mount.textContent).not.toContain("This task is no longer available.");
  expect(restored.mount.textContent).toContain("Back to tasks");
  detail.resolve({ task: restored.task });
  await vi.waitFor(async () => {
    await restored.renderPanels();
    expect(restored.mount.textContent).toContain("The selected task transcript.");
  });
  expect(
    restored.mount
      .querySelector("[data-task-detail-panel]")
      ?.closest("[data-panel-slot]")
      ?.getAttribute("data-panel-slot"),
  ).toBe("tasks");
  expect(restored.rails().backgroundTasks.tasks).toEqual([]);
  expect(restored.rails().backgroundTasks.selectedTaskId).toBe(original.task.id);
  expect(spy.mock.calls.filter(([method]) => method === "tasks.get")).toHaveLength(1);
  expect(restored.history).toHaveBeenCalledExactlyOnceWith({
    taskId: original.task.id,
    limit: 100,
  });
  restored.state.updateSidebarLayout(setSidebarOpen(restored.state.sidebarLayout, false));
  restored.state.updateSidebarLayout(setSidebarOpen(restored.state.sidebarLayout, true));
  await restored.renderPanels();
  expect(restored.mount.querySelector("[data-task-detail-panel] .sidebar-title")?.textContent).toBe(
    original.task.title,
  );

  restored.rails().closePanelSlot("tasks");
  expect(restored.state.taskDetailState).toBeUndefined();
  const closed = createReviewFixture({}, true);
  await closed.renderPanels();
  expect(closed.mount.querySelector("[data-task-detail-panel]")).toBeNull();
  expect(closed.rails().backgroundTasks.selectedTaskId).toBeUndefined();
});

it("keeps failed restored lookup explicit until Retry and isolates another session", async () => {
  const original = createReviewFixture();
  original.rails().backgroundTasks.onOpenTaskDetail?.(original.task);
  const restored = createReviewFixture({}, true);
  const request = vi
    .spyOn(restored.state.client!, "request")
    .mockImplementation((method) =>
      method === "tasks.get"
        ? Promise.reject(new Error("Task service unavailable"))
        : Promise.resolve({ tasks: [] }),
    );
  await vi.waitFor(async () => {
    await restored.renderPanels();
    expect(restored.mount.textContent).toContain("Task service unavailable");
  });
  await restored.renderPanels();
  expect(request.mock.calls.filter(([method]) => method === "tasks.get")).toHaveLength(1);
  expect(restored.rails().backgroundTasks.selectedTaskId).toBe(original.task.id);
  request.mockImplementation((method) =>
    Promise.resolve(method === "tasks.get" ? { task: restored.task } : { tasks: [] }),
  );
  [...restored.mount.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Try again")!
    .click();
  await vi.waitFor(async () => {
    await restored.renderPanels();
    expect(
      restored.mount.querySelector("[data-task-detail-panel] .sidebar-title")?.textContent,
    ).toBe(original.task.title);
  });
  expect(request.mock.calls.filter(([method]) => method === "tasks.get")).toHaveLength(2);
  patchSettings({ sessionKey: "agent:other:review-intent" });
  const other = createReviewFixture({}, true);
  await other.renderPanels();
  expect(other.mount.querySelector("[data-task-detail-panel]")).toBeNull();
  expect(other.rails().backgroundTasks.selectedTaskId).toBeUndefined();
});

it("keeps a restored task from another scope unavailable without adopting its details", async () => {
  const original = createReviewFixture();
  original.rails().backgroundTasks.onOpenTaskDetail?.(original.task);
  const restored = createReviewFixture({}, true);
  vi.spyOn(restored.state.client!, "request").mockImplementation((method) =>
    Promise.resolve(
      method === "tasks.get"
        ? {
            task: { ...restored.task, sessionKey: "agent:other:private", prompt: "Private result" },
          }
        : { tasks: [] },
    ),
  );
  await vi.waitFor(async () => {
    await restored.renderPanels();
    expect(restored.mount.textContent).toContain("This task is no longer available.");
  });
  expect(restored.mount.textContent).not.toContain("Private result");
  expect(restored.rails().backgroundTasks.taskDetails.has(original.task.id)).toBe(false);
  expect(restored.rails().backgroundTasks.selectedTaskId).toBe(original.task.id);
  expect(restored.mount.textContent).toContain("Back to tasks");
});

it("persists Back while a restored lookup is pending without allowing its late result to reopen detail", async () => {
  const original = createReviewFixture();
  original.rails().backgroundTasks.onOpenTaskDetail?.(original.task);
  const restored = createReviewFixture({}, true);
  const pending = createDeferred<unknown>();
  vi.spyOn(restored.state.client!, "request").mockImplementation((method) =>
    method === "tasks.get" ? pending.promise : Promise.resolve({ tasks: [] }),
  );
  await vi.waitFor(async () => {
    await restored.renderPanels();
    expect(restored.rails().backgroundTasks.taskDetailLoadingIds.has(original.task.id)).toBe(true);
  });
  [...restored.mount.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Back to tasks")!
    .click();
  pending.resolve({ task: restored.task });
  await pending.promise;
  await restored.renderPanels();
  expect(restored.mount.querySelector("[data-task-detail-panel]")).toBeNull();
  expect(restored.rails().backgroundTasks.selectedTaskId).toBeUndefined();
  const reloaded = createReviewFixture({}, true);
  await reloaded.renderPanels();
  expect(isSidebarSlotVisible(reloaded.state.sidebarLayout, "tasks")).toBe(true);
  expect(reloaded.rails().backgroundTasks.selectedTaskId).toBeUndefined();
  expect(reloaded.mount.querySelector("[data-task-detail-panel]")).toBeNull();
});

it("restores explicit Git Review without replacing the independent Tasks selection", async () => {
  const original = createReviewFixture();
  original.rails().backgroundTasks.onOpenTaskDetail?.(original.task);
  original.state.handleOpenSidebar({ kind: "session-diff", load: vi.fn() });
  const restored = createReviewFixture({}, true);
  restored.state.hello = gatewayHelloForMethods(["sessions.diff"]);
  await restored.renderPanels();
  expect(isSidebarSlotVisible(restored.state.sidebarLayout, "detail")).toBe(true);
  expect(restored.mount.querySelector("openclaw-session-diff")).not.toBeNull();
  expect(
    restored.mount
      .querySelector("[data-task-detail-panel]")
      ?.closest("[data-panel-slot]")
      ?.hasAttribute("hidden"),
  ).toBe(true);
  expect(restored.rails().backgroundTasks.selectedTaskId).toBe(original.task.id);
  restored.state.updateSidebarLayout(openSlot(restored.state.sidebarLayout, "tasks"));
  await vi.waitFor(async () => {
    await restored.renderPanels();
    expect(
      restored.mount.querySelector("[data-task-detail-panel] .sidebar-title")?.textContent,
    ).toBe(original.task.title);
  });
  expect(isSidebarSlotVisible(restored.state.sidebarLayout, "tasks")).toBe(true);
});
