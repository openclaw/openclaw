/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createReviewFixture } from "../../test-helpers/chat-pane-embedded-panels.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import { renderBackgroundTasksStatusRow } from "./components/chat-background-tasks-status.ts";
import {
  openSessionWorkspaceFile,
  retireSessionWorkspaceCheckout,
} from "./components/chat-session-workspace.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import {
  closeSlot,
  isSidebarSlotVisible,
  openSlot,
  setSidebarOpen,
  sidebarActivePanel,
  toggleSidebarPanelExpanded,
} from "./sidebar-layout.ts";

afterEach(() => {
  document.body.replaceChildren();
});

describe("chat pane embedded panels", () => {
  describe("Tasks selection lifetime", () => {
    beforeEach(installTranscriptDomMocks);
    afterEach(resetTranscriptTestDom);
    it.each(["pending", "unavailable", "checkout retired", "file closed", "task closed"] as const)(
      "keeps task ownership independent of file selection %s",
      async (selection) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(10_000);
        onTestFinished(() => {
          vi.useRealTimers();
        });
        const { file, history, mount, preview, rails, renderPanels, state, task } =
          createReviewFixture({ childSessionKey: "agent:main:subagent:review-child" });
        rails().backgroundTasks.onOpenTaskDetail?.(task);
        await renderPanels();
        await renderPanels();
        expect(mount.textContent).toContain("The selected task transcript.");
        expect(
          mount
            .querySelector("[data-task-detail-panel]")
            ?.closest("[data-panel-slot]")
            ?.getAttribute("data-panel-slot"),
        ).toBe("tasks");
        expect(history).toHaveBeenCalledExactlyOnceWith({ taskId: task.id, limit: 100 });

        if (selection !== "task closed") {
          openSessionWorkspaceFile(state, { path: preview.file.path });
          await renderPanels();
          expect(mount.querySelector('[data-panel-skeleton="files"]')).not.toBeNull();
        }
        if (selection === "unavailable") {
          file.reject(new Error("Preview unavailable"));
          await expect(file.promise).rejects.toThrow("Preview unavailable");
        } else if (selection === "checkout retired") {
          retireSessionWorkspaceCheckout(state);
        } else if (selection === "file closed" || selection === "task closed") {
          mount
            .querySelector<HTMLButtonElement>(
              selection === "task closed"
                ? 'button[aria-label="Close Tasks"]'
                : 'button[aria-label="Close tab: preview.png"]',
            )!
            .click();
        }
        await renderPanels();
        if (selection === "unavailable") {
          expect(mount.querySelector('[role="alert"]')?.textContent).toContain(
            "Preview unavailable",
          );
        } else if (selection === "task closed") {
          expect(mount.querySelector('[data-panel-slot="tasks"]')).toBeNull();
        } else if (selection === "file closed") {
          expect(state.sessionWorkspaceState?.previews).toEqual([]);
        } else if (selection === "checkout retired") {
          expect(mount.querySelector('[data-panel-skeleton="files"]')).toBeNull();
        }
        vi.setSystemTime(12_000);
        handlePageGatewayEvent(state, {
          type: "event",
          event: "task",
          payload: { action: "upserted", task: { ...task, updatedAt: 3 } },
        });
        expect(history).toHaveBeenCalledTimes(selection === "task closed" ? 1 : 2);
        if (selection === "task closed") {
          expect(mount.querySelector("[data-task-detail-panel]")).toBeNull();
        } else {
          expect(mount.querySelector("[data-task-detail-panel]")).not.toBeNull();
        }
      },
    );

    it.each(["Files", "Review", "minimized"] as const)(
      "retains the selected Tasks transcript while %s is presented",
      async (presentation) => {
        const { history, mount, rails, renderPanels, state, task } = createReviewFixture({
          childSessionKey: "agent:main:subagent:review-child",
        });
        rails().backgroundTasks.onOpenTaskDetail?.(task);
        await renderPanels();
        await renderPanels();
        expect(mount.textContent).toContain("The selected task transcript.");

        if (presentation === "Files") {
          state.handleOpenSidebar({
            kind: "attachment",
            attachmentKind: "image",
            title: "Attachment in Files",
            src: "/synthetic/attachment.png",
          });
        } else if (presentation === "Review") {
          state.handleOpenSidebar({ kind: "markdown", content: "Independent Review selection" });
        } else {
          state.updateSidebarLayout(setSidebarOpen(state.sidebarLayout, false));
        }
        await renderPanels();
        expect.soft(history).toHaveBeenCalledOnce();
        expect(isSidebarSlotVisible(state.sidebarLayout, "tasks")).toBe(false);
        if (presentation === "Files") {
          expect(
            mount.querySelector<HTMLImageElement>(".sidebar-attachment-preview__image")?.alt,
          ).toBe("Attachment in Files");
        }
        state.updateSidebarLayout(openSlot(state.sidebarLayout, "tasks"));
        await renderPanels();
        expect(mount.textContent).toContain("The selected task transcript.");
        expect(history).toHaveBeenCalledExactlyOnceWith({ taskId: task.id, limit: 100 });
      },
    );

    it.each(["Back", "running count"] as const)(
      "%s preserves expanded Tasks layout without refreshing and releases pending transcript work",
      async (action) => {
        const { history, mount, rails, renderPanels, state, task } = createReviewFixture({
          runtime: "cli",
          status: "running",
          hasTranscript: true,
          sessionKey: undefined,
        });
        const pending = createDeferred<{ messages: unknown[] }>();
        history.mockReturnValue(pending.promise);
        rails().openPanelSlot("tasks");
        await renderPanels();
        await renderPanels();
        state.updateSidebarLayout(
          toggleSidebarPanelExpanded(
            state.sidebarLayout,
            sidebarActivePanel(state.sidebarLayout)!.id,
          ),
        );
        await renderPanels();
        const layout = state.sidebarLayout;
        expect(layout).toMatchObject({ expanded: true, expandedSide: true });
        const request = vi.spyOn(state.client!, "request");
        mount.querySelector<HTMLButtonElement>(".chat-tasks-rail__task-open")!.click();
        await renderPanels();
        expect.soft(state.sidebarLayout).toEqual({
          ...layout,
          columns: layout.columns.map((column) => ({
            ...column,
            panels: column.panels.map((panel) =>
              panel.slot === "tasks" ? { ...panel, taskId: task.id } : panel,
            ),
          })),
        });
        expect(state.taskDetailState?.taskId).toBe(task.id);
        expect(
          mount
            .querySelector("[data-task-detail-panel]")
            ?.closest("[data-panel-slot]")
            ?.getAttribute("data-panel-slot"),
        ).toBe("tasks");
        expect(mount.querySelector(".chat-tasks-rail__list")).toBeNull();
        if (action === "Back") {
          [...mount.querySelectorAll<HTMLButtonElement>("button")]
            .find((button) => button.textContent?.trim() === "Back to tasks")!
            .click();
        } else {
          const status = document.body.appendChild(document.createElement("div"));
          render(renderBackgroundTasksStatusRow(rails().backgroundTasks), status);
          status.querySelector<HTMLButtonElement>(".chat-tasks-status__link")!.click();
        }
        expect(rails().backgroundTasks.selectedTaskId).toBeUndefined();
        expect(state.taskDetailState).toBeUndefined();
        expect.soft(state.sidebarLayout).toEqual(layout);
        expect.soft(request.mock.calls.filter(([method]) => method === "tasks.list")).toEqual([]);
        pending.resolve({ messages: [{ role: "assistant", content: "Late private transcript" }] });
        await pending.promise;
        await renderPanels();
        expect(mount.querySelector("[data-task-detail-panel]")).toBeNull();
        expect(mount.querySelector(".chat-tasks-rail__task-open")?.textContent).toContain(
          task.title,
        );
        expect(mount.textContent).not.toContain("Late private transcript");
        expect(state.taskDetailState).toBeUndefined();
      },
    );

    it.each(["refusal", "rejection", "late rejection"] as const)(
      "keeps a cancellation %s scoped to its task detail and visible in the list",
      async (outcome) => {
        const { mount, rails, renderPanels, state, task } = createReviewFixture({
          status: "running",
        });
        state.hello = {
          type: "hello-ok",
          protocol: 4,
          auth: { role: "operator", scopes: ["operator.write"] },
        };
        rails().backgroundTasks.onOpenTaskDetail?.(task);
        await renderPanels();
        await renderPanels();
        const completedTask = {
          ...task,
          id: "completed-task",
          taskId: "completed-task",
          status: "completed" as const,
          title: "Another completed task",
        };
        state.backgroundTasksState!.tasks!.push(completedTask);
        state.backgroundTasksState!.taskDetails.set(completedTask.id, completedTask);
        const openCompletedTask = async () => {
          rails().backgroundTasks.onOpenTaskList?.();
          await renderPanels();
          rails().backgroundTasks.onToggleFinished();
          await renderPanels();
          [...mount.querySelectorAll<HTMLButtonElement>(".chat-tasks-rail__task-open")]
            .find((button) => button.textContent?.includes(completedTask.title))!
            .click();
          await renderPanels();
          expect(mount.querySelector("[data-task-detail-panel] .sidebar-title")?.textContent).toBe(
            completedTask.title,
          );
        };
        const message =
          outcome === "refusal" ? "Task cannot be cancelled" : "Cancellation unavailable";
        const pending = createDeferred<unknown>();
        const request = vi.spyOn(state.client!, "request");
        if (outcome === "refusal") {
          request.mockResolvedValueOnce({ found: true, cancelled: false, reason: message });
        } else if (outcome === "late rejection") {
          request.mockReturnValueOnce(pending.promise);
        } else {
          request.mockRejectedValueOnce(new Error(message));
        }
        mount
          .querySelector<HTMLButtonElement>(
            "[data-task-detail-panel] .sidebar-header__actions button",
          )!
          .click();
        expect(request).toHaveBeenCalledExactlyOnceWith("tasks.cancel", { taskId: task.id });
        if (outcome === "late rejection") {
          await openCompletedTask();
          pending.reject(new Error(message));
        }
        await request.mock.results[0]!.value.catch(() => undefined);
        expect(state.backgroundTasksState?.error).toBe(message);
        if (outcome !== "late rejection") {
          await renderPanels();
          expect(
            mount.querySelector('[data-task-detail-panel] [role="alert"]')?.textContent,
          ).toContain(message);
          await openCompletedTask();
        }
        await renderPanels();
        expect.soft(mount.querySelector('[data-task-detail-panel] [role="alert"]')).toBeNull();
        rails().backgroundTasks.onOpenTaskDetail?.(task);
        await renderPanels();
        expect
          .soft(mount.querySelector('[data-task-detail-panel] [role="alert"]')?.textContent)
          .toContain(message);
        [...mount.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.trim() === "Back to tasks")!
          .click();
        await renderPanels();
        expect(mount.querySelector("[data-task-detail-panel]")).toBeNull();
        expect(mount.querySelector('.chat-tasks-rail [role="alert"]')?.textContent).toContain(
          message,
        );
        expect(state.backgroundTasksState?.error).toBe(message);
        expect(request).toHaveBeenCalledOnce();
        if (outcome === "refusal") {
          const refreshed = createDeferred();
          const requestUpdate = state.requestUpdate;
          vi.spyOn(state, "requestUpdate").mockImplementation(() => {
            requestUpdate?.();
            if (!state.backgroundTasksState?.loading) {
              refreshed.resolve();
            }
          });
          request.mockRejectedValue(new Error("Task list unavailable"));
          rails().backgroundTasks.onRefresh();
          await refreshed.promise;
          await renderPanels();
          expect(mount.querySelector('.chat-tasks-rail [role="alert"]')?.textContent).toContain(
            "Task list unavailable",
          );
          rails().backgroundTasks.onOpenTaskDetail?.(completedTask);
          await renderPanels();
          expect(
            mount.querySelector('[data-task-detail-panel] [role="alert"]')?.textContent,
          ).toContain("Task list unavailable");
        }
      },
    );

    it.each(["close slot", "replace layout"] as const)(
      "clears selection synchronously through the %s update route and reopens the list",
      async (route) => {
        const { history, mount, rails, renderPanels, state, task } = createReviewFixture({
          childSessionKey: "agent:main:subagent:review-child",
          status: "running",
        });
        rails().backgroundTasks.onOpenTaskDetail?.(task);
        await renderPanels();
        await renderPanels();
        expect(state.taskDetailState).toBeDefined();
        state.updateSidebarLayout(
          route === "close slot" ? closeSlot(state.sidebarLayout, "tasks") : { columns: [] },
          { persist: false },
        );
        expect(rails().backgroundTasks.selectedTaskId).toBeUndefined();
        expect(state.taskDetailState).toBeUndefined();
        rails().openPanelSlot("tasks");
        await renderPanels();
        expect(mount.querySelector("[data-task-detail-panel]")).toBeNull();
        expect(mount.querySelector(".chat-tasks-rail__task-open")).not.toBeNull();
        expect(history).toHaveBeenCalledOnce();
      },
    );

    it("keeps Review diff selection and loader independent of opening and leaving task details", async () => {
      const { mount, rails, renderPanels, state, task } = createReviewFixture({
        childSessionKey: "agent:main:subagent:review-child",
      });
      const load = vi.fn().mockResolvedValue({
        sessionKey: state.sessionKey,
        branch: "feature/review",
        baseRef: "main",
        additions: 1,
        deletions: 1,
        files: [{ path: "example.txt", status: "modified", additions: 1, deletions: 1 }],
      });
      state.handleOpenSidebar({ kind: "session-diff", load });
      const selection = state.sidebarContent;
      await renderPanels();
      await vi.waitFor(() =>
        expect(mount.querySelector(".session-diff__file-toggle")).not.toBeNull(),
      );
      const diff = mount.querySelector("openclaw-session-diff");
      const toggle = mount.querySelector<HTMLButtonElement>(".session-diff__file-toggle")!;
      toggle.click();
      await vi.waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
      rails().backgroundTasks.onOpenTaskDetail?.(task);
      await renderPanels();
      await renderPanels();
      expect(state.sidebarContent).toBe(selection);
      expect(mount.querySelector("openclaw-session-diff")).toBe(diff);
      rails().backgroundTasks.onOpenTaskList?.();
      state.updateSidebarLayout(openSlot(state.sidebarLayout, "detail"));
      await renderPanels();
      expect(mount.querySelector("openclaw-session-diff")).toBe(diff);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(load).toHaveBeenCalledOnce();
      expect(state.sidebarContent).toBe(selection);
    });

    it("keeps a Back action when the selected task disappears", async () => {
      const { mount, rails, renderPanels, state, task } = createReviewFixture({
        childSessionKey: "agent:main:subagent:review-child",
      });
      rails().backgroundTasks.onOpenTaskDetail?.(task);
      await renderPanels();
      await renderPanels();
      handlePageGatewayEvent(state, {
        type: "event",
        event: "task",
        payload: { action: "deleted", taskId: task.id },
      });
      await renderPanels();
      expect(mount.textContent).toContain("This task is no longer available.");
      expect(state.taskDetailState).toBeUndefined();
      [...mount.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Back to tasks")!
        .click();
      await renderPanels();
      expect(mount.querySelector("[data-task-detail-panel]")).toBeNull();
      expect(rails().backgroundTasks.selectedTaskId).toBeUndefined();
    });
  });

  it("keeps a newer task selection visible when a pending file preview completes", async () => {
    const { file, mount, preview, rails, renderPanels, state, task } = createReviewFixture();
    rails().backgroundTasks.onOpenTaskDetail?.(task);
    await renderPanels();
    await renderPanels();
    expect(mount.querySelector("[data-task-detail-panel] .sidebar-title")?.textContent).toBe(
      task.title,
    );

    openSessionWorkspaceFile(state, { path: preview.file.path });
    await renderPanels();
    expect(mount.querySelector('[data-panel-skeleton="files"]')).not.toBeNull();
    rails().backgroundTasks.onOpenTaskDetail?.(task);
    await renderPanels();
    expect
      .soft(mount.querySelector("[data-task-detail-panel] .sidebar-title")?.textContent)
      .toBe(task.title);
    expect(isSidebarSlotVisible(state.sidebarLayout, "tasks")).toBe(true);

    file.resolve(preview);
    await file.promise;
    await renderPanels();
    expect(mount.querySelector("[data-task-detail-panel] .sidebar-title")?.textContent).toBe(
      task.title,
    );
    expect(isSidebarSlotVisible(state.sidebarLayout, "tasks")).toBe(true);
  });
});
