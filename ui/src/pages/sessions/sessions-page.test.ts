/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiAction } from "../../../../src/plugin-sdk/control-ui.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { showInputDialog } from "../../components/input-dialog.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
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
import { page as sessionsRoute, type SessionsRouteData } from "./route.ts";
import {
  createContext,
  createGateway,
  createManagedSessions,
  createPage,
  createRenderedPage,
  createSessions,
  type TestSessionsPage,
} from "./sessions-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
vi.mock("../../components/input-dialog.ts", () => ({ showInputDialog: vi.fn() }));
type TestSessionMenu = HTMLElement & {
  pluginActions: readonly { id: string; label: string; disabled?: boolean }[];
  readonly updateComplete: Promise<boolean>;
};
const sessionRow = (key: string, extra: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key: `agent:main:${key}`,
  sessionId: `${key}-id`,
  kind: "direct",
  updatedAt: 1,
  ...extra,
});
async function mountMutation(sessions = createSessions()) {
  const connection = createGateway();
  const context = createContext(connection.gateway, sessions);
  return { page: await createPage(context), connection, context, sessions };
}
async function openRowMenu(page: TestSessionsPage, target: GatewaySessionRow) {
  page.openSessionMenu(target, { x: 10, y: 20 }, document.createElement("button"));
  await page.updateComplete;
  const menu = page.querySelector<TestSessionMenu>("openclaw-session-menu")!;
  expect(menu).not.toBeNull();
  await menu.updateComplete;
  return menu;
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
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "sessions.list") {
      return sessionsResult(serverRows, 1);
    }
    if (method === "sessions.delete") {
      return deleteRequest(params as SessionDeleteTarget);
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const connection = createGateway({ request } as unknown as GatewayBrowserClient);
  const sessions = createTestSessionCapability(connection.gateway, agentId);
  onTestFinished(() => sessions.dispose());
  const subscribe = vi.spyOn(sessions, "subscribeList");
  vi.spyOn(sessions, "deleteMany");
  const context = createContext(connection.gateway, sessions);
  context.agentSelection.state.selectedId = agentId;
  context.agentSelection.state.scopeId = agentId;
  const page = await createRenderedPage(context, sessionsResult(rows, 1), "all");
  await vi.waitFor(() => expect(page.loading).toBe(false));
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
  it("pins from the page menu without changing shared pin metadata", async () => {
    const row = sessionRow("personal-pin", { pinned: true, sharingRole: "viewer" });
    const sessions = createSessions();
    const connection = createGateway();
    const context = createContext(connection.gateway, sessions);
    const page = await createRenderedPage(context, sessionsResult([row], 1));
    const menu = await openRowMenu(page, row);
    const entry = menu.querySelector('[value="toggle-pin"]');
    expect(entry).not.toBeNull();
    expect(entry?.hasAttribute("disabled")).toBe(false);
    menu.querySelector("wa-dropdown")!.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "toggle-pin" } },
      }),
    );
    expect(context.navigation.snapshot.sidebarEntries).toContain("session:" + row.key);
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(row.pinned).toBe(true);
  });
  it.each([false, true])(
    "reports owner assignment failure only in its current page (retired: %s)",
    async (retired) => {
      const row = {
        key: "agent:main:assignment",
        sessionId: "assignment-session",
        kind: "direct",
        label: "Assignment fixture",
        updatedAt: 1,
      } satisfies GatewaySessionRow;
      const assignment = createDeferred<unknown>();
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.assignOwner") {
          return assignment.promise;
        }
        if (method === "sessions.list") {
          return sessionsResult([row], 1);
        }
        if (method === "users.list") {
          return { profiles: [] };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
      const sessions = createTestSessionCapability(mutableGateway.gateway, "main");
      onTestFinished(() => sessions.dispose());
      const assignOwner = vi.spyOn(sessions, "assignOwner");
      const context = createContext(mutableGateway.gateway, sessions);
      const page = await createRenderedPage(context, sessionsResult([row], 1));
      await vi.waitFor(() => expect(page.loading).toBe(false));
      page.openSessionMenu(row, { x: 10, y: 20 }, document.createElement("button"));
      await page.updateComplete;
      const menu = page.querySelector<TestSessionMenu>("openclaw-session-menu");
      await menu?.updateComplete;
      menu?.querySelector("wa-dropdown")?.dispatchEvent(
        new CustomEvent("wa-select", {
          detail: { item: { value: "assign-owner:agent:reviewer" } },
          bubbles: true,
        }),
      );
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("sessions.assignOwner", {
          key: row.key,
          owner: { type: "agent", id: "reviewer" },
        }),
      );
      if (retired) {
        mutableGateway.emit({ phase: "reconnecting", client: null });
      }
      assignment.reject(new Error("Assignment unavailable. Try again."));
      await assignOwner.mock.results[0]!.value;
      if (retired) {
        await page.updateComplete;
        expect(page.textContent).not.toContain("Assignment unavailable. Try again.");
      } else {
        await vi.waitFor(() =>
          expect(page.textContent).toContain("Assignment unavailable. Try again."),
        );
        expect(page.textContent).toContain("Assignment fixture");
      }
    },
  );

  it.each(["startup", "same-client reconnect"])(
    "retains the current query when a route started before %s completes late",
    async (ordering) => {
      const config = createDeferred();
      const sidebar = createDeferred<SessionsListResult>();
      const result = (key: string) => sessionsResult([{ key, kind: "direct", updatedAt: 1 }], 1);
      let pageRequests = 0;
      const request = vi.fn(async (method: string, params?: { includeUnknown?: boolean }) => {
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method !== "sessions.list") {
          throw new Error(`Unexpected request: ${method}`);
        }
        return params?.includeUnknown === false
          ? result(`agent:main:current-${++pageRequests}`)
          : sidebar.promise;
      });
      const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
      if (ordering === "startup") {
        mutableGateway.emit({ phase: "connecting" });
      }
      const sessions = createTestSessionCapability(mutableGateway.gateway);
      const context = createContext(mutableGateway.gateway, sessions);
      context.runtimeConfig.ensureLoaded = () => config.promise;
      const pendingRoute = sessionsRoute.loader!(context, {
        signal: new AbortController().signal,
        shouldRun: () => true,
        revalidating: false,
        location: { pathname: "/sessions", search: "", hash: "" },
        deps: "",
        cause: "navigation",
      });
      mutableGateway.emit({ phase: "connected" });
      const page = await createPage(context);
      try {
        await vi.waitFor(() => expect(page.result?.sessions[0]?.key).toBe("agent:main:current-1"));
        if (ordering === "same-client reconnect") {
          mutableGateway.emit({ phase: "reconnecting" });
          mutableGateway.emit({ phase: "connected", hello: sessionMutationGatewayHello() });
          sidebar.resolve(result("agent:main:sidebar"));
          await vi.waitFor(() =>
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
        await vi.waitFor(() =>
          expect(sessions.state.result?.sessions[0]?.key).toBe("agent:main:sidebar"),
        );
        mutableGateway.emit({ sessionKey: "agent:main:other" });
        page.context = { ...context };
        await page.updateComplete;
        expect(pageRequests).toBe(expectedRequests);
        expect(page.result?.sessions[0]?.key).toBe(`agent:main:current-${expectedRequests}`);
      } finally {
        config.resolve();
        sidebar.resolve(result("agent:main:sidebar"));
        page.remove();
        sessions.dispose();
      }
    },
  );

  it("reports a connection error instead of silently dropping a patch", async () => {
    const { page, connection, sessions } = await mountMutation(createSessions({ patch: vi.fn() }));
    connection.emit({ phase: "reconnecting", client: null });
    expect(await page.patchSession("agent:main:main", { label: "renamed" })).toBe("failed");
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(page.error).toBe("Connect to the Gateway to change sessions.");
  });

  it("patches color from the rendered session menu", async () => {
    const target = sessionRow("color");
    const sessions = createSessions();
    const context = createContext(createGateway().gateway, sessions);
    const page = await createRenderedPage(context, sessionsResult([target], 1));
    const menu = await openRowMenu(page, target);
    const item = menu.querySelector<HTMLButtonElement>(
      '.session-menu__color-choice[aria-label="Green"]',
    )!;
    item.click();
    await vi.waitFor(() =>
      expect(sessions.patch).toHaveBeenCalledWith(
        target.key,
        { color: "green" },
        { agentId: undefined },
      ),
    );
  });

  it("hides pinning for a lineage child", async () => {
    const target = sessionRow("dashboard:child", { parentSessionKey: "agent:main:parent" });
    const context = createContext(createGateway().gateway, createSessions());
    const page = await createRenderedPage(context, sessionsResult([target], 1));
    expect((await openRowMenu(page, target)).querySelector('[value="toggle-pin"]')).toBeNull();
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
    const item = menu.querySelector('[value="toggle-involving-me"]')!;
    expect(item.textContent).toContain("Show in Involving me");
    expect(item.hasAttribute("disabled")).toBe(false);
    managed.refreshList.mockClear();
    menu.querySelector("wa-dropdown")!.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        detail: { item: { value: "toggle-involving-me" } },
      }),
    );
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "sessions.setInvolvement",
        expect.objectContaining({
          key: target.key,
          expectedSessionId: target.sessionId,
          hidden: false,
        }),
      ),
    );
    await vi.waitFor(() => expect(managed.refreshList).toHaveBeenCalled());
    expect(managed.sessions.patch).not.toHaveBeenCalled();
  });

  it("retargets the Gateway after deleting the current session", async () => {
    const target = sessionRow("work", { key: "agent:writer:work" });
    const { page, sessions, connection } = await createDeletionPage([target], "writer");
    connection.emit({ sessionKey: target.key });
    page.selectedSessions = new Map([[target.key, target]]);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    await page.deleteSelected();
    expect(sessions.deleteMany).toHaveBeenCalledWith([
      { key: target.key, agentId: undefined, expectedSessionId: target.sessionId },
    ]);
    expect(connection.setSessionKey).toHaveBeenCalledWith("agent:writer:main");
    expect(page.result?.sessions).toEqual([]);
    expect(page.selectedSessions.size).toBe(0);
  });

  it("preserves confirmed archived identity when a replacement becomes active", async () => {
    const confirmation = createDeferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
    const { page, sessions } = await mountMutation();
    const target = sessionRow("confirmed", { archived: true });
    page.result = sessionsResult([target], 1);
    page.selectedSessions = new Map([[target.key, target]]);
    const deleting = page.deleteSelected();
    expect(showConfirmDialog).toHaveBeenCalledOnce();
    page.result = sessionsResult([{ ...target, sessionId: "replacement", archived: false }], 2);
    confirmation.resolve(true);
    await deleting;
    expect(sessions.deleteMany).toHaveBeenCalledWith([
      {
        key: target.key,
        agentId: undefined,
        expectedSessionId: target.sessionId,
        archivedOnly: true,
      },
    ]);
  });

  it("publishes unrelated roster updates while an optimistic deletion is pending", async () => {
    const target = sessionRow("before");
    const arrived = sessionRow("arrived", { updatedAt: 2 });
    const { page, sessions, deleteRequest, query, setRows } = await createDeletionPage([target]);
    const deleted = createDeferred<SessionDeleteOutcome>();
    deleteRequest.mockReturnValueOnce(deleted.promise);
    page.selectedSessions = new Map([[target.key, target]]);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const deleting = page.deleteSelected();
    await vi.waitFor(() => expect(deleteRequest).toHaveBeenCalledOnce());
    expect(page.sessionMutationPending).toBe(true);
    expect(page.result?.sessions).toEqual([]);
    setRows([target, arrived]);
    await sessions.refreshList({ ...query, force: true });
    expect(page.sessionMutationPending).toBe(true);
    expect(page.result?.sessions.map(({ key }) => key)).toEqual([arrived.key]);
    setRows([arrived]);
    deleted.resolve({ deleted: true });
    await deleting;
    expect(page.result?.sessions).toEqual([arrived]);
    expect(page.selectedSessions.size).toBe(0);
    expect(page.sessionMutationPending).toBe(false);
  });

  it("does not delete after the Gateway changes during confirmation", async () => {
    const confirmation = createDeferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
    const { page, sessions, connection } = await mountMutation(
      createSessions({ deleteMany: vi.fn() }),
    );
    const target = sessionRow("old");
    page.result = sessionsResult([target], 1);
    page.selectedSessions = new Map([[target.key, target]]);
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
    page.selectedSessions = new Map([
      [active.key, active],
      [archived.key, archived],
    ]);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    await page.deleteSelected();
    expect(sessions.deleteMany).toHaveBeenCalledWith([
      { key: active.key, agentId: undefined, expectedSessionId: active.sessionId },
      {
        key: archived.key,
        agentId: undefined,
        archivedOnly: true,
        expectedSessionId: archived.sessionId,
      },
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
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      managed.publish(query, {
        result: sessionsResult([{ ...target, label: "Updated while stopping" }], 2),
        agentId: "main",
        loading: false,
        error: null,
      });
      expect(page.sessionMutationPending).toBe(true);
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
      expect(page.sessionMutationPending).toBe(false);
    },
  );

  it("drops stale mutation state, errors, menus, and navigation after disconnect", async () => {
    const deleted = createDeferred<Awaited<ReturnType<SessionCapability["deleteMany"]>>>();
    const patched = createDeferred<Awaited<ReturnType<SessionCapability["patch"]>>>();
    const forked = createDeferred<string | null>();
    const groups = createDeferred<Awaited<ReturnType<SessionCapability["groupsPut"]>>>();
    const { page, sessions, connection, context } = await mountMutation(
      createSessions({
        deleteMany: vi.fn(() => deleted.promise),
        patch: vi.fn(() => patched.promise),
        create: vi.fn(() => forked.promise),
        groupsPut: vi.fn(() => groups.promise),
      }),
    );
    const target = sessionRow("main", { key: "main" });
    page.result = sessionsResult([target], 1);
    page.selectedSessions = new Map([[target.key, target]]);
    page.openSessionMenu(target, { x: 10, y: 20 }, document.createElement("button"));
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const requests = [
      page.deleteSelected(),
      page.patchSession("main", { archived: true }, undefined, target.sessionId),
      page.forkSession("main"),
      page.rememberCustomGroup("Stale group"),
    ];
    await vi.waitFor(() => expect(sessions.deleteMany).toHaveBeenCalledOnce());
    connection.emit({ phase: "reconnecting" });
    deleted.resolve({
      deleted: ["main"],
      errors: [{ target: { key: "main" }, error: new Error("stale delete error") }],
      preservedWorktrees: [],
    });
    patched.resolve({ ok: true, key: "main", path: "", entry: { sessionId: target.sessionId! } });
    forked.resolve("forked");
    groups.reject(new Error("stale group error"));
    await Promise.all(requests);
    expect(page.result?.sessions.map(({ key }) => key)).toEqual(["main"]);
    expect([...page.selectedSessions.keys()]).toEqual(["main"]);
    expect(page.error).toBeNull();
    expect(page.sessionMenu).toBeNull();
    expect(page.sessionMenuTrigger).toBeNull();
    expect(page.sessionMutationPending).toBe(false);
    expect(connection.setSessionKey).not.toHaveBeenCalled();
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("forks an active session from its last completed message", async () => {
    const { page, sessions } = await mountMutation(
      createSessions({ create: vi.fn(async () => "active-fork") }),
    );
    await page.forkSession("main", true);
    expect(sessions.create).toHaveBeenCalledWith({
      parentSessionKey: "main",
      fork: true,
      forkFrom: "last-completed",
    });
  });
});

describe("sessions page new group", () => {
  const key = "agent:main:move-me";
  const sessionId = "original-session";
  const row = { key, sessionId, kind: "direct" as const, archived: false };
  const assignment = [
    key,
    { category: "Client work" },
    { agentId: undefined, expectedSessionId: sessionId },
  ];
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
      messages.push(await options.submit?.("Client work"));
      return "Client work";
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
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const second = page.requestNewCategory(key);
    await vi.waitFor(() => expect(signals).toHaveLength(2));
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
    await vi.waitFor(() => expect(sessions.groupsPut).toHaveBeenCalledOnce());
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
    await vi.waitFor(() => expect(sessions.groupsPut).toHaveBeenCalledWith(["Client work"]));
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
    expect(sessions.groupsPut).toHaveBeenCalledWith(["Client work"]);
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

  it("requires a refresh before starting an unbound move", async () => {
    const { page, sessions } = await mount(async () => "completed");
    page.result = sessionsResult([{ key, kind: "direct" }], 1);
    await page.requestNewCategory(key);
    expect(showInputDialog).not.toHaveBeenCalled();
    expect(sessions.groupsPut).not.toHaveBeenCalled();
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(page.error).toBe("Refresh");
  });

  it("does not assign when the catalog owner reports a stale write", async () => {
    const { page, sessions, messages } = await mount(async () => "stale");
    await page.requestNewCategory(key);
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(messages).toEqual([
      "Gateway connection replaced before the group was saved. Try again.",
    ]);
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
    const [query] = managed.subscribeList.mock.calls[0]!;
    const publish = (rows: GatewaySessionRow[]) => {
      managed.publish(query, {
        result: sessionsResult(rows, 2),
        agentId: "main",
        loading: false,
        error: null,
      });
    };
    const openMenu = () => openRowMenu(page, row);
    return { page, row, run, publish, openMenu, actionSelector: `[value="plugin:${entry.key}"]` };
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

  it("uses current scoped session state when invoking plugin menu actions", async () => {
    const { page, row, run, publish, openMenu, actionSelector } =
      await createPluginSessionMenuPage();
    let menu = await openMenu();
    const current = { ...row, label: "Latest" };

    // Keep the old menu mounted while the scoped roster publishes a new row.
    publish([current]);
    menu.querySelector<HTMLElement>(actionSelector)!.click();
    expect(run.mock.calls.length).toBe(1);
    expect(run.mock.calls[0]![0].sessionKey).toBe(row.key);
    expect(run.mock.calls[0]![0].session).toEqual(current);
    await page.updateComplete;

    menu = await openMenu();
    publish([{ ...current, hasActiveRun: true }]);
    menu.querySelector<HTMLElement>(actionSelector)!.click();
    expect(run.mock.calls.length).toBe(1);
    await vi.waitFor(() => expect(page.textContent).toContain("Reopen the session menu."));

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
      expect(run.mock.calls.length).toBe(0);
      await vi.waitFor(() => expect(page.textContent).toContain("Reopen the session menu."));
    }

    expect(page.querySelector(actionSelector)).toBeNull();
  });

  it("revokes plugin navigation after detaching", async () => {
    const pending = createDeferred();
    const mutableGateway = createGateway();
    const context = createContext(mutableGateway.gateway, createSessions());
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
