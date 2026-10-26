/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlUiAction } from "../../../../src/plugin-sdk/control-ui.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { showInputDialog } from "../../components/input-dialog.tsx";
import * as sessionMenuWork from "../../components/session-menu-work.ts";
import { agentRoster } from "../../e2e/agent-roster.test-support.ts";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import * as uiErrors from "../../lib/format-error.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type {
  SessionDeleteOutcome,
  SessionDeleteTarget,
  SessionGroupMutationResult,
} from "../../lib/sessions/session-capability.ts";
import { registerSessionPluginAction } from "../../test-helpers/control-ui-plugin-action.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
  sessionMutationGatewayHello,
} from "../../test-helpers/gateway-methods.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  getRenderedModalDialog,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import { createRouteLoaderOptions } from "../../test-helpers/route-loader-options.ts";
import {
  openSubmenu,
  selectMenuValue,
  settleSessionMenu,
} from "../../test-helpers/session-menu.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { page as sessionsRoute, type SessionsRouteData } from "./route.ts";
import {
  createContext,
  createGateway,
  createManagedSessions,
  createPage,
  createRenderedPage,
  createSessions,
  liveSessions,
  mountMutation,
  openRowMenu,
  selectRows,
  sessionRow,
} from "./sessions-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
vi.mock("../../components/input-dialog.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/input-dialog.tsx")>()),
  showInputDialog: vi.fn(),
}));
function capturedTarget(row: GatewaySessionRow) {
  return {
    key: row.key,
    agentId: undefined,
    expectedSessionId: row.sessionId,
    ...(row.archived === true ? { archivedOnly: true } : {}),
  };
}
function publishRows(managed: ReturnType<typeof createManagedSessions>, rows: GatewaySessionRow[]) {
  managed.publish(managed.subscribeList.mock.calls[0]![0], {
    result: sessionsResult(rows, 2),
    agentId: "main",
    loading: false,
    error: null,
  });
}
async function createDeletionPage(rows: GatewaySessionRow[], agentId = "main") {
  let serverRows = rows;
  const deleteRequest = vi.fn(
    async (target: SessionDeleteTarget): Promise<SessionDeleteOutcome> => {
      const deleted = serverRows.some((entry) => entry.key === target.key);
      serverRows = serverRows.filter((entry) => entry.key !== target.key);
      return { deleted };
    },
  );
  const { connection, sessions, context } = liveSessions(
    {
      "sessions.list": () => sessionsResult(serverRows, 1),
      "sessions.delete": (params) => deleteRequest(params as SessionDeleteTarget),
    },
    agentId,
  );
  const subscribe = vi.spyOn(sessions, "subscribeList");
  vi.spyOn(sessions, "deleteMany");
  context.agentSelection.state.selectedId = agentId;
  context.agentSelection.state.scopeId = agentId;
  const page = await createRenderedPage(context, sessionsResult(rows, 1), "all");
  await waitForFast(() => expect(page.loading).toBe(false));
  return {
    page,
    sessions,
    connection,
    deleteRequest,
    query: subscribe.mock.calls[0]![0],
    setRows: (next: GatewaySessionRow[]) => {
      serverRows = next;
    },
  };
}
afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.mocked(showInputDialog).mockReset();
  vi.restoreAllMocks();
});
describe("sessions page lifecycle", () => {
  it("retries a retained agent identity on roster publication after reconnect backoff", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const readIdentity = vi
      .fn()
      .mockResolvedValueOnce({ agentId: "main", name: "Before", avatar: "" })
      .mockRejectedValueOnce(new Error("Identity temporarily unavailable"))
      .mockResolvedValueOnce({ agentId: "main", name: "After", avatar: "" });
    const connection = createGateway(createTestGatewayClient(readIdentity));
    const agentIdentity = createAgentIdentityCapability(connection.gateway);
    const managed = createManagedSessions();
    const context = { ...createContext(connection.gateway, managed.sessions), agentIdentity };
    const row = sessionRow("webchat:identity");
    const page = await createRenderedPage(context, sessionsResult([row], 1), "all");
    const label = () => page.querySelector(".session-link")?.textContent;
    await waitForFast(() => expect(label()).toContain("Before"));

    connection.emit({ phase: "reconnecting" });
    connection.emit({ phase: "connected" });
    await agentIdentity.ensure(["main"]);
    expect(readIdentity).toHaveBeenCalledTimes(2);
    expect(label()).toContain("Before");

    publishRows(managed, [row]);
    await page.updateComplete;
    expect(readIdentity).toHaveBeenCalledTimes(2);
    now += 1_000;
    publishRows(managed, [row]);
    await waitForFast(() => expect(label()).toContain("After"));
    expect(readIdentity).toHaveBeenCalledTimes(3);
  });

  it("keeps a failed rename editable until a confirmed retry succeeds", async () => {
    const actual = await vi.importActual<typeof import("../../components/input-dialog.tsx")>(
      "../../components/input-dialog.tsx",
    );
    vi.mocked(showInputDialog).mockImplementation(actual.showInputDialog);
    const fixture = createModalDialogTestFixture();
    const pending = createDeferred<Awaited<ReturnType<SessionCapability["patch"]>>>();
    const target = sessionRow("rename-command", { label: "Before rename" });
    const patch = vi
      .fn<SessionCapability["patch"]>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({
        ok: true,
        key: target.key,
        path: "",
        entry: { sessionId: target.sessionId! },
      });
    const { page } = await mountMutation({ patch });
    page.result = sessionsResult([target], 1);
    try {
      await selectMenuValue(await openRowMenu(page, target), "rename");
      const { modal } = await getRenderedModalDialog(document.body);
      const input = modal.querySelector<HTMLInputElement>('input[name="value"]')!;
      const form = modal.querySelector("form")!;
      input.value = "Retryable rename";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await waitForFast(() => expect(patch).toHaveBeenCalledOnce());
      await waitForFast(() => expect(input.disabled).toBe(true));
      pending.reject(new Error("Rename unavailable. Try again."));
      await waitForFast(() =>
        expect(modal.querySelector('[role="alert"]')?.textContent).toContain(
          "Rename unavailable. Try again.",
        ),
      );
      expect(input.value).toBe("Retryable rename");
      expect(input.disabled).toBe(false);
      expect(document.activeElement).toBe(input);
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await waitForFast(() =>
        expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull(),
      );
      expect(patch).toHaveBeenCalledTimes(2);
    } finally {
      pending.resolve(null);
      await fixture.cleanup();
    }
  });

  it("keeps command confirmation visible and reports a failed effect after the menu closes", async () => {
    const actual = await vi.importActual<typeof import("../../components/confirm-dialog.ts")>(
      "../../components/confirm-dialog.ts",
    );
    vi.mocked(showConfirmDialog).mockImplementation(actual.showConfirmDialog);
    const fixture = createModalDialogTestFixture();
    const pending = createDeferred<Awaited<ReturnType<SessionCapability["deleteMany"]>>>();
    const target = sessionRow("command", { label: "Command fixture" });
    const { page, sessions } = await mountMutation({ deleteMany: vi.fn(() => pending.promise) });
    page.result = sessionsResult([target], 1);
    try {
      const menu = await openRowMenu(page, target);
      await openSubmenu(menu, "Advanced");
      await selectMenuValue(menu, "delete");
      const actions = await waitForConfirmDialogActions();
      expect((await getRenderedModalDialog(document.body)).dialog.open).toBe(true);
      expect(page.querySelector("openclaw-session-menu")).toBeNull();
      expect(sessions.deleteMany).not.toHaveBeenCalled();
      answerConfirmDialog(actions, "confirm");
      await waitForFast(() => expect(sessions.deleteMany).toHaveBeenCalledOnce());
      expect(page.textContent).toContain("Working…");
      pending.reject(new Error("Deletion unavailable. Try again."));
      await waitForFast(() =>
        expect(page.querySelector('[role="alert"]')?.textContent).toContain(
          "Deletion unavailable. Try again.",
        ),
      );
      expect(page.textContent).not.toContain("Working…");
      expect(page.textContent).toContain("Command fixture");
    } finally {
      pending.resolve({ deleted: [], errors: [], preservedWorktrees: [] });
      await fixture.cleanup();
    }
  });

  it("disables refresh during transport loss and restores it after reconnect", async () => {
    const { page, connection, sessions } = await mountMutation();
    const refreshList = vi.mocked(sessions.refreshList);
    const refresh = () => page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!;
    await waitForFast(() => expect(refresh().disabled).toBe(false));
    for (const phase of ["reconnecting", "offline"] as const) {
      connection.emit({ phase });
      await page.updateComplete;
      const requests = refreshList.mock.calls.length;
      expect(refresh().disabled).toBe(true);
      refresh().click();
      expect(refreshList).toHaveBeenCalledTimes(requests);
    }
    connection.emit({ phase: "connected", hello: sessionMutationGatewayHello() });
    await waitForFast(() => expect(refresh().disabled).toBe(false));
    const requests = refreshList.mock.calls.length;
    refresh().click();
    await waitForFast(() => expect(refreshList).toHaveBeenCalledTimes(requests + 1));
  });

  it("retires command status and isolates later commands after the agent scope changes", async () => {
    const pending = createDeferred<Awaited<ReturnType<SessionCapability["deleteMany"]>>>();
    const next = createDeferred<Awaited<ReturnType<SessionCapability["deleteMany"]>>>();
    const sessions = createSessions({
      deleteMany: vi.fn().mockReturnValueOnce(pending.promise).mockReturnValueOnce(next.promise),
    });
    const context = createContext(createGateway().gateway, sessions);
    const listeners = new Set<() => void>();
    context.agentSelection.subscribe = (listener) => {
      const notify = () => listener(context.agentSelection.state);
      listeners.add(notify);
      return () => listeners.delete(notify);
    };
    const target = sessionRow("old-scope-command");
    const page = await createRenderedPage(context, sessionsResult([target], 1), "all");
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    try {
      const menu = await openRowMenu(page, target);
      await openSubmenu(menu, "Advanced");
      await selectMenuValue(menu, "delete");
      await waitForFast(() => expect(sessions.deleteMany).toHaveBeenCalledOnce());
      expect(page.textContent).toContain("Working…");
      context.agentSelection.state.scopeId = "reviewer";
      listeners.forEach((notify) => notify());
      await page.updateComplete;
      expect(page.textContent).not.toContain("Working…");
      const nextTarget = sessionRow("new-scope-command", {
        key: "agent:reviewer:new-scope-command",
      });
      page.result = sessionsResult([nextTarget], 2);
      const nextMenu = await openRowMenu(page, nextTarget);
      await openSubmenu(nextMenu, "Advanced");
      await selectMenuValue(nextMenu, "delete");
      await waitForFast(() => expect(sessions.deleteMany).toHaveBeenCalledTimes(2));
      expect(page.textContent).toContain("Working…");
      next.resolve({ deleted: [], errors: [], preservedWorktrees: [] });
      await waitForFast(() => expect(page.textContent).not.toContain("Working…"));
      pending.reject(new Error("Old agent deletion failed"));
      await page.updateComplete;
      expect(page.textContent).not.toContain("Old agent deletion failed");
    } finally {
      pending.resolve({ deleted: [], errors: [], preservedWorktrees: [] });
      next.resolve({ deleted: [], errors: [], preservedWorktrees: [] });
    }
  });

  it("pins from the page menu without changing shared pin metadata", async () => {
    const row = sessionRow("personal-pin", { pinned: true, sharingRole: "viewer" });
    const sessions = createSessions();
    const context = createContext(createGateway().gateway, sessions);
    const page = await createRenderedPage(context, sessionsResult([row], 1));
    const menu = await openRowMenu(page, row);
    const entry = menu.querySelector('[value="toggle-pin"]');
    expect(entry).not.toBeNull();
    expect(entry?.hasAttribute("disabled")).toBe(false);
    await selectMenuValue(menu, "toggle-pin");
    expect(context.navigation.snapshot.sidebarEntries).toContain("session:" + row.key);
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(row.pinned).toBe(true);
  });
  it.each([false, true])(
    "reports owner assignment failure only in its current page (retired: %s)",
    async (retired) => {
      const row = sessionRow("assignment", {
        sessionId: "assignment-session",
        label: "Assignment fixture",
      });
      const failure = new Error("Assignment unavailable. Try again.");
      const formatError = vi.spyOn(uiErrors, "formatUiError");
      const assignment = createDeferred<unknown>();
      const { request, connection, sessions, context } = liveSessions(
        {
          "sessions.assignOwner": () => assignment.promise,
          "sessions.list": () => sessionsResult([row], 1),
          "users.list": () => ({ profiles: [] }),
        },
        "main",
      );
      const assignOwner = vi.spyOn(sessions, "assignOwner");
      context.agents.state.agentsList = agentRoster(
        { main: "Main", reviewer: "Reviewer" },
        "main",
        "per-sender",
      );
      const page = await createRenderedPage(context, sessionsResult([row], 1));
      await waitForFast(() => expect(page.loading).toBe(false));
      const menu = await openRowMenu(page, row);
      await openSubmenu(menu, "Assign to…");
      await selectMenuValue(menu, "assign-owner:agent:reviewer");
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("sessions.assignOwner", {
          key: row.key,
          owner: { type: "agent", id: "reviewer" },
        }),
      );
      if (retired) {
        connection.emit({ phase: "reconnecting", client: null });
      }
      assignment.reject(failure);
      if (retired) {
        await assignOwner.mock.results[0]!.value;
        await page.updateComplete;
        expect(page.textContent).not.toContain(failure.message);
      } else {
        await expect(assignOwner.mock.results[0]!.value).rejects.toBe(failure);
        await waitForFast(() => expect(page.textContent).toContain(failure.message));
        expect(formatError.mock.calls.at(-1)?.[0]).toBe(failure);
        expect(page.textContent).toContain("Assignment fixture");
      }
    },
  );

  it.each(["startup", "same-client reconnect"])(
    "loads the current query before config settles on %s",
    async (ordering) => {
      const config = createDeferred();
      const sidebar = createDeferred<SessionsListResult>();
      const result = (key: string) => sessionsResult([{ key, kind: "direct", updatedAt: 1 }], 1);
      let pageRequests = 0;
      const { connection, sessions, context } = liveSessions<{ includeUnknown?: boolean }>(
        {
          "sessions.subscribe": () => ({ subscribed: true }),
          "sessions.list": (params) =>
            params?.includeUnknown === false
              ? result(`agent:main:current-${++pageRequests}`)
              : sidebar.promise,
        },
        undefined,
        ordering === "startup" ? "connecting" : undefined,
      );
      context.runtimeConfig.ensureLoaded = () => config.promise;
      let routeData: SessionsRouteData | undefined;
      const pendingRoute = Promise.resolve(
        sessionsRoute.loader!(
          context,
          createRouteLoaderOptions({ pathname: "/sessions", search: "", hash: "" }),
        ),
      ).then((data) => {
        routeData = data as SessionsRouteData;
        return routeData;
      });
      connection.emit({ phase: "connected" });
      let mountedPage: Awaited<ReturnType<typeof createPage>> | undefined;
      try {
        await waitForFast(() =>
          expect(routeData).toEqual({ expandedSessionKey: null, statusFilter: "active" }),
        );
        const page = await createPage(context, routeData);
        mountedPage = page;
        await waitForFast(() => expect(page.result?.sessions[0]?.key).toBe("agent:main:current-1"));
        if (ordering === "same-client reconnect") {
          connection.emit({ phase: "reconnecting" });
          connection.emit({ phase: "connected", hello: sessionMutationGatewayHello() });
          sidebar.resolve(result("agent:main:sidebar"));
          await waitForFast(() =>
            expect(page.result?.sessions[0]?.key).toBe("agent:main:current-2"),
          );
        }
        const expectedRequests = ordering === "startup" ? 1 : 2;
        expect(pageRequests).toBe(expectedRequests);

        config.resolve();
        page.routeData = (await pendingRoute) as SessionsRouteData;
        await page.updateComplete;
        expect(pageRequests).toBe(expectedRequests);

        sidebar.resolve(result("agent:main:sidebar"));
        await waitForFast(() =>
          expect(sessions.state.result?.sessions[0]?.key).toBe("agent:main:sidebar"),
        );
        connection.emit({ sessionKey: "agent:main:other" });
        await page.updateComplete;
        expect(pageRequests).toBe(expectedRequests);
        expect(page.result?.sessions[0]?.key).toBe(`agent:main:current-${expectedRequests}`);
      } finally {
        config.resolve();
        sidebar.resolve(result("agent:main:sidebar"));
        mountedPage?.remove();
        sessions.dispose();
      }
    },
  );

  it("reports a connection error instead of silently dropping a patch", async () => {
    const { page, connection, sessions } = await mountMutation({ patch: vi.fn() });
    connection.emit({ phase: "reconnecting", client: null });
    expect(await page.patchSession("agent:main:main", { label: "renamed" })).toEqual({
      status: "failed",
      error: "Connect to the Gateway to change sessions.",
    });
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(page.error).toBe("Connect to the Gateway to change sessions.");
  });

  it("uses personal visibility RPC from the management menu", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const connection = createGateway({ request } as unknown as GatewayBrowserClient);
    connection.emit({
      hello: {
        ...gatewayHelloForMethods(
          [...SESSION_MUTATION_TEST_METHODS, "sessions.setInvolvement"],
          ["operator.read"],
        ),
        policy: { hasMultipleSessionSharingIdentities: true },
      },
    });
    const managed = createManagedSessions();
    const target = sessionRow("personal", { hiddenFromInvolvingMe: true });
    const context = createContext(connection.gateway, managed.sessions);
    const page = await createRenderedPage(context, sessionsResult([target], 1));
    const menu = await openRowMenu(page, target);
    await openSubmenu(menu, "Advanced");
    const item = menu.querySelector('[value="toggle-involving-me"]')!;
    expect(item.textContent).toContain("Show in Involving me");
    expect(item.hasAttribute("disabled")).toBe(false);
    managed.refreshList.mockClear();
    await selectMenuValue(menu, "toggle-involving-me");
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "sessions.setInvolvement",
        expect.objectContaining({
          key: target.key,
          expectedSessionId: target.sessionId,
          hidden: false,
        }),
      ),
    );
    await waitForFast(() => expect(managed.refreshList).toHaveBeenCalled());
    expect(managed.sessions.patch).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "retargets only the deleted incarnation (replaced: %s)",
    async (replaced) => {
      const target = sessionRow("work", { key: "agent:writer:work" });
      const { page, sessions, connection, deleteRequest, query, setRows } =
        await createDeletionPage([target], "writer");
      const started = createDeferred();
      const response = createDeferred<SessionDeleteOutcome>();
      deleteRequest.mockImplementationOnce(() => {
        started.resolve();
        return response.promise;
      });
      connection.emit({ sessionKey: target.key });
      vi.mocked(showConfirmDialog).mockResolvedValue(true);
      const selectRow = () => {
        const checkbox = page.querySelector<HTMLInputElement>(
          `input[aria-label="Select session: ${target.key}"]`,
        );
        expect(checkbox).not.toBeNull();
        checkbox!.click();
      };
      try {
        selectRow();
        await page.updateComplete;
        const button = [
          ...page.querySelectorAll<HTMLButtonElement>(".data-table-bulk-bar button"),
        ].find((entry) => entry.textContent?.trim() === "Delete");
        expect(button).toBeDefined();
        button!.click();
        await started.promise;
        expect(deleteRequest).toHaveBeenCalledExactlyOnceWith({
          key: target.key,
          deleteTranscript: true,
          expectedSessionId: target.sessionId,
        });
        const replacement = { ...target, sessionId: "replacement-work", label: "New work" };
        setRows(replaced ? [replacement] : []);
        if (replaced) {
          await sessions.refreshList({ ...query, force: true });
          await page.updateComplete;
          expect(page.result?.sessions).toEqual([replacement]);
          selectRow();
          await page.updateComplete;
          expect(page.selectedSessions.get(target.key)?.sessionId).toBe(replacement.sessionId);
        }
        response.resolve({ deleted: true });
        await vi.mocked(sessions.deleteMany).mock.results[0]!.value;
        await page.updateComplete;
        if (replaced) {
          expect.soft(connection.setSessionKey).not.toHaveBeenCalled();
          expect.soft(page.selectedSessions.get(target.key)?.sessionId).toBe(replacement.sessionId);
          expect.soft(sessions.state.deletedSessions).toEqual([]);
          expect(page.result?.sessions).toEqual([replacement]);
        } else {
          expect(connection.setSessionKey).toHaveBeenCalledWith("agent:writer:main");
          expect(page.result?.sessions).toEqual([]);
          expect(page.selectedSessions.size).toBe(0);
        }
      } finally {
        response.resolve({ deleted: false });
        await vi.mocked(sessions.deleteMany).mock.results[0]?.value;
      }
    },
  );

  it("preserves confirmed archived identity when a replacement becomes active", async () => {
    const confirmation = createDeferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
    const target = sessionRow("confirmed", { archived: true });
    const { page, sessions } = await mountMutation();
    page.result = sessionsResult([target], 1);
    selectRows(page, target);
    const deleting = page.deleteSelected();
    expect(showConfirmDialog).toHaveBeenCalledOnce();
    sessions.state.result = sessionsResult(
      [{ ...target, sessionId: "replacement", archived: false }],
      2,
    );
    confirmation.resolve(true);
    await deleting;
    expect(sessions.deleteMany).toHaveBeenCalledWith([capturedTarget(target)]);
  });

  it("publishes unrelated roster updates while an optimistic deletion is pending", async () => {
    const target = sessionRow("before");
    const arrived = sessionRow("arrived", { updatedAt: 2 });
    const { page, sessions, deleteRequest, query, setRows } = await createDeletionPage([target]);
    const deleted = createDeferred<SessionDeleteOutcome>();
    deleteRequest.mockReturnValueOnce(deleted.promise);
    selectRows(page, target);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const deleting = page.deleteSelected();
    await waitForFast(() => expect(deleteRequest).toHaveBeenCalledOnce());
    expect(page.result?.sessions).toEqual([]);
    setRows([target, arrived]);
    await sessions.refreshList({ ...query, force: true });
    expect(page.result?.sessions.map(({ key }) => key)).toEqual([arrived.key]);
    setRows([arrived]);
    deleted.resolve({ deleted: true });
    await deleting;
    expect(page.result?.sessions).toEqual([arrived]);
    expect(page.selectedSessions.size).toBe(0);
  });

  it("does not delete after the Gateway changes during confirmation", async () => {
    const confirmation = createDeferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
    const { page, sessions, connection } = await mountMutation({ deleteMany: vi.fn() });
    const target = sessionRow("old");
    page.result = sessionsResult([target], 1);
    selectRows(page, target);
    const deleting = page.deleteSelected();
    connection.emit({ phase: "reconnecting", client: null });
    confirmation.resolve(true);
    await deleting;
    expect(sessions.deleteMany).not.toHaveBeenCalled();
  });

  it("derives per-row archive gates and retains failed selections", async () => {
    const active = sessionRow("active", { archived: false });
    const archived = sessionRow("archived", { archived: true });
    const retryError = `Session ${active.key} changed before deletion. Retry.`;
    const { page, sessions, deleteRequest } = await createDeletionPage([active, archived]);
    deleteRequest.mockRejectedValueOnce(new Error(retryError));
    selectRows(page, active, archived);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    await page.deleteSelected();
    expect(sessions.deleteMany).toHaveBeenCalledWith([
      capturedTarget(active),
      capturedTarget(archived),
    ]);
    expect(page.result).toMatchObject({
      count: 1,
      sessions: [{ key: active.key, archived: false }],
    });
    expect([...page.selectedSessions.keys()]).toEqual([active.key]);
    expect(page.error).toBe(retryError);
  });

  it.each(["active", "provisioning"] as const)(
    "stops a %s cloud worker while adopting roster updates",
    async (state) => {
      const stopped = createDeferred<{ ok: true }>();
      const request = vi.fn(() => stopped.promise);
      const managed = createManagedSessions();
      const context = createContext(
        createGateway({ request } as unknown as GatewayBrowserClient).gateway,
        managed.sessions,
      );
      const placement = {
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
        stateChangedAtMs: 1,
        environmentId: "environment-1",
      };
      const target = sessionRow("cloud", {
        label: "Cloud task",
        hasActiveRun: state === "provisioning",
        placement:
          state === "active"
            ? {
                ...placement,
                state,
                activeOwnerEpoch: 1,
                workerBundleHash: "0".repeat(64),
                workspaceBaseManifestRef: "base-ref",
                remoteWorkspaceDir: "/workspace",
              }
            : { ...placement, state },
      });
      const page = await createRenderedPage(context, sessionsResult([target], 1));
      expect((await openRowMenu(page, target)).textContent).toContain("Stop cloud worker…");
      const [query] = managed.subscribeList.mock.calls[0]!;
      managed.refreshList.mockClear();
      vi.mocked(showConfirmDialog).mockResolvedValue(true);
      const stopping = page.stopCloudWorker(target);
      await waitForFast(() => expect(request).toHaveBeenCalledOnce());
      publishRows(managed, [{ ...target, label: "Updated while stopping" }]);
      expect(page.result?.sessions[0]?.label).toBe("Updated while stopping");
      stopped.resolve({ ok: true });
      await stopping;
      expect(showConfirmDialog).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith(
        "sessions.reclaim",
        { key: target.key, agentId: "main" },
        { timeoutMs: null },
      );
      expect(managed.refreshList).toHaveBeenCalledWith({ ...query, force: true });
      expect(page.result?.sessions[0]?.label).toBe("Updated while stopping");
    },
  );

  it("drops stale mutation state, errors, menus, and navigation after disconnect", async () => {
    const deleted = createDeferred<Awaited<ReturnType<SessionCapability["deleteMany"]>>>();
    const patched = createDeferred<Awaited<ReturnType<SessionCapability["patch"]>>>();
    const forked = createDeferred<Awaited<ReturnType<SessionCapability["createResult"]>>>();
    const groups = createDeferred<Awaited<ReturnType<SessionCapability["groupsPut"]>>>();
    const { page, sessions, connection, context } = await mountMutation({
      deleteMany: vi.fn(() => deleted.promise),
      patch: vi.fn(() => patched.promise),
      createResult: vi.fn(() => forked.promise),
      groupsPut: vi.fn(() => groups.promise),
    });
    const target = sessionRow("main", { key: "main" });
    page.result = sessionsResult([target], 1);
    selectRows(page, target);
    page.openSessionMenu(target, { x: 10, y: 20 }, document.createElement("button"));
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const requests = [
      page.deleteSelected(),
      page.patchSession("main", { archived: true }, undefined, target.sessionId),
      page.forkSession("main"),
      page.rememberCustomGroup("Stale group"),
    ];
    await waitForFast(() => expect(sessions.deleteMany).toHaveBeenCalledOnce());
    connection.emit({ phase: "reconnecting" });
    deleted.resolve({
      deleted: ["main"],
      errors: [{ target: { key: "main" }, error: new Error("stale delete error") }],
      preservedWorktrees: [],
    });
    patched.resolve({ ok: true, key: "main", path: "", entry: { sessionId: target.sessionId! } });
    forked.resolve({
      key: "forked",
      entry: { sessionId: "forked-id" },
      initialRun: { status: "idle" },
    });
    groups.reject(new Error("stale group error"));
    expect(await Promise.all(requests)).toEqual(["stale", "stale", "stale", "stale"]);
    expect(page.result?.sessions.map(({ key }) => key)).toEqual(["main"]);
    expect([...page.selectedSessions.keys()]).toEqual(["main"]);
    expect([page.error, page.sessionMenu]).toEqual([null, null]);
    expect(connection.setSessionKey).not.toHaveBeenCalled();
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("forks an active session from its last completed message", async () => {
    const { page, sessions } = await mountMutation({
      createResult: vi.fn<SessionCapability["createResult"]>(async () => ({
        key: "active-fork",
        entry: { sessionId: "active-fork-id" },
        initialRun: { status: "idle" },
      })),
    });
    await page.forkSession("main", true);
    expect(sessions.createResult).toHaveBeenCalledWith(
      {
        parentSessionKey: "main",
        fork: true,
        forkFrom: "last-completed",
      },
      { signal: expect.any(AbortSignal) },
    );
  });
});

