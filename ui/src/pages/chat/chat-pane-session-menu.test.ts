/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { loadSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { showToast } from "../../lib/toast.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import {
  createGatewayBrowserClientFixture,
  createPaneHeaderWorkspaceFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));

beforeEach(installTranscriptDomMocks);

afterEach(() => {
  resetTranscriptTestDom();
  vi.clearAllMocks();
});

describe("chat pane session menu boundary", () => {
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
  it("keeps unchanged menu children settled and reads current callbacks after a header refresh", async () => {
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
      render(pane.renderPaneHeader(workspace, session, false, undefined, false, null), container);
    };
    draw();
    const menu = container.querySelector("openclaw-chat-header-session-menu")!;
    await menu.updateComplete;
    const items = [...menu.querySelectorAll("wa-dropdown-item")];
    await Promise.all(items.map((item) => item.updateComplete));
    await menu.updateComplete;
    const updates = vi.spyOn(menu, "render");
    const itemUpdates = items.map((item) => vi.spyOn(item, "requestUpdate"));
    draw();
    await menu.updateComplete;
    expect(updates).not.toHaveBeenCalled();
    expect(itemUpdates.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    menu.querySelector("wa-dropdown")!.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "quick:panels:session-files" } },
      }),
    );
    expect(workspace.onToggleCollapsed).toHaveBeenCalledOnce();

    state.settings = { ...state.settings };
    session = { ...session };
    draw();
    await menu.updateComplete;
    expect(updates).not.toHaveBeenCalled();

    session = { ...session, label: "Updated conversation" };
    pane.context.navigation.update({ sidebarEntries: [`session:${session.key}`] });
    draw();
    await menu.updateComplete;
    expect(updates).toHaveBeenCalledOnce();
    expect(menu.session.label).toBe("Updated conversation");
    expect(menu.session.pinned).toBe(true);
    state.settings = { ...state.settings, chatShowThinking: !state.settings.chatShowThinking };
    draw();
    await menu.updateComplete;
    expect(updates).toHaveBeenCalledTimes(2);
    expect(menu.querySelector('[value="view:reasoning"]')?.hasAttribute("checked")).toBe(
      state.settings.chatShowThinking,
    );
    const action = vi.spyOn(pane, "handleHeaderSessionAction").mockResolvedValue(undefined);
    menu
      .querySelector("wa-dropdown")!
      .dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "toggle-pin" } } }));
    expect(action).toHaveBeenCalledWith({ kind: "toggle-pin" }, session);
    expect(action.mock.calls[0]?.[1]).toBe(session);
    state.applySettings = vi.fn();
    menu.querySelector("wa-dropdown")!.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "view:tool-calls" } },
      }),
    );
    expect(state.applySettings).toHaveBeenCalledWith({
      chatShowToolCalls: !state.settings.chatShowToolCalls,
    });
  });

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
      const presentation = sessions.presentation.result?.sessions.find(
        (row) => row.key === pane.sessionKey,
      );
      pane.presentationTitle = presentation
        ? resolveSessionDisplayName(pane.sessionKey, presentation)
        : undefined;
      render(
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
    const redraw = vi.spyOn(verifier, "requestUpdate");
    emitGatewayEvent("sessions.changed", {
      sessionKey: retained.key,
      agentId: "research",
      reason: "label",
      session: { ...retained, label: "Reviewed conversation", updatedAt: 2 },
    });
    expect(redraw).toHaveBeenCalled();
    expect.soft(title(verifier)).toBe("Reviewed conversation");
    container.querySelector<HTMLButtonElement>(".chat-pane__session-title-button")?.click();
    expect(verifier.headerRenameValue).toBe("Reviewed conversation");
    verifier.cancelHeaderRename();
    expect(title(ledger)).toBe("Ledger reconciliation");

    const patch = vi.spyOn(sessions, "patch");
    container.querySelector<HTMLButtonElement>(".chat-pane__session-title-button")?.click();
    ledger.headerRenameValue = "Reviewed ledger";
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

  it("keeps reconnect presentation and catalog names ahead of incomplete pane metadata", () => {
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture(),
    });
    state.connected = false;
    pane.presentationTitle = "Retained conversation";
    const container = document.createElement("div");
    const row = {
      key: "agent:main:dashboard:retained",
      kind: "direct",
      derivedTitle: "Partial reconnect metadata",
    } satisfies GatewaySessionRow;
    const draw = (session: GatewaySessionRow | undefined, catalog = false) => {
      render(
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
    pane.catalogSession = {
      threadId: "catalog",
      name: "Imported conversation",
      status: "idle",
      archived: false,
      canContinue: true,
      canArchive: true,
    };
    expect(draw(row, true)).toBe("Imported conversation");
    pane.presentationTitle = undefined;
    expect(draw(row)).toBe("Partial reconnect metadata");
  });

  it.each([
    { key: "agent:main:current", archived: false },
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
    render(
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

    expect(create).toHaveBeenCalledWith({
      parentSessionKey: session.key,
      fork: true,
      forkFrom: "last-completed",
      agentId: "main",
    });
    expect(onPaneSessionChange).toHaveBeenCalledWith("single", "agent:main:forked");
  });

  it.each([
    { action: { kind: "toggle-pin" }, patch: { pinned: true }, current: "removed" },
    { action: { kind: "toggle-pin" }, patch: { pinned: true }, current: "replacement" },
    { action: { kind: "toggle-unread" }, patch: { unread: true }, current: "replacement" },
    {
      action: { kind: "set-communication", communication: { send: "never" } },
      patch: { communication: { send: "never" } },
      current: "replacement",
    },
    {
      action: { kind: "set-communication", communication: null },
      patch: { communication: null },
      current: "refreshed",
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
      name: "unchanged generated title",
      key: "agent:main:dashboard:generated",
      displayName: "Generated title",
      value: "Generated title",
      agentId: "main",
    },
  ])(
    "renames only an edited captured session: $name",
    ({ key, sessionId, displayName, value, label, agentId }) => {
      const patch = vi.fn(async () => ({}));
      const { pane, state } = createTestChatPane({
        client: createGatewayBrowserClientFixture(),
        sessions: createSessionCapabilityFixture({ patch }),
      });
      state.sessionKey = key;
      state.assistantAgentId = agentId;
      const session: GatewaySessionRow = {
        key,
        sessionId,
        displayName,
        kind: key === "global" ? "global" : "direct",
        updatedAt: 0,
      };
      pane.beginHeaderRename(session);
      if (displayName) {
        expect(pane.headerRenameValue).toBe(displayName);
      }
      pane.headerRenameValue = value;
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
        pane.headerRenameValue = "   ";
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
