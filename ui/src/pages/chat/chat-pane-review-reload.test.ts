/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { setSidebarOpen } from "./sidebar-layout.ts";
import { createReviewFixture } from "./test-helpers/chat-pane-review.ts";
afterEach(() => document.body.replaceChildren());

it("restores the selected task from saved Review layout after a fresh page mount", async () => {
  const previous = loadSettings();
  onTestFinished(() => {
    patchSettings(previous);
  });
  patchSettings({ sessionKey: "agent:main:review-intent" });
  const original = createReviewFixture();
  original.rails().backgroundTasks.onOpenTaskDetail?.(original.task);
  await original.renderPanels();
  expect(original.mount.querySelector("[data-task-detail-panel] .sidebar-title")?.textContent).toBe(
    original.task.title,
  );
  render(nothing, original.mount);
  const restored = createReviewFixture({}, true);
  restored.backgroundTasks.tasks = [];
  await restored.renderPanels();
  expect(restored.mount.querySelector("[data-task-detail-panel] .sidebar-title")?.textContent).toBe(
    original.task.title,
  );
  expect(restored.rails().backgroundTasks.openTaskId).toBe(original.task.id);
  restored.state.updateSidebarLayout(setSidebarOpen(restored.state.sidebarLayout, false));
  restored.state.updateSidebarLayout(setSidebarOpen(restored.state.sidebarLayout, true));
  await restored.renderPanels();
  expect(restored.mount.querySelector("[data-task-detail-panel] .sidebar-title")?.textContent).toBe(
    original.task.title,
  );
  restored.state.handleOpenSidebar({ kind: "task", taskId: original.task.id });
  restored.rails().closePanelSlot("detail");
  expect(restored.state.sidebarContent).toBeNull();
  const closed = createReviewFixture({}, true);
  await closed.renderPanels();
  expect(closed.mount.querySelector("[data-task-detail-panel]")).toBeNull();
  expect(closed.rails().backgroundTasks.openTaskId).toBeUndefined();
});

it("keeps an unavailable restored task explicit and another session isolated", async () => {
  const previous = loadSettings();
  onTestFinished(() => {
    patchSettings(previous);
  });
  patchSettings({ sessionKey: "agent:main:review-intent" });
  const original = createReviewFixture();
  original.rails().backgroundTasks.onOpenTaskDetail?.(original.task);
  const missing = createReviewFixture({ id: "different-task", taskId: "different-task" }, true);
  await missing.renderPanels();
  expect(missing.mount.querySelector("[data-task-detail-panel]")?.textContent).toContain(
    "This task is no longer available.",
  );
  expect(missing.rails().backgroundTasks.openTaskId).toBe(original.task.id);
  patchSettings({ sessionKey: "agent:other:review-intent" });
  const other = createReviewFixture({}, true);
  await other.renderPanels();
  expect(other.mount.querySelector("[data-task-detail-panel]")).toBeNull();
  expect(other.rails().backgroundTasks.openTaskId).toBeUndefined();
});

it("restores explicit Git Review instead of the previously selected task", async () => {
  const previous = loadSettings();
  onTestFinished(() => {
    patchSettings(previous);
  });
  patchSettings({ sessionKey: "agent:main:review-intent" });
  const original = createReviewFixture();
  original.rails().backgroundTasks.onOpenTaskDetail?.(original.task);
  original.state.handleOpenSidebar({ kind: "session-diff", load: vi.fn() });
  const restored = createReviewFixture({}, true);
  restored.state.hello = gatewayHelloForMethods(["sessions.diff"]);
  await restored.renderPanels();
  expect(restored.mount.querySelector("[data-task-detail-panel]")).toBeNull();
  expect(restored.mount.querySelector("openclaw-session-diff")).not.toBeNull();
  expect(restored.rails().backgroundTasks.openTaskId).toBeUndefined();
});
