import { html, render, type LitElement } from "lit";
import { onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionWorkspaceGetResult, SessionWorkspaceListResult } from "../api/types.ts";
import {
  sidebarPanelDefinitions,
  sidebarPanelTemplates,
} from "../pages/chat/chat-pane-embedded-panels.ts";
import { createChatPaneRails } from "../pages/chat/chat-pane-rails.ts";
import { renderSidebarRegion } from "../pages/chat/chat-pane-sidebar-layout.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  createSessionCapabilityFixture,
} from "../pages/chat/chat-pane.test-support.ts";
import { createPageState } from "../pages/chat/chat-state-page.ts";
import type { ChatProps } from "../pages/chat/chat-view.ts";
import { renderChatDetailSlot } from "../pages/chat/components/chat-detail-slot.ts";
import "../pages/chat/components/chat-detail-panel.ts";
import {
  createSessionWorkspaceProps,
  renderSessionWorkspaceRail,
} from "../pages/chat/components/chat-session-workspace.ts";
import "../pages/chat/components/chat-sidebar-region.runtime.ts";
import { threadProps } from "../pages/chat/components/chat-transcript.test-support.ts";
import type { SidebarLayout, SidebarSlotId } from "../pages/chat/sidebar-layout.ts";

export async function renderPanelFixture(
  mount: HTMLElement,
  layout: SidebarLayout,
  definitions: ReturnType<typeof sidebarPanelDefinitions>,
  closePanelSlot: (slot: SidebarSlotId) => void = vi.fn(),
) {
  render(
    renderSidebarRegion({
      presentationId: "sidebar-layout-fixture",
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

export function createReviewFixture() {
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
  state.client = createGatewayBrowserClientFixture();
  state.connected = true;
  state.connectionEpoch = 1;
  state.sessionKey = "agent:main:review-intent";
  state.sidebarLayout = { columns: [] };
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
  });
  const renderPanels = async () => {
    const { closePanelSlot } = rails();
    const definitions = sidebarPanelDefinitions({
      state,
      renderDetail: (content) =>
        renderChatDetailSlot({
          chat: threadProps("review-intent", state.sessionKey) as ChatProps,
          content,
          host: state,
        }),
      workspace: renderSessionWorkspaceRail(createSessionWorkspaceProps(state), {
        embedded: true,
      }),
    } as Parameters<typeof sidebarPanelDefinitions>[0]);
    await renderPanelFixture(mount, state.sidebarLayout, definitions, closePanelSlot);
  };
  return { file, list, mount, preview, rails, renderPanels, sessions, state };
}
