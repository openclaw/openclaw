/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/index.js";
import type {
  SessionsPatchManyParams,
  SessionsPatchManyResult,
} from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { loadSettings, patchSettings } from "../app/settings.ts";
import { t } from "../i18n/index.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import type {
  SessionDeleteBatchResult,
  SessionDeleteOutcome,
} from "../lib/sessions/session-capability.ts";
import { requestSessionPatchMany } from "../lib/sessions/session-requests.ts";
import { showToast } from "../lib/toast.ts";
import { SESSION_MUTATION_TEST_METHODS } from "../test-helpers/gateway-methods.ts";
import {
  answerConfirmDialog,
  installDialogPolyfill,
  waitForConfirmDialogActions,
} from "../test-helpers/modal-dialog.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import { sessionMenuReasons } from "./session-menu-access.ts";
import { patchSessionRows } from "./session-organizer-batch-mutations.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-controller.ts";
import {
  deleteSession,
  deleteSessionGroup,
  deleteSessionsBatch,
  patchSession,
  stopCloudWorker,
  snoozeSessionWithUndo,
} from "./session-organizer-operations.runtime.ts";

vi.mock("../lib/toast.ts", () => ({ showToast: vi.fn() }));

function sessionRow(index: number): SidebarRecentSession {
  return {
    key: `agent:main:batch-${index}`,
    label: `Batch ${index}`,
    sessionId: `session-${index}`,
    sharingRole: "owner",
    pinned: index === 0 || index === 100,
  } as SidebarRecentSession;
}

function sessionTarget(row: SidebarRecentSession) {
  return { key: row.key, agentId: "main", expectedSessionId: row.sessionId };
}