describe("sessions page new group", () => {
  const key = "agent:main:move-me";
  const sessionId = "original-session";
  const group = "Client work";
  const row = { key, sessionId, kind: "direct" as const, archived: false };
  const identity = { agentId: undefined, expectedSessionId: sessionId };
  const assignment = [key, { category: group }, identity];
  async function mount(groupsPut: () => Promise<SessionGroupMutationResult>) {
    const sessions = createSessions({
      groupsPut: vi.fn(groupsPut),
      patch: vi.fn(async () => ({ ok: true as const, key, path: "", entry: { sessionId } })),
    });
    const connection = createGateway();
    connection.emit({
      hello: gatewayHelloForMethods(
        ["sessions.groups.put", "sessions.patch"],
        ["operator.read", "operator.write"],
      ),
    });
    const page = await createRenderedPage(
      createContext(connection.gateway, sessions),
      sessionsResult([row], 1),
    );
    const messages: Array<string | null | undefined> = [];
    vi.mocked(showInputDialog).mockImplementation(async (options) => {
      messages.push(await options.submit?.(group));
      return group;
    });
    return { page, sessions, connection, messages };
  }

  it("keeps the live dialog abortable when a second open overlaps it", async () => {
    const { page, sessions } = await mount(async () => "completed");
    const signals: Array<AbortSignal | undefined> = [];
    vi.mocked(showInputDialog).mockImplementation(async (options) => {
      signals.push(options.signal);
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return null;
    });
    const first = page.requestNewCategory(key);
    await waitForFast(() => expect(signals).toHaveLength(1));
    const second = page.requestNewCategory(key);
    await waitForFast(() => expect(signals).toHaveLength(2));
    page.remove();
    await Promise.all([first, second]);
    expect(signals[0]?.aborted).toBe(true);
    expect(sessions.groupsPut).not.toHaveBeenCalled();
  });

  it("rejects a stale catalog write and lets the operator resubmit on the new connection", async () => {
    const pending = createDeferred<SessionGroupMutationResult>();
    const groupsPut = vi
      .fn<() => Promise<SessionGroupMutationResult>>()
      .mockResolvedValue("completed")
      .mockReturnValueOnce(pending.promise);
    const { connection, page, sessions, messages } = await mount(groupsPut);
    const created = page.requestNewCategory(key);
    await waitForFast(() => expect(sessions.groupsPut).toHaveBeenCalledOnce());
    connection.emit({ client: createTestGatewayClient(async () => ({ profiles: [] })) });
    pending.resolve("completed");
    await created;
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(messages).toEqual([
      "Gateway connection replaced before the group was saved. Try again.",
    ]);
    page.result = sessionsResult([row], 1);
    await page.requestNewCategory(key);
    expect(messages[1]).toBeNull();
    expect(sessions.patch).toHaveBeenCalledExactlyOnceWith(...assignment);
  });

  it("lets the Gateway reject a replaced row using the captured identity", async () => {
    const pending = createDeferred<SessionGroupMutationResult>();
    const { page, sessions, messages } = await mount(() => pending.promise);
    const failure = `Session ${key} changed before patch. Retry.`;
    vi.mocked(sessions.patch).mockImplementation(async (_key, _patch, options) => {
      if (options?.expectedSessionId !== "replacement-session") {
        throw new Error(failure);
      }
      return { ok: true, key, path: "", entry: { sessionId: "replacement-session" } };
    });
    const created = page.requestNewCategory(key);
    page.result = sessionsResult([{ ...row, sessionId: "replacement-session" }], 2);
    await waitForFast(() => expect(sessions.groupsPut).toHaveBeenCalledWith([group]));
    expect(sessions.patch).not.toHaveBeenCalled();
    pending.resolve("completed");
    await created;
    expect(sessions.patch).toHaveBeenCalledExactlyOnceWith(...assignment);
    expect(vi.mocked(sessions.patch).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(sessions.groupsPut).mock.invocationCallOrder[0]!,
    );
    expect(messages).toEqual([failure]);
  });

  it("creates an empty group without assigning a row", async () => {
    const { page, sessions, messages } = await mount(async () => "completed");
    await page.requestNewCategory();
    expect(sessions.groupsPut).toHaveBeenCalledWith([group]);
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(messages).toEqual([null]);
  });

  it("does not assign when the catalog write fails", async () => {
    const { page, sessions, messages } = await mount(async () => {
      throw new Error("Group name rejected");
    });
    await page.requestNewCategory(key);
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(messages).toEqual(["Group name rejected"]);
    await page.updateComplete;
    const alert = page.querySelector('[role="alert"]');
    expect(alert?.classList.contains("sessions-error")).toBe(true);
    expect(alert?.textContent).toContain("Group name rejected");
  });

  it.each(["failure", "retirement"])(
    "does not assign a dropped row after catalog %s",
    async (outcome) => {
      const catalog = createDeferred<SessionGroupMutationResult>();
      const { page, sessions, connection } = await mount(() => catalog.promise);
      const operation = page.onAssignCategory(key, group);
      await waitForFast(() => expect(sessions.groupsPut).toHaveBeenCalledWith([group]));
      if (outcome === "retirement") {
        connection.emit({ client: createTestGatewayClient(async () => ({ profiles: [] })) });
        catalog.resolve("completed");
      } else {
        catalog.reject(new Error("Group name rejected"));
      }
      await operation;
      expect(sessions.patch).not.toHaveBeenCalled();
    },
  );

  it("requires a refresh before starting an unbound move", async () => {
    const { page, sessions } = await mount(async () => "completed");
    page.result = sessionsResult([{ key, kind: "direct" }], 1);
    await page.requestNewCategory(key);
    expect(showInputDialog).not.toHaveBeenCalled();
    expect(sessions.groupsPut).not.toHaveBeenCalled();
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(page.error).toBe("Refresh");
  });
});

