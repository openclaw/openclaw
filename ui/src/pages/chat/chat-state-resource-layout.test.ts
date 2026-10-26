import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadSettings, saveSettings } from "../../app/settings.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createChatPaneRails } from "./chat-pane-rails.ts";
import { createChatPageStateContext } from "./chat-state-context.test-support.ts";
import { createPageState } from "./chat-state-page.ts";
import { sessionWorkspaceForHost } from "./components/chat-session-workspace-state.ts";
import { openSessionWorkspaceFile } from "./components/chat-session-workspace.ts";
import { activatePanel, openSlot, toggleSidebarPanelExpanded } from "./sidebar-layout.ts";

it.each(["minimize", "close-resource", "explicit-desktop"])(
  "preserves resource layout intent through %s",
  (action) => {
    const savedSettings = loadSettings();
    saveSettings({ ...savedSettings, sidebarSessionLayouts: {} });
    try {
      const context = createChatPageStateContext();
      const renderLifecycle = { afterCommit: () => () => {} };
      const host = {
        dispatchEvent: () => true,
        getBoundingClientRect: () => new DOMRect(0, 0, 1440, 900),
      };
      const state = createPageState(context, renderLifecycle, host);
      state.updateSidebarLayout(openSlot(state.sidebarLayout, "desktop"), {
        persist: false,
        automaticResource: "desktop",
      });
      const beforeDismissalReload = createPageState(context, renderLifecycle, host);
      expect(beforeDismissalReload.sidebarLayout.columns).toEqual([]);
      state.updateSidebarLayout({ ...openSlot(state.sidebarLayout, "workspace"), dock: "bottom" });
      const afterLayoutChange = createPageState(context, renderLifecycle, host);
      expect(
        afterLayoutChange.sidebarLayout.columns.flatMap((column) =>
          column.panels.map((panel) => panel.slot),
        ),
      ).toEqual(["workspace"]);
      expect(afterLayoutChange.sidebarLayout.dock).toBe("bottom");
      expect(state.sidebarLayout.resourceAutoOpenDismissed).toBeUndefined();
      if (action === "explicit-desktop") {
        const explicit = openSlot(state.sidebarLayout, "desktop");
        for (const panel of explicit.columns.flatMap((column) => column.panels)) {
          if (panel.slot === "desktop") {
            panel.environmentId = "manual-desktop";
          }
        }
        state.updateSidebarLayout(explicit);
        state.updateSidebarLayout(state.sidebarLayout, {
          persist: false,
          retireAutomaticResource: "desktop",
        });
        expect(state.sidebarLayout.columns.flatMap((column) => column.panels)).toContainEqual(
          expect.objectContaining({ slot: "desktop", environmentId: "manual-desktop" }),
        );
        const reloaded = createPageState(context, renderLifecycle, host);
        const panels = reloaded.sidebarLayout.columns.flatMap((column) => column.panels);
        expect(panels.find((panel) => panel.slot === "desktop")).toMatchObject({
          environmentId: "manual-desktop",
        });
        expect(panels.some((panel) => panel.slot === "browser")).toBe(false);
        expect(reloaded.sidebarLayout.resourceAutoOpenDismissed).toBeUndefined();
        return;
      }
      if (action === "minimize") {
        state.updateSidebarLayout({ ...state.sidebarLayout, open: false });
      } else {
        state.updateSidebarLayout({ ...state.sidebarLayout, columns: [] });
      }
      expect(state.sidebarLayout.resourceAutoOpenDismissed).toBe(true);
      const reloaded = createPageState(context, renderLifecycle, host);
      expect(reloaded.sidebarLayout.resourceAutoOpenDismissed).toBe(true);
      state.updateSidebarLayout(openSlot(state.sidebarLayout, "browser"));
      expect(state.sidebarLayout.resourceAutoOpenDismissed).toBe(true);
      expect(state.sidebarLayout.open).toBe(true);
    } finally {
      saveSettings(savedSettings);
    }
  },
);

