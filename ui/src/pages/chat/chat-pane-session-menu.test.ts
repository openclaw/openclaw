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
  createSessionCapabilityFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";
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
          createSessionWorkspaceProps(pane.state),
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
          createSessionWorkspaceProps(state),
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

  it.each([false, true])(
    "keeps the header archive/restore action enabled (archived=%s)",
    async (archived) => {
      const { pane, state } = createTestChatPane({
        client: createGatewayBrowserClientFixture(),
        sessions: createSessionCapabilityFixture(),
      });
      state.settings = loadSettings();
      const session = {
        key: "agent:main:current",
        sessionId: "current",
        kind: "direct",
        archived,
      } satisfies GatewaySessionRow;
      const container = document.body.appendChild(document.createElement("div"));
      render(
        pane.renderPaneHeader(
          createSessionWorkspaceProps(state),
          session,
          false,
          undefined,
          false,
          null,
        ),
        container,
      );
      const menu = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
        "openclaw-chat-header-session-menu",
      );
      await menu?.updateComplete;
      const action = menu?.querySelector<HTMLElement & { disabled: boolean }>(
        '[value="toggle-archived"]',
      );
      expect(action).not.toBeNull();
      expect(action?.disabled).toBe(false);
      expect(action?.textContent).toContain(
        t(archived ? "sessionsView.restoreSession" : "sessionsView.archiveSession"),
      );
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

    expect(create).toHaveBeenCalledWith({
      parentSessionKey: session.key,
      fork: true,
      forkFrom: "last-completed",
      agentId: "main",
    });
    expect(onPaneSessionChange).toHaveBeenCalledWith("single", "agent:main:forked");
  });

  it.each([
    ["pin", { kind: "toggle-pin" } as const],
    ["unread", { kind: "toggle-unread" } as const],
    ["icon", { kind: "set-icon", icon: "🦞" } as const],
  ])("skips a no-ID header %s action after its row was removed", async (_name, action) => {
    const patch = vi.fn(async () => ({}));
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    const result = {
      ts: 1,
      count: 1,
      path: "sessions.json",
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [session],
    };
    const sessions = createSessionCapabilityFixture({
      patch,
      state: { error: null, result },
    });
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions,
    });

    result.sessions = [];
    await pane.handleHeaderSessionAction(action, session);

    expect(patch).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({
      message: t("common.refresh"),
    });
  });

  it.each([
    { key: "agent:main:fork", parentSessionKey: "agent:main:parent" },
    { key: "agent:main:subagent:child" },
  ])("hides pinning a lineage child $key in the header menu", async (lineage) => {
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions: createSessionCapabilityFixture(),
    });
    state.settings = loadSettings();
    const session = { ...lineage, kind: "direct", updatedAt: 0 } satisfies GatewaySessionRow;
    const container = document.createElement("div");
    document.body.append(container);

    render(
      pane.renderPaneHeader(
        createSessionWorkspaceProps(state),
        session,
        false,
        undefined,
        false,
        null,
      ),
      container,
    );

    const menu = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-chat-header-session-menu",
    );
    expect(menu).not.toBeNull();
    await menu?.updateComplete;
    expect(menu?.querySelector('[value="toggle-pin"]')).toBeNull();
  });

  it("uses the refreshed category when deciding whether a header group move is a no-op", async () => {
    const patch = vi.fn(async () => ({}));
    const rendered = {
      key: "agent:main:current",
      sessionId: "session-current",
      kind: "direct",
      updatedAt: 0,
      category: "Projects",
    } satisfies GatewaySessionRow;
    const refreshed = { ...rendered, category: "Other" };
    const sessions = createSessionCapabilityFixture({
      patch,
      state: {
        error: null,
        groups: ["Projects", "Other"],
        result: {
          ts: 1,
          count: 1,
          path: "sessions.json",
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [refreshed],
        },
      },
    });
    const { pane } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions,
    });

    await pane.handleHeaderSessionAction({ kind: "move-to-group", category: "Projects" }, rendered);

    expect(patch).toHaveBeenCalledWith(
      rendered.key,
      { category: "Projects" },
      { agentId: "main", expectedSessionId: rendered.sessionId },
    );
  });

  it.each([
    { action: { kind: "toggle-pin" }, patch: { pinned: true } },
    { action: { kind: "toggle-unread" }, patch: { unread: true } },
    { action: { kind: "set-icon", icon: "🦞" }, patch: { icon: "🦞" } },
    { action: { kind: "set-color", color: "red" }, patch: { color: "red" } },
    { action: { kind: "reset-appearance" }, patch: { icon: null, color: null } },
    { action: { kind: "move-to-group", category: "Projects" }, patch: { category: "Projects" } },
  ] as const)(
    "keeps the original header identity for $action.kind after replacement",
    async ({ action, patch: expectedPatch }) => {
      const patch = vi.fn(async () => ({}));
      const original = {
        key: "agent:main:current",
        sessionId: "original-session",
        kind: "direct",
        updatedAt: 0,
      } satisfies GatewaySessionRow;
      const sessions = createSessionCapabilityFixture({
        patch,
        state: {
          error: null,
          groups: ["Projects"],
          result: {
            ts: 1,
            count: 1,
            path: "",
            defaults: { modelProvider: null, model: null, contextTokens: null },
            sessions: [{ ...original, sessionId: "replacement-session" }],
          },
        },
      });
      const { pane } = createTestChatPane({
        client: createGatewayBrowserClientFixture(),
        sessions,
      });

      await pane.handleHeaderSessionAction(action, original);

      expect(patch).toHaveBeenCalledWith(original.key, expectedPatch, {
        agentId: "main",
        expectedSessionId: original.sessionId,
      });
    },
  );

  it("commits a trimmed label and clears with null", async () => {
    const patch = vi.fn(async () => ({}));
    const sessions = createSessionCapabilityFixture({ patch });
    const { pane } = createTestChatPane({ client: createGatewayBrowserClientFixture(), sessions });
    const session = {
      key: "agent:main:current",
      sessionId: "rename-current",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    pane.beginHeaderRename(session);
    pane.headerRenameValue = "  Renamed session  ";
    pane.commitHeaderRename();
    expect(patch).toHaveBeenCalledWith(
      session.key,
      { label: "Renamed session" },
      { agentId: "main", expectedSessionId: session.sessionId },
    );

    const labeled = { ...session, label: "Renamed session" };
    pane.beginHeaderRename(labeled);
    pane.headerRenameValue = "   ";
    pane.commitHeaderRename();
    expect(patch).toHaveBeenLastCalledWith(
      session.key,
      { label: null },
      { agentId: "main", expectedSessionId: session.sessionId },
    );
  });

  it("renames the selected agent's canonical global session", () => {
    const patch = vi.fn(async () => ({}));
    const sessions = createSessionCapabilityFixture({ patch });
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions,
    });
    state.sessionKey = "global";
    state.assistantAgentId = "research";
    const session = {
      key: "global",
      sessionId: "research-global",
      kind: "global",
      updatedAt: 0,
    } satisfies GatewaySessionRow;

    pane.beginHeaderRename(session);
    pane.headerRenameValue = "Research thread";
    pane.commitHeaderRename();

    expect(patch).toHaveBeenCalledWith(
      "global",
      { label: "Research thread" },
      { agentId: "research", expectedSessionId: session.sessionId },
    );
  });

  it("cancels and skips an unchanged generated dashboard title", () => {
    const patch = vi.fn(async () => ({}));
    const sessions = createSessionCapabilityFixture({ patch });
    const { pane } = createTestChatPane({ client: createGatewayBrowserClientFixture(), sessions });
    const session = {
      key: "agent:main:dashboard:generated",
      kind: "direct",
      displayName: "Generated title",
      updatedAt: 0,
    } satisfies GatewaySessionRow;
    pane.beginHeaderRename(session);
    expect(pane.headerRenameValue).toBe("Generated title");
    pane.commitHeaderRename();
    pane.beginHeaderRename(session);
    pane.cancelHeaderRename();
    expect(patch).not.toHaveBeenCalled();
  });
});