function createHarness(
  params: {
    methods?: string[] | null;
    capabilities?: string[];
    scopes?: string[];
    current?: boolean;
    staleAfterRequest?: number;
    requestFailure?: { at: number; error: unknown };
    failedKeys?: readonly string[];
    phase?: ApplicationGatewaySnapshot["phase"];
  } = {},
) {
  let current = params.current ?? true;
  let requestCount = 0;
  // Mirrors SessionDataController's own controller: retiring the scope aborts
  // it so a dialog wired to `scope.signal` dismisses itself for real, and
  // renewing stands in for the next `beginSessionMutation()` after a reconnect.
  let abortController = new AbortController();
  const request = vi.fn(async (_method: string, rawParams?: unknown, _options?: unknown) => {
    const patchParams = rawParams as SessionsPatchManyParams;
    const requestFailure = params.requestFailure;
    requestCount += 1;
    if (requestFailure && requestCount === requestFailure.at) {
      throw requestFailure.error;
    }
    const result = {
      outcomes: patchParams.targets.map((target) => {
        if (params.failedKeys?.includes(target.key)) {
          const error = { code: "INVALID_REQUEST" as const, message: `failed ${target.key}` };
          return target.agentId
            ? { ok: false as const, key: target.key, agentId: target.agentId, error }
            : { ok: false as const, key: target.key, error };
        }
        if (target.agentId) {
          return { ok: true as const, key: target.key, agentId: target.agentId };
        }
        return { ok: true as const, key: target.key };
      }),
    } satisfies SessionsPatchManyResult;
    if (requestCount === params.staleAfterRequest) {
      current = false;
    }
    return result;
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot = {
    client,
    phase: params.phase ?? "connected",
    hello: {
      features:
        params.methods === null
          ? {}
          : {
              methods: params.methods ?? [...SESSION_MUTATION_TEST_METHODS],
              capabilities: params.capabilities ?? [
                GATEWAY_SERVER_CAPS.SESSION_UNREAD_ACK_CONTRACT,
              ],
            },
      auth: { role: "operator", scopes: params.scopes ?? ["operator.write"] },
    },
  } as ApplicationGatewaySnapshot;
  const patch = vi.fn(async (key: string) => ({ ok: true, key }));
  const reconcileMutation = vi.fn(async () => ({ status: "refreshed" as const }));
  const refreshTheme = vi.fn();
  const deleteMany = vi.fn(async (): Promise<SessionDeleteBatchResult> => ({
    deleted: [],
    errors: [],
    preservedWorktrees: [],
  }));
  const deleteOne = vi.fn(async () => ({ deleted: true }));
  const groupsDelete = vi.fn(async () => "completed" as const);
  const connection = {};
  const scope = {
    epoch: 1,
    context: {
      agents: { state: { agentsList: null } },
      theme: { refresh: refreshTheme },
      placementStartup: { pause: vi.fn() },
    },
    gateway: { snapshot },
    sessions: {
      captureConnectionScope: () => connection,
      isConnectionScopeCurrent: () => current,
      patch,
      patchMany: (
        targets: SessionsPatchManyParams["targets"],
        patchParams: SessionsPatchManyParams["patch"],
      ) => requestSessionPatchMany(client, { targets, patch: patchParams }),
      reconcileMutation,
      delete: deleteOne,
      deleteMany,
      groupsDelete,
    } as unknown as SessionCapability,
    client,
    selectedAgentId: "main",
    signal: abortController.signal,
  } as unknown as SidebarSessionMutationScope;
  const publishSessionMutationError = vi.fn();
  const pruneSidebarSessionEntry = vi.fn();
  const replaceCurrentSession = vi.fn();
  const host = {
    sessionData: {
      isSessionMutationScopeCurrent: vi.fn(() => current),
      publishSessionMutationError,
      refreshSidebarSessions: vi.fn(),
    },
    sidebarSessionStatusFilter: () => "active",
    pruneSidebarSessionEntry,
    replaceCurrentSession,
  } as unknown as SessionOrganizerControllerHost;
  return {
    deleteMany,
    deleteOne,
    groupsDelete,
    host,
    patch,
    pruneSidebarSessionEntry,
    publishSessionMutationError,
    reconcileMutation,
    refreshTheme,
    replaceCurrentSession,
    request,
    // Stands in for a reconnect or agent switch landing while a confirm is open.
    retireScope: () => {
      current = false;
      abortController.abort();
    },
    // Stands in for the next beginSessionMutation() a reconnect issues.
    renewScope: () => {
      current = true;
      abortController = new AbortController();
      scope.signal = abortController.signal;
    },
    scope,
  };
}

describe("patchSessionRows", () => {
  it("binds Mark as read to the current session identity", async () => {
    const row = sessionRow(0);
    const harness = createHarness();

    await expect(patchSession(harness.host, row, { unread: false }, harness.scope)).resolves.toBe(
      "completed",
    );

    expect(harness.patch).toHaveBeenCalledWith(
      row.key,
      { unread: false },
      { agentId: "main", expectedSessionId: row.sessionId },
    );
  });

  it("preflights every lifecycle identity before dispatching the first chunk", async () => {
    const harness = createHarness();
    const rows = Array.from({ length: 101 }, (_, index) => sessionRow(index));
    rows[100] = { ...rows[100]!, sessionId: undefined };

    await expect(
      patchSessionRows(harness.host, rows, { archived: false }, harness.scope),
    ).resolves.toBeNull();

    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.publishSessionMutationError).toHaveBeenCalledWith(
      harness.scope,
      "Session lifecycle action requires a durable session identity.",
    );
  });

  it("dispatches 101 rows as ordered protocol-sized chunks and refreshes once", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => sessionRow(index));
    const harness = createHarness();

    const archived = await patchSessionRows(
      harness.host,
      rows,
      { archived: true, unread: false },
      harness.scope,
    );

    expect(harness.request).toHaveBeenCalledTimes(2);
    expect(harness.request.mock.calls.map((call) => call[2])).toEqual([
      { timeoutMs: 10 * 60_000 },
      { timeoutMs: 10 * 60_000 },
    ]);
    expect(harness.request.mock.calls.map(([, params]) => params)).toEqual([
      {
        targets: rows.slice(0, 100).map(sessionTarget),
        patch: { archived: true, unread: false },
      },
      {
        targets: [sessionTarget(rows[100]!)],
        patch: { archived: true, unread: false },
      },
    ]);
    expect(archived).toEqual(rows);
    expect(harness.pruneSidebarSessionEntry.mock.calls.map(([key]) => key)).toEqual([
      rows[0]!.key,
      rows[100]!.key,
    ]);
    expect(harness.reconcileMutation).toHaveBeenCalledOnce();
  });

  it.each([
    { patch: { category: "Projects" }, capabilities: undefined },
    { patch: { unread: false }, capabilities: [] },
  ])("preserves captured batch identities for $patch", async ({ patch, capabilities }) => {
    const rows = [sessionRow(0), sessionRow(1)];
    const h = createHarness({ capabilities });
    await patchSessionRows(h.host, rows, patch, h.scope);
    expect(h.request).toHaveBeenCalledWith("sessions.patchMany", {
      targets: rows.map(sessionTarget),
      patch,
    });
  });

  it.each([
    { current: false, staleAfterRequest: undefined, count: 1, requests: 0 },
    { current: true, staleAfterRequest: 1, count: 101, requests: 1 },
  ])("stops stale scopes after $requests dispatched chunks", async (scenario) => {
    const h = createHarness(scenario);
    const rows = Array.from({ length: scenario.count }, (_, index) => sessionRow(index));
    await expect(patchSessionRows(h.host, rows, { archived: true }, h.scope)).resolves.toBeNull();
    expect(h.request).toHaveBeenCalledTimes(scenario.requests);
    expect(h.reconcileMutation).not.toHaveBeenCalled();
  });

  it("keeps ordered partial outcomes and prunes only successful archived rows", async () => {
    const rows = [sessionRow(0), sessionRow(1), sessionRow(2)];
    const harness = createHarness({ failedKeys: [rows[0]!.key, rows[2]!.key] });

    await expect(
      patchSessionRows(harness.host, rows, { archived: true }, harness.scope),
    ).resolves.toEqual([rows[1]]);

    expect(harness.pruneSidebarSessionEntry).not.toHaveBeenCalled();
    expect(harness.publishSessionMutationError).toHaveBeenCalledWith(
      harness.scope,
      `${rows[0]!.key}: failed ${rows[0]!.key}; ${rows[2]!.key}: failed ${rows[2]!.key}`,
    );
    expect(harness.reconcileMutation).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "rejected archive",
      patch: { archived: true },
      at: 1,
      code: "INVALID_REQUEST",
      message: "invalid archive request",
    },
    {
      name: "transport unavailability",
      patch: { unread: true },
      at: 1,
      code: "UNAVAILABLE",
      message: "disconnected",
    },
    {
      name: "later chunk rejection",
      patch: { archived: true },
      at: 2,
      code: "INVALID_REQUEST",
      message: "unknown method: sessions.patchMany",
    },
  ])("reports $name and retains completed chunks", async ({ patch, at, code, message }) => {
    const rejection = new GatewayRequestError({ code, message });
    const h = createHarness({ requestFailure: { at, error: rejection } });
    const rows = Array.from({ length: at === 1 ? 1 : 101 }, (_, index) => sessionRow(index));
    const result = await patchSessionRows(h.host, rows, patch, h.scope);
    if (at === 1) {
      expect(result).toBeNull();
      expect(h.reconcileMutation).not.toHaveBeenCalled();
    } else {
      expect(result).toEqual(rows.slice(0, 100));
      expect(h.reconcileMutation).toHaveBeenCalledOnce();
    }
    expect(h.request).toHaveBeenCalledTimes(at);
    expect(h.publishSessionMutationError).toHaveBeenCalledWith(
      h.scope,
      at === 1 ? rejection : message,
    );
  });

  it.each([
    {
      name: "disconnected",
      harness: { phase: "stopped" as const },
      patch: { category: "Projects" },
      error: "Connect to the Gateway to change sessions.",
    },
    {
      name: "method metadata unavailable",
      harness: { methods: null },
      patch: { archived: true },
      error: null,
    },
    {
      name: "operator.write missing",
      harness: { scopes: ["operator.read"] },
      patch: { archived: true },
      error: "This action requires operator.write access.",
    },
  ])("sends no mutation when $name", async ({ harness, patch, error }) => {
    const h = createHarness(harness);
    await expect(patchSessionRows(h.host, [sessionRow(0)], patch, h.scope)).resolves.toBeNull();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.reconcileMutation).not.toHaveBeenCalled();
    expect(h.publishSessionMutationError).toHaveBeenCalledOnce();
    if (error !== null) {
      expect(h.publishSessionMutationError).toHaveBeenCalledWith(h.scope, error);
    }
  });

  it.each([
    { scope: "operator.sessions.write", archived: true },
    { scope: "operator.sessions.write", archived: false },
    { scope: "operator.write", archived: true },
    { scope: "operator.write", archived: false },
  ])("keeps archive=$archived owner-only with $scope", async ({ scope, archived }) => {
    const harness = createHarness({
      scopes: ["operator.read", scope, "operator.questions", "operator.approvals", "operator.talk"],
    });
    const own = { ...sessionRow(0), archived: !archived, sharingRole: "owner" as const };
    const member = { ...sessionRow(1), archived: !archived, sharingRole: "member" as const };
    expect(
      sessionMenuReasons({
        snapshot: harness.scope.gateway.snapshot,
        session: own,
        batchRows: [own, member],
      })["toggle-archived"],
    ).toBe("Only the session creator or an admin can make this change.");
    await expect(
      patchSessionRows(harness.host, [own, member], { archived }, harness.scope, {
        sessionScope: true,
      }),
    ).resolves.toBeNull();
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.reconcileMutation).not.toHaveBeenCalled();
    expect(harness.publishSessionMutationError).toHaveBeenCalledWith(
      harness.scope,
      "Only the session creator or an admin can make this change.",
    );

    await expect(
      patchSessionRows(harness.host, [own], { archived }, harness.scope, {
        sessionScope: true,
      }),
    ).resolves.toEqual([own]);
    expect(harness.request).toHaveBeenCalledOnce();
    expect(harness.request.mock.calls[0]?.[1]).toMatchObject({
      targets: [{ key: own.key }],
      patch: { archived },
    });
  });
});