it("owns attachment views in Files without replacing Detail content", () => {
  const state = createPageState(
    createChatPageStateContext(),
    { afterCommit: () => () => {} },
    {
      dispatchEvent: () => true,
      getBoundingClientRect: () => new DOMRect(0, 0, 1_440, 0),
    },
  );
  const detailContent = {
    kind: "markdown" as const,
    content: "Existing review",
    rawText: "Existing review",
  };
  state.sidebarContent = detailContent;
  state.sidebarLayout = openSlot(state.sidebarLayout, "detail");

  state.handleOpenSidebar({
    kind: "attachment",
    attachmentKind: "document",
    title: "report.pdf",
    src: "/media/report.pdf",
  });

  expect(
    state.sidebarLayout.columns.flatMap((column) => column.panels.map((panel) => panel.slot)),
  ).toEqual(["detail", "workspace"]);
  expect(state.sessionWorkspaceState?.previews.at(-1)?.content.kind).toBe("attachment");
  expect(state.sidebarContent).toBe(detailContent);

  state.sidebarLayout = activatePanel(state.sidebarLayout, "detail");
  state.handleCloseSidebar("detail");

  expect(
    state.sidebarLayout.columns.flatMap((column) => column.panels.map((panel) => panel.slot)),
  ).toEqual(["workspace"]);
  expect(state.sessionWorkspaceState?.previews.at(-1)?.content.kind).toBe("attachment");
  expect(state.sidebarContent).toBe(detailContent);

  state.handleCloseSidebar("workspace");

  expect(state.sidebarLayout.columns.flatMap((column) => column.panels)).toHaveLength(0);
  expect(state.sessionWorkspaceState?.previews ?? []).toEqual([]);
  expect(state.sidebarContent).toBe(detailContent);
});

it.each(["catalog", "catalog-after-panel-switch", "external"] as const)(
  "preserves Files expansion only for %s navigation",
  async (origin) => {
    const settings = loadSettings();
    saveSettings({ ...settings, sidebarSessionLayouts: {} });
    const context = createChatPageStateContext();
    const state = createPageState(
      context,
      { afterCommit: () => () => {} },
      {
        sessionKey: "agent:main:main",
        dispatchEvent: () => true,
        getBoundingClientRect: () => new DOMRect(0, 0, 1_440, 900),
      },
    );
    state.client = createTestGatewayClient(vi.fn());
    state.connected = true;
    const getFile = vi.spyOn(state.sessions, "getFile").mockResolvedValue({
      sessionKey: "agent:main:main",
      root: "/workspace",
      file: {
        path: "README.md",
        name: "README.md",
        kind: "read",
        missing: false,
        previewKind: "text",
        contentEncoding: "utf8",
        content: "# Project",
      },
    });
    const owner = sessionWorkspaceForHost(state);
    const settled = createDeferred();
    const stop = owner.subscribe(() => {
      if (owner.state?.previews.some((preview) => preview.content.kind === "file")) {
        settled.resolve();
      }
    });
    try {
      state.updateSidebarLayout(
        toggleSidebarPanelExpanded(
          openSlot(openSlot(state.sidebarLayout, "detail"), "workspace"),
          "workspace",
        ),
      );
      if (origin !== "external") {
        const rails = createChatPaneRails({
          state,
          sidebarLayout: state.sidebarLayout,
          presentationId: "test-pane",
          presentation: "desktop",
          presented: true,
          gatewaySnapshot: context.gateway.snapshot,
          setObserverVisibility: () => {},
          updateSidebarLayout: state.updateSidebarLayout,
        });
        rails.sessionWorkspace.onOpenFile("README.md", "session");
        if (origin === "catalog-after-panel-switch") {
          state.updateSidebarLayout(activatePanel(state.sidebarLayout, "detail"));
        }
      } else {
        void openSessionWorkspaceFile(state, { path: "README.md" });
      }
      await settled.promise;

      expect(state.sidebarLayout.expanded).toBe(origin === "catalog");
      expect(state.sidebarLayout.expandedSide).toBe(origin === "catalog" ? true : undefined);
      expect(state.sidebarLayout.columns[0]?.activePanelId).toBe(
        origin === "catalog-after-panel-switch" ? "detail" : "workspace",
      );
      expect(state.sessionWorkspaceState?.previews).toEqual([
        expect.objectContaining({
          label: "README.md",
          content: expect.objectContaining({ kind: "file", content: "# Project" }),
        }),
      ]);

      // An explicit outer tab activation still restores the split presentation.
      state.updateSidebarLayout(activatePanel(state.sidebarLayout, "detail"));
      expect(state.sidebarLayout.expanded).toBe(false);
      expect(state.sidebarLayout.columns[0]?.activePanelId).toBe("detail");
    } finally {
      stop();
      getFile.mockRestore();
      saveSettings(settings);
    }
  },
);
