import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlUiAction } from "../../../../src/plugin-sdk/control-ui.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { publishSidebarSessionList } from "../../components/session-data-events.ts";
import "../../lib/toast-host.ts";
import {
  pauseSessionPlacementRecovery,
  readSessionPlacementRecovery,
} from "../../lib/sessions/session-placement-recovery.ts";
import {
  createGatewayHarness,
  type SidebarLifecycleState,
  successfulSessionPatch,
  type TestSessionMenu,
} from "../app-sidebar.ts";
import { registerSessionPluginAction } from "../control-ui-plugin-action.ts";
import { gatewayHelloForMethods } from "../gateway-methods.ts";
import { settleLitElement } from "../lit-settle.ts";
import {
  answerConfirmDialog,
  installDialogPolyfill,
  waitForConfirmDialogActions,
} from "../modal-dialog.ts";
import { menuItemLabels, openSubmenu, selectMenuValue } from "../session-menu.ts";
import { sessionOwnerProfiles } from "../session-owner-menu.ts";
import { waitForFast } from "../wait-for.ts";
import {
  sessionFixture,
  sessionResult,
  human,
  sessionQuery,
} from "./session-suite.test-support.ts";

const targetKey = "agent:main:a";
const otherKey = "agent:main:b";
const errorText = (sidebar: SidebarLifecycleState) =>
  sidebar.querySelector("[data-sidebar-session-error]")?.textContent;
const successfulBatch = () => ({
  outcomes: [targetKey, otherKey].map((key) => ({ ok: true as const, key })),
});