describe("sessions page plugin actions", () => {
  async function createPluginSessionMenuPage() {
    const row = sessionRow("review", { label: "Ready" });
    const managed = createManagedSessions();
    managed.sessions.state.result = sessionsResult([{ ...row, label: "Primary roster" }], 1);
    const context = createContext(createGateway().gateway, managed.sessions);
    const run = vi.fn<ControlUiAction["run"]>();
    const { entry } = registerSessionPluginAction(context, {
      id: "review",
      label: "Review session",
      placement: "session",
      resolve: ({ session }) => ({
        label: `Review ${session?.label}`,
        hidden: session?.archived === true,
        disabled: session?.hasActiveRun === true,
      }),
      run,
    });
    const page = await createRenderedPage(context, sessionsResult([row], 1), "all");
    const publish = (rows: GatewaySessionRow[]) => publishRows(managed, rows);
    const openMenu = () => openRowMenu(page, row);
    const actionSelector = `[value="plugin:${entry.key}"]`;
    return { page, row, run, publish, openMenu, actionSelector };
  }

  it("keeps the open menu mounted while a refreshed row updates its actions", async () => {
    const { page, row, publish, openMenu } = await createPluginSessionMenuPage();
    const menu = await openMenu();
    publish([{ ...row, label: "Latest" }]);
    await page.updateComplete;
    await menu.updateComplete;
    expect(page.querySelector("openclaw-session-menu")).toBe(menu);
    expect(menu.pluginActions[0]?.label).toBe("Review Latest");
  });

  it("keeps the menu mounted and masks stale destinations while a reopened lookup resolves", async () => {
    type Work = Awaited<ReturnType<typeof sessionMenuWork.fetchSessionMenuWork>>;
    const earlier = createDeferred<Work>();
    const current = createDeferred<Work>();
    const reopened = createDeferred<Work>();
    const load = vi
      .spyOn(sessionMenuWork, "fetchSessionMenuWork")
      .mockReturnValueOnce(earlier.promise)
      .mockReturnValueOnce(current.promise)
      .mockReturnValueOnce(reopened.promise);
    const rows = ["earlier", "current"].map((id) =>
      sessionRow(id, {
        worktree: { id, branch: `feature/${id}`, repoRoot: "/synthetic/repo" },
      }),
    );
    const managed = createManagedSessions();
    const context = createContext(createGateway().gateway, managed.sessions);
    const page = await createRenderedPage(context, sessionsResult(rows, 1), "all");
    const menu = await openRowMenu(page, rows[0]!);
    expect(menu.querySelector('[value="open-pr"]')).toBeNull();
    expect(await openRowMenu(page, rows[1]!)).toBe(menu);

    earlier.resolve({ pullRequestUrl: "https://example.test/earlier", worktreePath: null });
    await earlier.promise;
    await page.updateComplete;
    expect(menu.querySelector('[value="open-pr"]')).toBeNull();

    current.resolve({ pullRequestUrl: "https://example.test/current", worktreePath: null });
    await waitForFast(() => expect(menu.work?.pullRequestUrl).toBe("https://example.test/current"));
    expect(page.querySelector("openclaw-session-menu")).toBe(menu);
    expect(menu.querySelector('[value="open-pr"]')).not.toBeNull();

    expect(await openRowMenu(page, rows[0]!)).toBe(menu);
    expect(menu.querySelector('[value="open-pr"]')).toBeNull();
    reopened.resolve({ pullRequestUrl: "https://example.test/reopened", worktreePath: null });
    await waitForFast(() =>
      expect(menu.work?.pullRequestUrl).toBe("https://example.test/reopened"),
    );
    expect(page.querySelector("openclaw-session-menu")).toBe(menu);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("uses current scoped session state when invoking plugin menu actions", async () => {
    const { page, row, run, publish, openMenu, actionSelector } =
      await createPluginSessionMenuPage();
    let menu = await openMenu();
    const current = { ...row, label: "Latest" };

    publish([current]);
    menu.querySelector<HTMLElement>(actionSelector)!.click();
    await settleSessionMenu(menu);
    expect(run.mock.calls.length).toBe(1);
    const invocation = run.mock.calls[0]![0];
    expect([invocation.sessionKey, invocation.session]).toEqual([row.key, current]);
    await page.updateComplete;

    menu = await openMenu();
    publish([{ ...current, hasActiveRun: true }]);
    menu.querySelector<HTMLElement>(actionSelector)!.click();
    await settleSessionMenu(menu);
    expect(run.mock.calls.length).toBe(1);
    await waitForFast(() => expect(page.textContent).toContain("Reopen the session menu."));

    publish([{ ...current, archived: true }]);
    await page.updateComplete;
    expect((await openMenu()).pluginActions).toEqual([]);
  });

  it("does not invoke a plugin for a removed or replaced menu session", async () => {
    const { page, row, run, publish, openMenu, actionSelector } =
      await createPluginSessionMenuPage();
    const replacement = { ...row, sessionId: "replacement-id", label: "Replacement" };
    for (const rows of [[], [replacement]]) {
      publish([row]);
      await page.updateComplete;
      const menu = await openMenu();
      publish(rows);
      menu.querySelector<HTMLElement>(actionSelector)!.click();
      await settleSessionMenu(menu);
      expect(run.mock.calls.length).toBe(0);
      await waitForFast(() => expect(page.textContent).toContain("Reopen the session menu."));
    }

    expect(page.querySelector(actionSelector)).toBeNull();
  });

  it("revokes plugin navigation after detaching", async () => {
    const pending = createDeferred();
    const context = createContext(createGateway().gateway, createSessions());
    const run = vi.fn(
      async ({ host, sessionKey, session }: Parameters<ControlUiAction["run"]>[0]) => {
        await pending.promise;
        host.sessions.open({ sessionKey, agentId: session?.agentId });
      },
    );
    const { entry, open } = registerSessionPluginAction(context, {
      id: "review",
      label: "Open review",
      placement: "session",
      run,
    });
    const row = sessionRow("review");
    const page = await createRenderedPage(context, sessionsResult([row], 1));
    const request = page.runPluginAction(entry.key, row);
    expect(run).toHaveBeenCalledOnce();
    page.remove();
    pending.resolve();
    await request;
    expect(open).not.toHaveBeenCalled();
    expect(page.error).toBeNull();
  });
});
