/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createComponent, flush, merge } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { loadSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { showToast } from "../../lib/toast.ts";
import { openChatLayoutMenu } from "../../test-helpers/chat-layout-menu.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  submitInputDialog,
  waitForConfirmDialogActions,
  waitForInputDialog,
} from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { openSubmenu } from "../../test-helpers/session-menu.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import {
  createGatewayBrowserClientFixture,
  createPaneHeaderWorkspaceFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
  getPaneTestRuntime,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { renderPaneHeaderInto } from "./components/chat-pane-header.test-support.ts";
import { PaneHeaderView } from "./components/chat-pane-header.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { isSidebarSlotVisible, openSlot } from "./sidebar-layout.ts";

vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));

beforeEach(installTranscriptDomMocks);

afterEach(() => {
  resetTranscriptTestDom();
  vi.clearAllMocks();
});

describe("chat pane session menu boundary", () => {
  it("updates the retained header through rename and loaded workspace branch changes", async () => {
    const row: GatewaySessionRow = {
      key: "agent:main:current",
      sessionId: "current-session",
      kind: "direct",
      label: "Current conversation",
      sharingRole: "owner",
      spawnedCwd: "/workspace",
    };
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture({
        request: async (method) =>
          method === "worktrees.branches" ? { headBranch: "feature/header" } : {},
      }),
      sessions: createSessionCapabilityFixture({ state: { result: sessionsResult([row], 1) } }),
    });
    state.sessionsResult = sessionsResult([row], 1);
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods([
      "sessions.patch",
      "system.info",
      "worktrees.branches",
    ]);
    const mounted = mountSolid(() => {
      projectChatFields(pane.headerPresentation);
      return createComponent(
        PaneHeaderView,
        merge(() =>
          pane.renderPaneHeader(
            createPaneHeaderWorkspaceFixture(state),
            row,
            false,
            undefined,
            false,
            null,
          ),
        ),
      );
    });
    flush();
    const header = mounted.container;
    pane.beginHeaderRename(row);
    flush();
    const input = header.querySelector<HTMLInputElement>(".chat-pane__session-title-input")!;
    expect(input.value).toBe("Current conversation");
    input.value = "Renamed conversation";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(pane.headerPresentation.renameValue).toBe("Renamed conversation");
    pane.cancelHeaderRename();
    flush();
    expect(header.querySelector(".chat-pane__session-title-input")).toBeNull();
    await pane.loadHeaderMenuData(row, "/workspace", true);
    flush();
    expect(pane.headerPresentation.branches.get("/workspace")?.value).toBe("feature/header");
    header.querySelector<HTMLButtonElement>(".chat-pane__workspace-chip")!.click();
    flush();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-value="copy-branch"]')).not.toBeNull(),
    );
  });

  it("discovers nested sessions before the header archive choice", async () => {
    const modal = createModalDialogTestFixture();
    const row: GatewaySessionRow = {
      key: "agent:main:current",
      sessionId: "current-session",
      kind: "direct",
      label: "Parent task",
      sharingRole: "owner",
      childSessions: ["agent:main:child"],
    };
    const child: GatewaySessionRow = {
      key: "agent:main:child",
      sessionId: "child-session",
      kind: "direct",
      parentSessionKey: row.key,
    };
    let children: GatewaySessionRow[] = [];
    const patch = vi.fn();
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture({
        patch,
        state: { result: sessionsResult([row, child], 1) },
        describe: async () => ({ session: row }),
        refreshList: async (query) => {
          children = query?.spawnedBy === row.key ? [child] : [];
        },
        listSnapshot: () => ({
          result: sessionsResult(children, 1),
          agentId: "main",
          loading: false,
          error: null,
        }),
      }),
    });
    state.sessionKey = row.key;
    state.sessionsResult = sessionsResult([row, child], 1);
    try {
      const pending = modal.track(pane.handleHeaderSessionAction({ kind: "toggle-archived" }, row));
      const actions = await waitForConfirmDialogActions();
      expect(actions.textContent).toContain("Archive 2 sessions");
      answerConfirmDialog(actions, "cancel");
      await pending;
      expect(patch).not.toHaveBeenCalled();
    } finally {
      await modal.cleanup();
    }
  });

  it("pins a readable conversation in personal navigation without a session mutation", async () => {
    const row: GatewaySessionRow = {
      key: "agent:main:current",
      sessionId: "current-session",
      kind: "direct",
      sharingRole: "viewer",
      pinned: true,
    };
    const patch = vi.fn(async () => ({}));
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture({
        patch,
        state: { result: sessionsResult([row], 1) },
      }),
    });
    state.sessionKey = row.key;
    state.sessionsResult = sessionsResult([row], 1);
    await pane.handleHeaderSessionAction({ kind: "toggle-pin" }, row);
    expect(pane.context.navigation.snapshot.sidebarEntries).toContain("session:" + row.key);
    expect(patch).not.toHaveBeenCalled();
    await pane.handleHeaderSessionAction({ kind: "toggle-pin" }, row);
    expect(pane.context.navigation.snapshot.sidebarEntries).not.toContain("session:" + row.key);
    expect(row.pinned).toBe(true);
  });
  it("retains menu children and reads current callbacks after a header refresh", async () => {
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture({ state: { groups: ["Projects"] } }),
    });
    state.settings = loadSettings();
    let session: GatewaySessionRow = {
      key: state.sessionKey,
      sessionId: "current",
      kind: "direct",
      label: "Current conversation",
      sharingRole: "owner",
    };
    const container = document.body.appendChild(document.createElement("div"));
    let workspace = createPaneHeaderWorkspaceFixture(state);
    const draw = () => {
      workspace = createPaneHeaderWorkspaceFixture(state);
      renderPaneHeaderInto(
        pane.renderPaneHeader(workspace, session, false, undefined, false, null),
        container,
      );
    };
    draw();
    const menu = container.querySelector("openclaw-chat-header-session-menu")!;
    await menu.updateComplete;
    expect(menu.openMenu()).toBe(true);
    flush();
    await menu.updateComplete;
    const dropdown = menu.querySelector(".chat-header-session-menu__panel")!;
    await openSubmenu(dropdown, "View");
    const items = [...menu.querySelectorAll('[role^="menuitem"]')];
    expect(items.length).toBeGreaterThan(0);
    await menu.updateComplete;
    const reasoning = menu.querySelector('[value="view:reasoning"]')!;
    const expectRetainedMenu = () => {
      expect(menu.querySelector(".chat-header-session-menu__panel")).toBe(dropdown);
      const currentItems = [...menu.querySelectorAll('[role^="menuitem"]')];
      expect(currentItems).toHaveLength(items.length);
      for (const [index, item] of currentItems.entries()) {
        expect(item).toBe(items[index]);
      }
    };
    draw();
    await menu.updateComplete;
    expectRetainedMenu();
    const layout = await openChatLayoutMenu({
      container,
      click: async (element) => {
        element.click();
        await Promise.resolve();
        flush();
      },
    });
    layout.querySelector<HTMLButtonElement>('[data-value="session-files"]')!.click();
    await Promise.resolve();
    flush();

    expect(workspace.onToggleCollapsed).toHaveBeenCalledOnce();

    state.settings = { ...state.settings };
    session = { ...session };
    draw();
    await menu.updateComplete;
    expectRetainedMenu();

    session = { ...session, label: "Updated conversation" };
    pane.context.navigation.update({ sidebarEntries: [`session:${session.key}`] });
    draw();
    await menu.updateComplete;
    expect(menu.session.label).toBe("Updated conversation");
    expect(menu.session.pinned).toBe(true);
    expect(dropdown.getAttribute("aria-label")).toContain("Updated conversation");
    expect(dropdown.matches(":popover-open")).toBe(false);
    const previousChecked = reasoning.getAttribute("aria-checked");
    state.settings = { ...state.settings, chatShowThinking: !state.settings.chatShowThinking };
    draw();
    await menu.updateComplete;
    expect(reasoning.getAttribute("aria-checked")).toBe(previousChecked);
    expect(menu.openMenu()).toBe(true);
    flush();
    expect(menu.querySelector('[value="view:reasoning"]')).toBe(reasoning);
    expect(menu.querySelector('[value="view:reasoning"]')?.getAttribute("aria-checked")).toBe(
      String(state.settings.chatShowThinking),
    );
    const action = vi.spyOn(pane, "handleHeaderSessionAction").mockResolvedValue(undefined);
    menu.querySelector<HTMLButtonElement>('[value="toggle-pin"]')!.click();
    await menu.updateComplete;
    expect(action).toHaveBeenCalledWith({ kind: "toggle-pin" }, session);
    expect(action.mock.calls[0]?.[1]).toBe(session);
    state.applySettings = vi.fn();
    expect(menu.openMenu()).toBe(true);
    flush();
    await openSubmenu(dropdown, "View");
    menu.querySelector<HTMLButtonElement>('[value="view:tool-calls"]')!.click();
    await menu.updateComplete;
    expect(state.applySettings).toHaveBeenCalledWith({
      chatShowToolCalls: !state.settings.chatShowToolCalls,
    });
  });

  it.each(["subagents", "processes"] as const)(
    "keeps the selected %s opening intent after Layout closes",
    async (slot) => {
      const { pane, state } = createTestChatPane({ client: createGatewayBrowserClientFixture() });
      const container = document.body.appendChild(document.createElement("div"));
      const draw = () =>
        renderPaneHeaderInto(
          pane.renderPaneHeader(
            createPaneHeaderWorkspaceFixture(state),
            undefined,
            false,
            undefined,
            false,
            null,
          ),
          container,
        );
      draw();
      await Promise.resolve();
      flush();
      const menu = await openChatLayoutMenu({
        container,
        click: async (element) => {
          element.click();
          await Promise.resolve();
          flush();
        },
      });
      menu.querySelector<HTMLButtonElement>(`[value="session-${slot}"]`)!.click();
      state.updateSidebarLayout(openSlot(state.sidebarLayout, slot));
      draw();
      expect(isSidebarSlotVisible(state.sidebarLayout, slot)).toBe(true);
    },
  );

  it("keeps observed pane titles and renames with their conversations when agent selection changes", async () => {
    const primary: GatewaySessionRow = {
      key: "agent:main:dashboard:ledger",
      agentId: "main",
      sessionId: "ledger-session",
      kind: "direct",
      updatedAt: 1,
      derivedTitle: "Ledger reconciliation",
    };
    const retained: GatewaySessionRow = {
      key: "agent:research:dashboard:verifier",
      agentId: "research",
      sessionId: "verifier-session",
      kind: "direct",
      updatedAt: 1,
      derivedTitle: "Fresh pane isolation check",
    };
    const rows = [primary, retained];
    const { sessions, context, mount, emitGatewayEvent } = createMountedPanes(
      rows,
      "main",
      undefined,
      {
        "sessions.list": (_method, params) =>
          sessionsResult(
            rows.filter((row) => row.agentId === asOptionalRecord(params)?.agentId),
            1,
          ),
        "sessions.patch": (_method, params) => {
          const request = asOptionalRecord(params);
          expect(request?.key).toBe(primary.key);
          expect(request?.expectedSessionId).toBe(primary.sessionId);
          expect(request?.label).toBe("Reviewed ledger");
          rows[0] = { ...primary, label: "Reviewed ledger", updatedAt: 2 };
          return { ok: true, key: primary.key, entry: rows[0] };
        },
      },
    );
    await sessions.refresh({ agentId: "main", force: true });
    const ledger = mount(primary.key, "main");
    const verifier = mount(retained.key, "research");
    await Promise.all([ledger, verifier].map(refreshPane));
    const container = document.body.appendChild(document.createElement("div"));
    const title = (pane: TestChatPane) => {
      renderPaneHeaderInto(
        pane.renderPaneHeader(
          createPaneHeaderWorkspaceFixture(pane.state),
          selectedChatSessionRow(pane.state),
          false,
          undefined,
          false,
          null,
        ),
        container,
      );
      return container.querySelector(".chat-pane__session-title-text")?.textContent?.trim();
    };
    expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([primary.key]);
    expect.soft(title(verifier)).toBe("Fresh pane isolation check");

    context.agentSelection.set("research");
    await sessions.refresh({ agentId: "research", force: true });
    expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([retained.key]);
    expect.soft(title(ledger)).toBe("Ledger reconciliation");
    expect.soft(title(verifier)).toBe("Fresh pane isolation check");

    context.agentSelection.set("main");
    await sessions.refresh({ agentId: "main", force: true });
    emitGatewayEvent("sessions.changed", {
      sessionKey: retained.key,
      agentId: "research",
      reason: "label",
      session: { ...retained, label: "Reviewed conversation", updatedAt: 2 },
    });
    expect.soft(title(verifier)).toBe("Reviewed conversation");
    container.querySelector<HTMLButtonElement>(".chat-pane__session-title-button")?.click();
    expect(verifier.headerPresentation.renameValue).toBe("Reviewed conversation");
    verifier.cancelHeaderRename();
    expect(title(ledger)).toBe("Ledger reconciliation");

    const patch = vi.spyOn(sessions, "patch");
    container.querySelector<HTMLButtonElement>(".chat-pane__session-title-button")?.click();
    ledger.headerPresentation.renameValue = "Reviewed ledger";
    ledger.commitHeaderRename();
    expect(patch).toHaveBeenCalledOnce();
    await patch.mock.results[0]?.value;
    expect(sessions.presentation.result?.sessions[0]?.label).toBe("Reviewed ledger");
    expect(title(ledger)).toBe("Reviewed ledger");
    const menu = container.querySelector<HTMLElement & { session: { label: string } }>(
      "openclaw-chat-header-session-menu",
    );
    expect(menu?.session.label).toBe("Reviewed ledger");
  });

  it("keeps the current observed title while the roster projection is absent", async () => {
    const row: GatewaySessionRow = {
      key: "agent:main:observed-title",
      agentId: "main",
      sessionId: "observed-title-session",
      kind: "direct",
      label: "Observed conversation",
    };
    const { context, mount } = createMountedPanes([row]);
    const pane = mount(row.key);
    await refreshPane(pane);
    // The current row observation can arrive before the retained roster catches up.
    vi.spyOn(context.sessions, "presentation", "get").mockReturnValue({
      result: sessionsResult([], 1),
      agentId: "main",
    });
    const container = document.createElement("div");
    renderPaneHeaderInto(
      pane.renderPaneHeader(
        createPaneHeaderWorkspaceFixture(pane.state),
        undefined,
        false,
        undefined,
        false,
        null,
      ),
      container,
    );
    expect(container.querySelector(".chat-pane__session-title-text")?.textContent?.trim()).toBe(
      row.label,
    );
  });

  it("resolves cached titles for Home aliases using the current hello defaults", () => {
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture({
        presentation: {
          agentId: "dev",
          result: sessionsResult([{ key: "agent:dev:main", kind: "direct", label: "Dev desk" }], 1),
        },
      }),
    });
    state.sessionKey = "main";
    state.hello = {
      ...state.hello!,
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "dev",
          mainKey: "main",
          mainSessionKey: "agent:dev:main",
        },
      },
    };
    const container = document.createElement("div");
    renderPaneHeaderInto(
      pane.renderPaneHeader(
        createPaneHeaderWorkspaceFixture(state),
        undefined,
        false,
        undefined,
        false,
        null,
      ),
      container,
    );
    expect(container.querySelector(".chat-pane__session-title-text")?.textContent?.trim()).toBe(
      "Dev desk",
    );
  });

  it("keeps reconnect presentation and catalog names ahead of incomplete pane metadata", () => {
    const presentation = {
      result: sessionsResult(
        [{ key: "agent:main:current", kind: "direct", label: "Retained conversation" }],
        1,
      ),
    };
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture({ state: presentation }),
    });
    state.connected = false;
    const container = document.createElement("div");
    const row = {
      key: "agent:main:dashboard:retained",
      kind: "direct",
      derivedTitle: "Partial reconnect metadata",
    } satisfies GatewaySessionRow;
    const draw = (session: GatewaySessionRow | undefined, catalog = false) => {
      renderPaneHeaderInto(
        pane.renderPaneHeader(
          createPaneHeaderWorkspaceFixture(state),
          session,
          catalog,
          undefined,
          false,
          null,
        ),
        container,
      );
      return container.querySelector(".chat-pane__session-title-text")?.textContent?.trim();
    };
    expect(draw(undefined)).toBe("Retained conversation");
    expect(draw(row)).toBe("Retained conversation");
    expect(draw({ ...row, label: "Older scoped label" })).toBe("Retained conversation");
    const menu = container.querySelector<HTMLElement & { session: { label: string } }>(
      "openclaw-chat-header-session-menu",
    );
    expect(menu?.session.label).toBe("Retained conversation");
    pane.history.catalogSession = {
      threadId: "catalog",
      name: "Imported conversation",
      status: "idle",
      archived: false,
      canContinue: true,
      canArchive: true,
    };
    expect(draw(row, true)).toBe("Imported conversation");
    presentation.result = sessionsResult([], 2);
    expect(draw(row)).toBe("Partial reconnect metadata");
  });

  it.each([
    { key: "agent:main:current", archived: true },
    { key: "agent:main:fork", parentSessionKey: "agent:main:parent" },
    { key: "agent:main:subagent:child" },
  ])("renders available header actions for $key (archived: $archived)", async (fields) => {
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture(),
    });
    state.settings = loadSettings();
    const session = {
      ...fields,
      sessionId: "current",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    const container = document.body.appendChild(document.createElement("div"));
    renderPaneHeaderInto(
      pane.renderPaneHeader(
        createPaneHeaderWorkspaceFixture(state),
        session,
        false,
        undefined,
        false,
        null,
      ),
      container,
    );
    const menu = container.querySelector("openclaw-chat-header-session-menu");
    expect(menu).not.toBeNull();
    await menu?.updateComplete;
    expect(menu?.openMenu()).toBe(true);
    flush();
    await menu?.updateComplete;
    if (fields.archived === undefined) {
      expect(menu?.querySelector('[value="toggle-pin"]')).toBeNull();
    } else {
      const action = menu?.querySelector<HTMLElement & { disabled: boolean }>(
        '[value="toggle-archived"]',
      );
      expect(action).not.toBeNull();
      expect(action?.disabled).toBe(false);
      expect(action?.textContent).toContain(
        t(fields.archived ? "sessionsView.restoreSession" : "sessionsView.archiveSession"),
      );
    }
  });

  it.each([
    ["agent:main:plugin:anthropic:catalog-adopt:claude:fixture", false],
    ["agent:main:ordinary", true],
  ])(
    "offers header Delete only when the transcript belongs to OpenClaw: %s",
    async (key, allowed) => {
      const { pane, state } = createTestChatPane({ client: createGatewayBrowserClientFixture() });
      state.settings = loadSettings();
      const row: GatewaySessionRow = { key, sessionId: "fixture", kind: "direct", updatedAt: 0 };
      const container = document.body.appendChild(document.createElement("div"));
      renderPaneHeaderInto(
        pane.renderPaneHeader(
          createPaneHeaderWorkspaceFixture(state),
          row,
          false,
          undefined,
          false,
          null,
        ),
        container,
      );
      const menu = container.querySelector("openclaw-chat-header-session-menu");
      await menu?.updateComplete;
      expect(menu?.openMenu()).toBe(true);
      flush();
      await menu?.updateComplete;
      await openSubmenu(menu!.querySelector(".chat-header-session-menu__panel")!, "Advanced");
      const deleteItem = menu?.querySelector<HTMLElement & { disabled: boolean }>(
        '[value="delete"]',
      );
      expect(deleteItem).not.toBeNull();
      expect(deleteItem?.disabled).toBe(!allowed);
    },
  );

  it("forks through the shared session organizer flow and selects the new session", async () => {
    const create = vi.fn(async () => "agent:main:forked");
    const sessions = createSessionCapabilityFixture({
      create,
      state: { error: null },
    });
    const { pane } = createTestChatPane({ client: createGatewayBrowserClientFixture(), sessions });
    Object.assign(pane.context.gateway.snapshot.hello?.features ?? {}, {
      methods: ["sessions.patch", "sessions.create"],
    });
    const onPaneSessionChange = vi.fn();
    pane.onPaneSessionChange = onPaneSessionChange;
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
      hasActiveRun: true,
    } satisfies GatewaySessionRow;

    await pane.handleHeaderSessionAction({ kind: "fork" }, session);

    expect(create).toHaveBeenCalledWith(
      {
        parentSessionKey: session.key,
        fork: true,
        forkFrom: "last-completed",
        agentId: "main",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(onPaneSessionChange).toHaveBeenCalledWith("single", "agent:main:forked");
  });

  it.each([
    { action: { kind: "toggle-pin" }, patch: { pinned: true }, current: "replacement" },
    { action: { kind: "toggle-unread" }, patch: { unread: true }, current: "replacement" },
    {
      action: { kind: "set-communication", communication: { send: "never" } },
      patch: { communication: { send: "never" } },
      current: "replacement",
    },
    {
      action: { kind: "set-communication", communication: { send: "never" } },
      patch: { communication: { send: "never" } },
      current: "removed",
    },
    { action: { kind: "set-icon", icon: "🦞" }, patch: { icon: "🦞" }, current: "replacement" },
    {
      action: { kind: "set-color", color: "red" },
      patch: { color: "red" },
      current: "replacement",
    },
    {
      action: { kind: "reset-appearance" },
      patch: { icon: null, color: null },
      current: "replacement",
    },
    {
      action: { kind: "move-to-group", category: "Projects" },
      patch: { category: "Projects" },
      current: "replacement",
    },
    {
      action: { kind: "move-to-group", category: "Projects" },
      patch: { category: "Projects" },
      current: "refreshed",
    },
  ] as const)(
    "keeps header $action.kind scoped to its captured row ($current)",
    async ({ action, patch: expectedPatch, current }) => {
      const patch = vi.fn(async () => ({}));
      const original: GatewaySessionRow = {
        key: "agent:main:current",
        sessionId: current === "removed" ? undefined : "original-session",
        kind: "direct",
        updatedAt: 0,
        ...(current === "refreshed" ? { category: "Projects" } : {}),
      };
      const result = sessionsResult([original], 1);
      const sessions = createSessionCapabilityFixture({
        patch,
        state: { error: null, groups: ["Projects", "Other"], result },
      });
      const { pane, state } = createTestChatPane({
        client: createGatewayBrowserClientFixture(),
        sessions,
      });
      state.sessionsResult = result;
      result.sessions =
        current === "removed"
          ? []
          : [
              {
                ...original,
                ...(current === "refreshed"
                  ? { category: "Other" }
                  : { sessionId: "replacement-session" }),
              },
            ];
      await pane.handleHeaderSessionAction(action, original);
      if (action.kind === "toggle-pin") {
        expect(patch).not.toHaveBeenCalled();
        expect(pane.context.navigation.snapshot.sidebarEntries).toEqual([]);
      } else if (current === "removed") {
        expect(patch).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith({ message: t("common.refresh") });
      } else {
        expect(patch).toHaveBeenCalledWith(original.key, expectedPatch, {
          agentId: "main",
          expectedSessionId: original.sessionId,
        });
      }
    },
  );

  it("keeps the mobile rename draft through reconnect without retargeting session or client", async () => {
    const modal = createModalDialogTestFixture();
    const row: GatewaySessionRow = {
      key: "global",
      sessionId: "research-global",
      kind: "global",
      label: "Research notes",
    };
    const patch = vi.fn(async () => ({}));
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture({
        request: async (method) => {
          switch (method) {
            case "agents.list":
              return {
                defaultId: "main",
                mainKey: "main",
                scope: "per-sender",
                agents: [{ id: "main" }, { id: "research" }],
              };
            case "sessions.describe":
              return { session: null };
            default:
              return {};
          }
        },
      }),
      sessions: createSessionCapabilityFixture({ patch }),
    });
    getPaneTestRuntime(pane).mergedChrome = true;
    state.sessionKey = row.key;
    state.assistantAgentId = "research";
    try {
      const cancelled = modal.track(pane.handleHeaderSessionAction({ kind: "rename" }, row));
      const first = await waitForInputDialog();
      expect(first.value).toBe("Research notes");
      first.value = "Discarded draft";
      first.dispatchEvent(new Event("input", { bubbles: true }));
      const cancel = [
        ...document.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button"),
      ].find((button) => button.textContent === "Cancel");
      expect(cancel).toBeDefined();
      cancel!.click();
      await cancelled;
      expect(patch).not.toHaveBeenCalled();

      const saved = modal.track(pane.handleHeaderSessionAction({ kind: "rename" }, row));
      const input = await waitForInputDialog();
      expect(input.value).toBe("Research notes");
      expect(pane.headerPresentation.renameSession).toBeNull();
      const connected = { ...pane.context.gateway.snapshot };
      input.value = "Unsent notes";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      pane.applyGatewaySnapshot({ ...connected, phase: "reconnecting", hello: null });
      flush();
      expect(document.querySelector("openclaw-modal-dialog input")).toBe(input);
      expect(input.value).toBe("Unsent notes");
      expect(input.disabled).toBe(false);
      expect(
        input.closest("form")!.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled,
      ).toBe(true);
      input
        .closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(patch).not.toHaveBeenCalled();
      pane.applyGatewaySnapshot(connected);
      // A roster refresh must not retarget the draft to a new session instance.
      row.sessionId = "replacement-global";
      row.label = "Replacement title";
      await submitInputDialog("  Renamed notes  ");
      await saved;
      expect(patch).toHaveBeenCalledExactlyOnceWith(
        "global",
        { label: "Renamed notes" },
        { agentId: "research", expectedSessionId: "research-global" },
      );
      expect(document.querySelector("openclaw-modal-dialog")).toBeNull();

      const retired = modal.track(pane.handleHeaderSessionAction({ kind: "rename" }, row));
      const retiredInput = await waitForInputDialog();
      retiredInput.value = "Other client must not inherit this";
      pane.applyGatewaySnapshot({
        ...connected,
        client: createGatewayBrowserClientFixture(),
        phase: "reconnecting",
        hello: null,
      });
      await retired;
      expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(patch).toHaveBeenCalledOnce();
    } finally {
      await modal.cleanup();
    }
  });

  it.each([
    {
      name: "trimmed label",
      key: "agent:main:current",
      sessionId: "rename-current",
      value: "  Renamed session  ",
      label: "Renamed session",
      agentId: "main",
    },
    {
      name: "canonical global",
      key: "global",
      sessionId: "research-global",
      value: "Research thread",
      label: "Research thread",
      agentId: "research",
    },
    {
      name: "offline retained session",
      key: "agent:main:current",
      sessionId: "rename-current",
      value: "Offline notes",
      label: "Offline notes",
      agentId: "main",
      offline: true,
    },
    {
      name: "unchanged generated title",
      key: "agent:main:dashboard:generated",
      displayName: "Generated title",
      value: "Generated title",
      agentId: "main",
    },
  ])(
    "renames only an edited captured session: $name",
    ({ key, sessionId, displayName, value, label, agentId, offline }) => {
      const patch = vi.fn(async () => ({}));
      const { pane, state } = createTestChatPane({
        client: createGatewayBrowserClientFixture(),
        sessions: createSessionCapabilityFixture({ patch }),
      });
      state.sessionKey = key;
      state.assistantAgentId = agentId;
      if (offline) {
        pane.context.gateway.snapshot.phase = "offline";
        state.connected = false;
      }
      const session: GatewaySessionRow = {
        key,
        sessionId,
        displayName,
        kind: key === "global" ? "global" : "direct",
        updatedAt: 0,
      };
      pane.beginHeaderRename(session);
      if (displayName) {
        expect(pane.headerPresentation.renameValue).toBe(displayName);
      }
      pane.headerPresentation.renameValue = value;
      pane.commitHeaderRename();
      if (!label) {
        pane.beginHeaderRename(session);
        pane.cancelHeaderRename();
        expect(patch).not.toHaveBeenCalled();
        return;
      }
      expect(patch).toHaveBeenCalledWith(key, { label }, { agentId, expectedSessionId: sessionId });
      if (key !== "global") {
        pane.beginHeaderRename({ ...session, label });
        pane.headerPresentation.renameValue = "   ";
        pane.commitHeaderRename();
        expect(patch).toHaveBeenLastCalledWith(
          key,
          { label: null },
          { agentId, expectedSessionId: sessionId },
        );
      }
    },
  );
});