describe("AppSidebar session mutation feedback", () => {
  let restoreDialogPolyfill: () => void;

  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
  });

  afterEach(() => restoreDialogPolyfill());

  async function mountMutationHarness(
    client: GatewayBrowserClient = {} as GatewayBrowserClient,
    directory = sessionOwnerProfiles(),
  ) {
    const harness = sessionFixture(["agent:main:main", targetKey, otherKey]);
    const originalRequest = client.request?.bind(client) as
      | GatewayBrowserClient["request"]
      | undefined;
    client.request = <T = unknown>(
      ...args: Parameters<GatewayBrowserClient["request"]>
    ): Promise<T> => {
      const [method, params] = args;
      if (method === "users.list") {
        return Promise.resolve(directory as T);
      }
      if (method === "sessions.describe") {
        const { key } = params as { key: string };
        return Promise.resolve({
          session: harness.sessions.state.result?.sessions.find((row) => row.key === key),
        } as T);
      }
      if (method === "sessions.patchMany") {
        const request = params as {
          targets: Array<{ key: string; agentId?: string }>;
          patch: Record<string, unknown>;
        };
        return harness.patchMany(request.targets, request.patch).then((result) => result as T);
      }
      return originalRequest
        ? originalRequest<T>(...args)
        : Promise.reject(new Error(`unexpected request: ${method}`));
    };
    const gateway = createGatewayHarness(client);
    const { sidebar, context } = await harness.mount(gateway.gateway);
    sidebar.connected = true;
    await sidebar.updateComplete;
    return { gateway, harness, sidebar, context };
  }

  async function openSessionMenu(sidebar: SidebarLifecycleState, key: string) {
    const row = sessionQuery<HTMLElement>(sidebar, key)!;
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;
    const menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu")!;
    await menu.updateComplete;
    return menu;
  }

  function selectSession(sidebar: SidebarLifecycleState, key: string) {
    const link = sessionQuery<HTMLAnchorElement>(sidebar, key, ".sidebar-recent-session__link")!;
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true }));
  }

  async function batchMenu(sidebar: SidebarLifecycleState, keys = ["a", "b"]) {
    for (const key of keys) {
      selectSession(sidebar, `agent:main:${key}`);
    }
    await sidebar.updateComplete;
    return openSessionMenu(sidebar, `agent:main:${keys.at(-1)}`);
  }

  async function cloudWorkerHarness(state: "active" | "provisioning") {
    const request = vi.fn(() => Promise.resolve({ ok: true }));
    const mounted = await mountMutationHarness({ request } as unknown as GatewayBrowserClient);
    mounted.gateway.publish({ hello: gatewayHelloForMethods(["sessions.reclaim"]) });
    const result = sessionResult(["agent:main:main", targetKey]);
    const row = result.sessions[1]!;
    const placement = {
      state,
      generation: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
      stateChangedAtMs: 1,
      environmentId: "environment-1",
    };
    row.placement =
      state === "active"
        ? {
            ...placement,
            state,
            activeOwnerEpoch: 1,
            workerBundleHash: "0".repeat(64),
            workspaceBaseManifestRef: "base-ref",
            remoteWorkspaceDir: "/workspace",
          }
        : { ...placement, state };
    if (state === "provisioning") {
      row.hasActiveRun = true;
    }
    mounted.harness.publishList({ result, agentId: "main" });
    await mounted.sidebar.updateComplete;
    return { ...mounted, row, request };
  }

  async function expectWorkerReclaimed(mounted: Awaited<ReturnType<typeof cloudWorkerHarness>>) {
    const { request, context, harness } = mounted;
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    expect(context.placementStartup.pause).toHaveBeenCalledExactlyOnceWith(
      targetKey,
      "Worker stop requested. Review the initial message before retrying.",
      { readSessionPlacementRecovery, pauseSessionPlacementRecovery },
    );
    expect(context.placementStartup.pause).toHaveBeenCalledBefore(request);
    expect(request).toHaveBeenCalledWith(
      "sessions.reclaim",
      { key: targetKey, agentId: "main" },
      { timeoutMs: null },
    );
    await waitForFast(() => expect(harness.reconcileMutation).toHaveBeenCalledWith("main"));
  }

  async function mountToastHost() {
    const host = document.createElement("openclaw-toast-host");
    document.body.append(host);
    await host.updateComplete;
    return host;
  }

  async function mountSessionPluginHarness() {
    const { harness, sidebar, context } = await mountMutationHarness();
    const result = sessionResult([targetKey]);
    const row = { ...result.sessions[0]!, label: "Ready" };
    harness.list.mockResolvedValue({ ...result, sessions: [row] });
    Object.assign(sidebar, { sessionsStatusFilter: "all" });
    sidebar.sessionData.resetSessionList();
    await sidebar.sessionData.refreshSidebarSessions("main");
    const run = vi.fn<ControlUiAction["run"]>();
    const { entry } = registerSessionPluginAction(context, {
      id: "review",
      label: "Review session",
      placement: "session",
      resolve: ({ session }) => ({
        label: `Review ${session?.label}`,
        disabled: session?.hasActiveRun === true,
      }),
      run,
    });
    sidebar.invalidate();
    await sidebar.updateComplete;
    const publish = (rows: GatewaySessionRow[]) => {
      publishSidebarSessionList(sidebar.sessionData, {
        result: { ...result, count: rows.length, sessions: rows },
        agentId: "main",
        loading: false,
        error: null,
      });
      sidebar.sessionData.requestSessionDataUpdate();
    };
    return {
      sidebar,
      row,
      run,
      publish,
      openMenu: () => openSessionMenu(sidebar, row.key),
      actionSelector: `[value="plugin:${entry.key}"]`,
    };
  }

  it("uses current scoped session state when invoking plugin menu actions", async () => {
    const { sidebar, row, run, publish, openMenu, actionSelector } =
      await mountSessionPluginHarness();
    const toast = await mountToastHost();
    let menu = await openMenu();
    const current = { ...row, label: "Latest" };

    // The filtered roster changes before rendering; the primary roster keeps its old row.
    publish([current]);
    await selectMenuValue(menu, menu.querySelector<HTMLButtonElement>(actionSelector)!.value);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0]).toMatchObject({ sessionKey: row.key });
    expect(run.mock.calls[0]![0].session).toEqual(current);
    await sidebar.updateComplete;

    menu = await openMenu();
    publish([{ ...current, hasActiveRun: true }]);
    await selectMenuValue(menu, menu.querySelector<HTMLButtonElement>(actionSelector)!.value);
    expect(run.mock.calls.length).toBe(1);
    await waitForFast(() => expect(toast.textContent).toContain("Reopen the session menu."));
  });

  it("does not invoke a plugin for a removed or replaced menu session", async () => {
    const { sidebar, row, run, publish, openMenu, actionSelector } =
      await mountSessionPluginHarness();
    const replacement = { ...row, sessionId: "replacement-id", label: "Replacement" };
    for (const rows of [[], [replacement]]) {
      publish([row]);
      await sidebar.updateComplete;
      const toast = await mountToastHost();
      const menu = await openMenu();
      publish(rows);
      await selectMenuValue(menu, menu.querySelector<HTMLButtonElement>(actionSelector)!.value);
      expect(run.mock.calls.length).toBe(0);
      await waitForFast(() => expect(toast.textContent).toContain("Reopen the session menu."));
      toast.remove();
    }

    publish([row]);
    await sidebar.updateComplete;
    const menu = await openMenu();
    publish([replacement]);
    await settleLitElement(sidebar);
    await menu.updateComplete;
    expect(menu.querySelector(actionSelector)).toBeNull();
  });

  it("offers archive undo without altering the active session's personal pin or navigation", async () => {
    const { gateway, harness, sidebar } = await mountMutationHarness();
    const setSessionKey = vi.fn();
    (gateway.gateway as { setSessionKey: (key: string) => void }).setSessionKey = setSessionKey;
    const archivedKey = "agent:main:dashboard:00000002-0000-4000-8000-000000000000";
    const result = sessionResult(["agent:main:main", archivedKey, otherKey]);
    const archivedRow = result.sessions[1]!;
    const archiveScope = { agentId: "main", expectedSessionId: `session:${archivedRow.key}` };
    sidebar.sidebarEntries = [`session:${archivedKey}`];
    harness.publishList({ result, agentId: "main" });
    gateway.publish({ sessionKey: archivedRow.key });
    sidebar.sessionKey = archivedRow.key;
    sidebar.activeRouteId = "chat";
    const navigate = vi.fn();
    sidebar.onNavigate = navigate;
    const toast = await mountToastHost();
    gateway.publish({ hello: gatewayHelloForMethods(["sessions.patch"], ["operator.read"]) });
    await sidebar.updateComplete;

    const archive = sessionQuery<HTMLButtonElement>(
      sidebar,
      archivedRow.key,
      "[data-sidebar-session-archive]",
    );
    expect(archive?.disabled).toBe(true);
    archive!.click();
    expect(harness.patch).not.toHaveBeenCalled();

    gateway.publish({ hello: gatewayHelloForMethods(["sessions.patch"]) });
    await sidebar.updateComplete;
    expect(archive?.disabled).toBe(false);
    const pendingArchive = deferred<Awaited<ReturnType<typeof harness.patch>>>();
    harness.patch.mockReturnValueOnce(pendingArchive.promise);
    archive!.click();
    archive!.click();
    await vi.waitFor(() => expect(harness.patch).toHaveBeenCalledOnce());
    await sidebar.updateComplete;
    expect(sessionQuery(sidebar, archivedRow.key)).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    pendingArchive.resolve(successfulSessionPatch(archivedRow.key));
    await vi.waitFor(() =>
      expect(toast.querySelector(".app-toast__message")?.textContent).toBe("Session archived"),
    );
    toast.querySelector<HTMLButtonElement>(".app-toast__action")?.click();

    await vi.waitFor(() => expect(harness.refreshReplacement).toHaveBeenCalledOnce());
    expect(setSessionKey).not.toHaveBeenCalled();
    expect(harness.patch.mock.calls).toEqual([
      [archivedRow.key, { archived: true }, archiveScope],
      [archivedRow.key, { archived: false }, { ...archiveScope, deferListRefresh: true }],
    ]);
    expect(harness.patchMany).not.toHaveBeenCalled();
    expect(sidebar.sidebarEntries).toEqual([`session:${archivedKey}`]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("assigns owners from the row menu and updates the owner chip", async () => {
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method !== "sessions.assignOwner") {
        throw new Error(`unexpected method: ${method}`);
      }
      const owner = (params as { owner: { type: "human"; id: string } }).owner;
      const label = owner.id === "profile-ada" ? "Ada" : "Bob";
      return {
        ok: true,
        key: targetKey,
        owner: {
          actor: { ...owner, label },
          assignedBy: human("Ada"),
          assignedAt: 10,
        },
      };
    });
    const { gateway, harness, sidebar } = await mountMutationHarness(
      { request } as unknown as GatewayBrowserClient,
      sessionOwnerProfiles("Ada", "Bob"),
    );
    gateway.publish({
      selfUser: { id: "profile-ada", name: "Ada" },
      hello: gatewayHelloForMethods(["sessions.assignOwner"], ["operator.write"]),
    });
    sidebar.setSessionOwnerFilter(null);
    const result = harness.result;
    const row = harness.row(targetKey);
    row.createdActor = human("Ada");
    row.owner = { actor: row.createdActor };
    result.owners = [human("Ada"), human("Bob")];
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    const menu = await openSessionMenu(sidebar, row.key);
    await waitForFast(() => expect(menu.textContent).toContain("Bob"));
    expect(menuItemLabels(menu)).toContain("Assign to…");
    const assignmentMenu = await openSubmenu(menu, "Assign to…");
    await waitForFast(() =>
      expect(
        Array.from(assignmentMenu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')).map(
          (item) => item.querySelector(".session-menu__text")?.textContent?.trim(),
        ),
      ).toEqual(["Me", "Bob"]),
    );
    for (const [index, label] of ["Bob", "Ada"].entries()) {
      const ownerId = `profile-${label.toLowerCase()}`;
      const currentMenu = index === 0 ? menu : await openSessionMenu(sidebar, row.key);
      if (index > 0) {
        await waitForFast(() => expect(menuItemLabels(currentMenu)).toContain("Assign to…"));
        await openSubmenu(currentMenu, "Assign to…");
      }
      await selectMenuValue(currentMenu, `assign-owner:human:${ownerId}`);
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(index + 1));
      expect(request).toHaveBeenNthCalledWith(index + 1, "sessions.assignOwner", {
        key: row.key,
        agentId: "main",
        owner: { type: "human", id: ownerId },
      });
      await waitForFast(() =>
        expect(sessionQuery(sidebar, row.key, ".session-owner-chip")).toMatchObject({
          title: `Owned by ${label}`,
        }),
      );
    }
  });

  it.each(["active", "provisioning"] as const)(
    "reclaims a %s cloud worker through its session",
    async (state) => {
      const mounted = await cloudWorkerHarness(state);
      const { harness, sidebar, row } = mounted;
      if (state === "active") {
        harness.reconcileMutation.mockResolvedValueOnce({
          status: "failed",
          error: "Stopped session refresh unavailable",
        });
      }
      const menu = await openSessionMenu(sidebar, row.key);
      menu.querySelector<HTMLElement>('[value="stop-cloud-worker"]')?.click();
      const actions = await waitForConfirmDialogActions();
      if (state === "active") {
        expect(document.body.querySelector("openclaw-modal-dialog")?.textContent).toContain(
          'Stop the cloud worker for "a"?',
        );
      }
      answerConfirmDialog(actions, "confirm");
      await expectWorkerReclaimed(mounted);
      if (state === "active") {
        await waitForFast(() =>
          expect(errorText(sidebar)).toContain("Stopped session refresh unavailable"),
        );
      }
    },
  );

  it("shows and dismisses a fixed sidebar error when a session patch is rejected", async () => {
    const { harness, sidebar } = await mountMutationHarness();
    harness.patch.mockRejectedValueOnce(new Error("rename rejected by Gateway"));
    const menu = await openSessionMenu(sidebar, targetKey);
    menu.querySelector<HTMLButtonElement>('[data-shortcut="r"]')?.click();
    await waitForFast(() =>
      expect(document.body.querySelector('input[name="value"]')).toBeInstanceOf(HTMLInputElement),
    );
    document.body.querySelector<HTMLInputElement>('input[name="value"]')!.value = "Rejected rename";
    document.body.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();

    await waitForFast(() => expect(errorText(sidebar)).toContain("rename rejected by Gateway"));
    const error = sidebar.querySelector("[data-sidebar-session-error]");
    expect(error?.parentElement?.classList.contains("sidebar-sessions")).toBe(true);
    expect(error?.closest(".sidebar-recent-sessions")).toBeNull();

    error?.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')?.click();
    await settleLitElement(sidebar);
    expect(sidebar.querySelector("[data-sidebar-session-error]")).toBeNull();
  });

  it.each(["delete", "archive"] as const)(
    "surfaces ordered partial batch-%s errors",
    async (action) => {
      const { harness, sidebar } = await mountMutationHarness();
      if (action === "delete") {
        harness.deleteMany.mockResolvedValueOnce({
          deleted: [targetKey],
          errors: [
            { target: { key: otherKey }, error: new Error("agent:main:b: permission denied") },
          ],
          preservedWorktrees: [],
        });
      } else {
        harness.patchMany.mockImplementationOnce(async (targets) => ({
          outcomes: [
            { ok: true, key: targets[0]!.key, agentId: targets[0]!.agentId },
            {
              ok: false,
              key: targets[1]!.key,
              agentId: targets[1]!.agentId,
              error: { code: "INVALID_REQUEST", message: "active run" },
            },
          ],
        }));
      }
      const menu = await batchMenu(sidebar);
      menu
        .querySelector<HTMLButtonElement>(`[data-shortcut="${action === "delete" ? "d" : "a"}"]`)
        ?.click();
      if (action === "delete") {
        answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
      }
      await waitForFast(() =>
        expect(errorText(sidebar)).toContain(
          `agent:main:b: ${action === "delete" ? "permission denied" : "active run"}`,
        ),
      );
      if (action === "archive") {
        expect(harness.patchMany).toHaveBeenCalledOnce();
        expect(harness.patch).not.toHaveBeenCalled();
        expect(harness.reconcileMutation).toHaveBeenCalledOnce();
      }
    },
  );

  it("suppresses a late rejection after a same-client reconnect", async () => {
    const { gateway, harness, sidebar } = await mountMutationHarness();
    const pending = deferred<ReturnType<typeof successfulSessionPatch>>();
    harness.patch.mockImplementationOnce(() => pending.promise);
    const menu = await openSessionMenu(sidebar, targetKey);
    menu.querySelector<HTMLButtonElement>('[data-shortcut="u"]')?.click();
    await waitForFast(() => expect(harness.patch).toHaveBeenCalledOnce());

    gateway.publish({ phase: "reconnecting" });
    gateway.publish({ phase: "connected" });
    pending.reject(new Error("late old-connection rejection"));
    await pending.promise.catch(() => undefined);
    await Promise.resolve();
    await sidebar.updateComplete;

    expect(sidebar.querySelector("[data-sidebar-session-error]")).toBeNull();
  });

  it("suppresses a late batch archive result after a reconnect", async () => {
    const { gateway, harness, sidebar } = await mountMutationHarness();
    const pending = deferred<Awaited<ReturnType<typeof harness.patchMany>>>();
    harness.patchMany.mockImplementationOnce(() => pending.promise);
    const menu = await batchMenu(sidebar);
    menu?.querySelector<HTMLButtonElement>('[data-shortcut="a"]')?.click();
    await waitForFast(() => expect(harness.patchMany).toHaveBeenCalledOnce());

    gateway.publish({ phase: "reconnecting" });
    gateway.publish({ phase: "connected" });
    pending.resolve(successfulBatch());
    await pending.promise;
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });

    expect(harness.patchMany).toHaveBeenCalledOnce();
    expect(harness.patch).not.toHaveBeenCalled();
  });

  it("does not truncate a pending batch when another mutation starts", async () => {
    const { harness, sidebar } = await mountMutationHarness();
    const toast = await mountToastHost();
    toast.querySelector<HTMLButtonElement>(".app-toast__dismiss")?.click();
    await toast.updateComplete;
    harness.publishList({
      result: sessionResult([
        "agent:main:main",
        targetKey,
        otherKey,
        "agent:main:c",
        "agent:main:d",
      ]),
    });
    await sidebar.updateComplete;
    const archive = deferred<Awaited<ReturnType<typeof harness.patchMany>>>();
    harness.patchMany.mockImplementationOnce(() => archive.promise);
    let menu = await batchMenu(sidebar);
    menu?.querySelector<HTMLButtonElement>('[data-shortcut="a"]')?.click();
    await waitForFast(() => expect(harness.patchMany).toHaveBeenCalledOnce());

    menu = await batchMenu(sidebar, ["c", "d"]);
    menu?.querySelector<HTMLButtonElement>('[data-shortcut="u"]')?.click();
    await waitForFast(() => expect(harness.patchMany).toHaveBeenCalledTimes(2));

    archive.resolve(successfulBatch());
    await archive.promise;
    await waitForFast(() =>
      expect(toast.querySelector(".app-toast__message")?.textContent).toBe("Archived 2 sessions"),
    );
    expect(harness.patchMany).toHaveBeenCalledTimes(2);
    expect(harness.patchMany.mock.calls[1]?.[0].map((target) => target.key)).toEqual([
      "agent:main:c",
      "agent:main:d",
    ]);
    expect(harness.patchMany.mock.calls[1]?.[1]).toEqual({ unread: true });
    expect(harness.patch).not.toHaveBeenCalled();
  });

  it("never force-removes a preserved worktree through a reconnected client", async () => {
    const request = vi.fn(() => Promise.resolve({}));
    const { gateway, harness, sidebar } = await mountMutationHarness({
      request,
    } as unknown as GatewayBrowserClient);
    harness.deleteSession.mockResolvedValueOnce({
      deleted: true,
      worktreePreserved: {
        id: "wt-1",
        branch: "feature",
        path: "/tmp/worktree",
        reason: "busy",
      },
    });
    const menu = await openSessionMenu(sidebar, targetKey);
    await openSubmenu(menu, "Advanced");
    await selectMenuValue(menu, "delete");
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    await waitForFast(() => expect(harness.deleteSession).toHaveBeenCalledOnce());

    // The worktree-removal confirm is open; a reconnect retires the captured
    // client, so accepting it must not force-remove through the new one.
    const worktreeActions = await waitForConfirmDialogActions();
    gateway.publish({ phase: "reconnecting" });
    gateway.publish({ phase: "connected" });
    answerConfirmDialog(worktreeActions, "confirm");

    await waitForFast(() =>
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull(),
    );
    expect(request).not.toHaveBeenCalled();
  });
});
