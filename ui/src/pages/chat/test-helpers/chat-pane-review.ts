import { html, render, type LitElement } from "lit";
import { onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { SessionWorkspaceGetResult, SessionWorkspaceListResult } from "../../../api/types.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { sidebarPanelDefinitions, sidebarPanelTemplates } from "../chat-pane-embedded-panels.ts";
import { createChatPaneRails } from "../chat-pane-rails.ts";
import { renderSidebarRegion } from "../chat-pane-sidebar-layout.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  createSessionCapabilityFixture,
} from "../chat-pane.test-support.ts";
import { createPageState } from "../chat-state-page.ts";
import type { ChatProps } from "../chat-view.ts";
import { createBackgroundTasksProps } from "../components/chat-background-tasks.ts";
import { renderChatDetailSlot } from "../components/chat-detail-slot.ts";
import {
  createSessionWorkspaceProps,
  renderSessionWorkspaceRail,
} from "../components/chat-session-workspace.ts";
import { resetTaskDetail } from "../components/chat-task-detail-state.ts";
import { threadProps } from "../components/chat-transcript.test-support.ts";
import type { SidebarLayout, SidebarSlotId } from "../sidebar-layout.ts";
import "../components/chat-detail-panel.ts";
import "../components/chat-sidebar-region.runtime.ts";

export async function renderPanelFixture(
  mount: HTMLElement,
  layout: SidebarLayout,
  definitions: ReturnType<typeof sidebarPanelDefinitions>,
  closePanelSlot: (slot: SidebarSlotId) => void = vi.fn(),
) {
  render(
    renderSidebarRegion({
      availableWidth: 1400,
      availableSlots: ["detail", "workspace"],
      callbacks: {
        activatePanel: vi.fn(),
        togglePanelExpanded: vi.fn(),
        closeSlot: closePanelSlot,
        openSlot: vi.fn(),
        reorderPanel: vi.fn(),
        resizePanel: vi.fn(),
        setOpen: vi.fn(),
      },
      layout,
      narrow: false,
      panelDefinitions: definitions,
      panelActions: {},
      panelTemplates: sidebarPanelTemplates(definitions),
      primary: html`<main>Chat</main>`,
      requestUpdate: vi.fn(),
    }),
    mount,
  );
  await mount.querySelector("openclaw-chat-sidebar-region")?.updateComplete;
  await mount.querySelector<LitElement>("openclaw-chat-files-panel")?.updateComplete;
  await Promise.all(
    [...mount.querySelectorAll<LitElement>("openclaw-chat-detail-panel")].map(
      (panel) => panel.updateComplete,
    ),
  );
  await mount.querySelector("openclaw-panel-loading-skeleton")?.updateComplete;
}

export function createReviewFixture(taskFields: Partial<TaskSummary> = {}, restoreLayout = false) {
  const file = createDeferred<SessionWorkspaceGetResult | null>();
  const list = createDeferred<SessionWorkspaceListResult | null>();
  const sessions = createSessionCapabilityFixture({
    getFile: vi.fn(() => file.promise),
    listFiles: vi.fn(() => list.promise),
  });
  const mount = document.body.appendChild(document.createElement("div"));
  const context = { ...createInitializationContext(), sessions };
  const state = createPageState(
    context,
    { invalidate: vi.fn(), afterCommit: () => () => {} },
    mount,
  );
  const history = vi.fn().mockResolvedValue({
    messages: [{ role: "assistant", content: "The selected task transcript." }],
  });
  state.client = createGatewayBrowserClientFixture({
    request: (method, params) =>
      method === "tasks.history"
        ? history(params)
        : method === "tasks.list"
          ? { tasks: [] }
          : { artifacts: [] },
  });
  state.connected = true;
  state.connectionEpoch = 1;
  state.sessionKey = restoreLayout ? state.settings.sessionKey : "agent:main:review-intent";
  if (!restoreLayout) {
    state.sidebarLayout = { columns: [] };
  }
  const task = {
    id: "review-task",
    taskId: "review-task",
    runtime: "subagent",
    status: "completed",
    title: "Inspect the completed task",
    prompt: "Review the synthetic result",
    terminalSummary: "Review completed",
    sessionKey: state.sessionKey,
    agentId: "main",
    createdAt: 1,
    updatedAt: 2,
    ...taskFields,
  } satisfies TaskSummary;
  const backgroundTasks = {
    ...createBackgroundTasksProps(state, { presented: false }),
    tasks: [task],
    taskDetails: new Map([[task.id, task]]),
  };
  const preview = {
    sessionKey: state.sessionKey,
    root: "/synthetic/workspace",
    file: {
      kind: "read",
      path: "images/preview.png",
      name: "preview.png",
      missing: false,
      previewKind: "image",
      contentEncoding: "base64",
      mimeType: "image/png",
      content:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV9kAAAAASUVORK5CYII=",
    },
  } satisfies SessionWorkspaceGetResult;
  const rails = () =>
    createChatPaneRails({
      state,
      sidebarLayout: state.sidebarLayout,
      presentationId: "review-intent",
      presented: true,
      gatewaySnapshot: { ...context.gateway.snapshot, phase: "connected" },
      setObserverVisibility: vi.fn(),
      updateSidebarLayout: state.updateSidebarLayout,
    });
  onTestFinished(async () => {
    file.resolve(null);
    list.resolve(null);
    await Promise.allSettled([file.promise, list.promise]);
    resetTaskDetail(state);
  });
  const renderPanels = async () => {
    const definitions = sidebarPanelDefinitions({
      state,
      renderDetail: (content) =>
        renderChatDetailSlot({
          backgroundTasks,
          chat: threadProps("review-intent", state.sessionKey) as ChatProps,
          content,
          host: state,
          layout: state.sidebarLayout,
        }),
      workspace: renderSessionWorkspaceRail(createSessionWorkspaceProps(state), {
        embedded: true,
      }),
    } as Parameters<typeof sidebarPanelDefinitions>[0]);
    await renderPanelFixture(mount, state.sidebarLayout, definitions, rails().closePanelSlot);
  };
  return {
    backgroundTasks,
    file,
    history,
    list,
    mount,
    preview,
    rails,
    renderPanels,
    sessions,
    state,
    task,
  };
}