type OperationsHarness = ReturnType<typeof createHarness>;

const destructiveHarness = {
  methods: ["sessions.delete", "sessions.reclaim", "sessions.groups.delete"],
  scopes: ["operator.write", "operator.admin"],
};

function cloudWorkerRow(hasActiveRun: boolean): SidebarRecentSession {
  return {
    ...sessionRow(0),
    hasActiveRun,
    cloudWorkerStopAction: {
      method: "sessions.reclaim",
      requiredScope: "operator.write",
      blocksActiveRun: true,
    },
  } as SidebarRecentSession;
}

const destructiveOperations = [
  {
    name: "batch delete",
    run: (harness: OperationsHarness) =>
      deleteSessionsBatch(harness.host, [sessionRow(0), sessionRow(1)], harness.scope),
    mutation: (harness: OperationsHarness) => harness.deleteMany,
    staleMessage: t("sessionsView.deleteSessionsStale", { count: "2" }),
  },
  {
    name: "session delete",
    run: (harness: OperationsHarness) => deleteSession(harness.host, sessionRow(0), harness.scope),
    mutation: (harness: OperationsHarness) => harness.deleteOne,
    staleMessage: t("sessionsView.deleteSessionStale", { session: sessionRow(0).label }),
  },
  {
    name: "cloud worker stop",
    run: (harness: OperationsHarness) =>
      stopCloudWorker(harness.host, cloudWorkerRow(false), harness.scope),
    mutation: (harness: OperationsHarness) => harness.request,
    staleMessage: t("sessionsView.stopCloudWorkerStale", { session: cloudWorkerRow(false).label }),
  },
  {
    name: "session-group delete",
    run: (harness: OperationsHarness) => deleteSessionGroup(harness.host, "Group A", harness.scope),
    mutation: (harness: OperationsHarness) => harness.groupsDelete,
    staleMessage: t("sessionsView.deleteGroupStale", { group: "Group A" }),
  },
] as const;

describe("session organizer destructive confirmations", () => {
  let restoreDialogPolyfill: () => void;

  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
    vi.mocked(showToast).mockClear();
  });

  afterEach(() => {
    patchSettings({ sessionDeleteConfirm: true });
    document.body.replaceChildren();
    restoreDialogPolyfill();
  });

  it("keeps a preservation notice when optimistic navigation unmounts the initiating header", async () => {
    const harness = createHarness(destructiveHarness);
    const response = createDeferred<SessionDeleteOutcome>();
    harness.deleteOne.mockImplementationOnce(() => response.promise);
    const pending = deleteSession(harness.host, sessionRow(0), harness.scope);
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    await vi.waitFor(() => expect(harness.deleteOne).toHaveBeenCalledOnce());
    harness.retireScope();
    response.resolve({
      deleted: true,
      worktreePreserved: {
        id: "wt-busy",
        branch: "feature",
        path: "/tmp/worktree",
        reason: "busy",
      },
    });
    await pending;
    expect(showToast).toHaveBeenCalledWith({
      message: "Managed Worktrees:\nfeature — live run or cleanup active",
    });
  });

  it("renders the localized batch-delete copy in-app and deletes once accepted", async () => {
    const harness = createHarness(destructiveHarness);
    const rows = [sessionRow(0), sessionRow(1)];
    const retryError = `Session ${rows[0]!.key} changed before deletion. Retry.`;
    harness.deleteMany.mockResolvedValueOnce({
      deleted: [rows[1]!.key],
      errors: [{ target: { key: rows[0]!.key }, error: retryError }],
      preservedWorktrees: [
        {
          id: "wt-busy",
          branch: "openclaw/busy",
          path: "/worktrees/busy",
          reason: "busy",
        },
      ],
    });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);

    const pending = deleteSessionsBatch(harness.host, rows, harness.scope);
    const actions = await waitForConfirmDialogActions();
    expect(document.body.querySelector("openclaw-modal-dialog")?.textContent).toContain(
      "Delete 2 sessions and their transcripts?",
    );
    answerConfirmDialog(actions, "confirm");
    await pending;

    expect(harness.deleteMany).toHaveBeenCalledWith(
      rows.map((row) => ({
        key: row.key,
        agentId: "main",
        expectedSessionId: row.sessionId,
        deleteTranscript: true,
      })),
    );
    expect(harness.publishSessionMutationError).toHaveBeenCalledWith(harness.scope, retryError);
    expect(alertSpy).toHaveBeenCalledWith(
      "Managed Worktrees:\nopenclaw/busy — live run or cleanup active",
    );
    alertSpy.mockRestore();
  });

  it.each(
    destructiveOperations.flatMap((operation) =>
      [false, true].map((retired) => ({ operation, retired })),
    ),
  )("cancels $operation.name safely (retired=$retired)", async ({ operation, retired }) => {
    const h = createHarness(destructiveHarness);
    const pending = operation.run(h);
    const actions = await waitForConfirmDialogActions();
    if (retired) {
      h.retireScope();
    } else {
      answerConfirmDialog(actions, "cancel");
    }
    await pending;
    expect(operation.mutation(h)).not.toHaveBeenCalled();
    if (!retired) {
      expect(h.publishSessionMutationError).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalled();
      return;
    }
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(showToast).toHaveBeenCalledWith({ message: operation.staleMessage });

    // Reconnecting must release the old dialog's lock before the operator retries.
    h.renewScope();
    const reopened = operation.run(h);
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    await reopened;
    expect(operation.mutation(h)).toHaveBeenCalledOnce();
  });

  it("keeps a retired scope from navigating when the worktree prompt is cancelled", async () => {
    const harness = createHarness({
      ...destructiveHarness,
      methods: [...destructiveHarness.methods, "worktrees.remove"],
    });
    harness.deleteOne.mockResolvedValueOnce({
      deleted: true,
      worktreePreserved: {
        id: "wt-1",
        branch: "feature",
        path: "/tmp/worktree",
        reason: "cleanup-failed",
      },
    } as never);
    const active = { ...sessionRow(0), active: true } as SidebarRecentSession;

    const pending = deleteSession(harness.host, active, harness.scope);
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    const worktreeActions = await waitForConfirmDialogActions();
    harness.retireScope();
    answerConfirmDialog(worktreeActions, "cancel");
    await pending;

    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.replaceCurrentSession).not.toHaveBeenCalled();
    // The session delete already landed; the worktree just stays put, same as
    // the no-access branch, so the operator learns where it went.
    expect(showToast).toHaveBeenCalledWith({
      message: "Managed Worktrees:\nfeature — cleanup failed",
    });
  });

  it("surfaces a forced worktree removal that could not create a snapshot", async () => {
    const harness = createHarness({
      ...destructiveHarness,
      methods: [...destructiveHarness.methods, "worktrees.remove"],
    });
    harness.deleteOne.mockResolvedValueOnce({
      deleted: true,
      worktreePreserved: {
        id: "wt-1",
        branch: "feature",
        path: "/tmp/worktree",
        reason: "snapshot-failed",
      },
    } as never);
    harness.request.mockResolvedValueOnce({
      removed: true,
      snapshotError: "nested gitlink",
    } as never);

    const pending = deleteSession(harness.host, sessionRow(0), harness.scope);
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    const worktreeActions = await waitForConfirmDialogActions();
    expect(document.body.querySelector("openclaw-modal-dialog")?.textContent).toContain(
      "OpenClaw could not create a safety snapshot",
    );
    answerConfirmDialog(worktreeActions, "confirm");
    await pending;

    expect(harness.request).toHaveBeenCalledWith("worktrees.remove", {
      id: "wt-1",
      force: true,
    });
    expect(harness.publishSessionMutationError).toHaveBeenCalledWith(
      harness.scope,
      "nested gitlink",
    );
  });

  it.each([
    { name: "sidebar opt-out", offerSkip: true, reset: false, confirm: false },
    { name: "reset preference", offerSkip: true, reset: true, confirm: true },
    { name: "non-sidebar caller", offerSkip: false, reset: false, confirm: true },
  ])("honors the delete confirmation's $name", async ({ offerSkip, reset, confirm }) => {
    patchSettings({ sessionDeleteConfirm: false });
    if (reset) {
      patchSettings({ sessionDeleteConfirm: true });
    }
    const h = createHarness(destructiveHarness);
    const row = sessionRow(0);
    const pending = deleteSession(h.host, row, h.scope, offerSkip ? { offerSkip } : undefined);
    if (confirm) {
      const actions = await waitForConfirmDialogActions();
      if (!offerSkip) {
        expect(document.body.querySelector(".exec-approval-skip")).toBeNull();
      }
      answerConfirmDialog(actions, "confirm");
    } else {
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    }
    await pending;
    expect(h.deleteOne).toHaveBeenCalledOnce();
    expect(h.deleteOne).toHaveBeenCalledWith(row.key, {
      agentId: "main",
      deleteTranscript: true,
      expectedSessionId: row.sessionId,
    });
  });

  it.each([
    {
      name: "cloud worker stop",
      run: (harness: OperationsHarness) =>
        stopCloudWorker(harness.host, cloudWorkerRow(false), harness.scope),
    },
    {
      name: "preserved worktree removal",
      run: (harness: OperationsHarness) => {
        harness.deleteOne.mockResolvedValueOnce({
          deleted: true,
          worktreePreserved: {
            id: "wt-1",
            branch: "feature",
            path: "/tmp/worktree",
            reason: "foreign-lock",
          },
        } as never);
        return deleteSession(harness.host, sessionRow(0), harness.scope);
      },
    },
  ])("never offers an opt-out on the $name confirm", async (operation) => {
    // Opting out of session deletes must not leak into the serious confirms.
    patchSettings({ sessionDeleteConfirm: false });
    const harness = createHarness({
      ...destructiveHarness,
      methods: [...destructiveHarness.methods, "worktrees.remove"],
    });

    const pending = operation.run(harness);
    const actions = await waitForConfirmDialogActions();
    expect(document.body.querySelector(".exec-approval-skip")).toBeNull();
    answerConfirmDialog(actions, "cancel");
    await pending;
  });

  it("refreshes the appearance settings view when the operator opts out", async () => {
    const harness = createHarness(destructiveHarness);

    const pending = deleteSession(harness.host, sessionRow(0), harness.scope, {
      offerSkip: true,
    });
    const actions = await waitForConfirmDialogActions();
    const skip = actions
      .closest("openclaw-modal-dialog")
      ?.querySelector<HTMLInputElement>('.exec-approval-skip input[type="checkbox"]');
    if (!skip) {
      throw new Error("expected the skip checkbox");
    }
    skip.checked = true;
    skip.dispatchEvent(new Event("change"));
    answerConfirmDialog(actions, "confirm");
    await pending;

    // A mounted Settings -> Appearance only rereads settings on this signal.
    expect(harness.refreshTheme).toHaveBeenCalledOnce();
    expect(loadSettings().sessionDeleteConfirm).toBe(false);
  });

  it("never opens the stop confirm for a reclaim target with an active run", async () => {
    const harness = createHarness(destructiveHarness);

    await stopCloudWorker(harness.host, cloudWorkerRow(true), harness.scope);

    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(harness.request).not.toHaveBeenCalled();
  });
});

describe("session organizer snooze", () => {
  beforeEach(() => vi.mocked(showToast).mockClear());
  afterEach(() => vi.useRealTimers());

  it("snoozes the captured session and offers a scoped wake through Undo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date(2026, 8, 29, 9).getTime();
    vi.setSystemTime(now);
    const h = createHarness();
    const row = sessionRow(0);
    await snoozeSessionWithUndo(h.host, row, now + 3_600_000, h.scope);
    expect(h.patch).toHaveBeenCalledWith(
      row.key,
      { snoozedUntil: now + 3_600_000 },
      {
        agentId: "main",
        expectedSessionId: row.sessionId,
      },
    );
    const toast = vi.mocked(showToast).mock.calls.at(-1)?.[0];
    expect(toast).toMatchObject({ message: "Snoozed until 10:00 AM", actionLabel: "Undo" });
    expect(toast?.onAction).toBeTypeOf("function");
    toast?.onAction?.();
    expect(h.patch).toHaveBeenLastCalledWith(
      row.key,
      { snoozedUntil: null },
      {
        agentId: "main",
        expectedSessionId: row.sessionId,
      },
    );
    expect(h.pruneSidebarSessionEntry).not.toHaveBeenCalled();
    h.retireScope();
    toast?.onAction?.();
    expect(h.patch).toHaveBeenCalledTimes(2);
  });

  it("reports a rejected snooze through the ordinary session mutation error path", async () => {
    const h = createHarness();
    const error = new Error("snooze wake time must be in the future");
    h.patch.mockRejectedValueOnce(error);
    await snoozeSessionWithUndo(h.host, sessionRow(0), 200, h.scope);
    expect(h.publishSessionMutationError).toHaveBeenCalledWith(h.scope, error);
    expect(showToast).not.toHaveBeenCalled();
  });
});
