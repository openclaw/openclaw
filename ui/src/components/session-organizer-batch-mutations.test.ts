/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsPatchMutation } from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { loadSettings, patchSettings } from "../app/settings.ts";
import { t } from "../i18n/index.ts";
import {
  customSnoozeStorageKey,
  readCustomSnooze,
  rememberCustomSnooze,
} from "../lib/sessions/custom-snooze.ts";
import type { SessionDeleteOutcome } from "../lib/sessions/session-capability.ts";
import { showToast } from "../lib/toast.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  installDialogPolyfill,
  waitForConfirmDialogActions,
} from "../test-helpers/modal-dialog.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { sessionMenuReasons } from "./session-menu-access.ts";
import type { SessionMenuAction } from "./session-menu-solid.tsx";
import {
  createHarness as createBaseHarness,
  sessionRow,
  sessionTarget,
} from "./session-organizer-batch-mutations.test-support.ts";
import { patchSessionRows } from "./session-organizer-batch-mutations.ts";
import * as ops from "./session-organizer-operations.runtime.ts";

const modalElement = () => document.body.querySelector("openclaw-modal-dialog");

vi.mock("../lib/toast.ts", () => ({ showToast: vi.fn() }));

describe("patchSessionRows", () => {
  it.each(["connected", "reconnecting"] as const)(
    "preserves queued tree guards while %s",
    async (phase) => {
      const h = createHarness({ phase });
      h.scope.gateway.snapshot.deferredIntentCount = 1;
      const row = sessionRow(1, { archiveGuard: { expectedArchived: false } });
      const result = await h.patchRows([row], { archived: true }, { sessionScope: true });
      expect(h.patch).not.toHaveBeenCalled();
      if (phase === "connected") {
        expect(result).toEqual([row]);
        expect(h.request.mock.calls[0]?.[1]).toMatchObject({
          targets: [{ ...sessionTarget(row), expectedArchived: false }],
        });
      } else {
        expect(result).toBeNull();
        expect(h.request).not.toHaveBeenCalled();
        expect(h.publishSessionMutationError).toHaveBeenCalled();
      }
    },
  );
  it("keeps a personal pin when the archive is rejected", async () => {
    const h = createHarness();
    h.patch.mockRejectedValueOnce(new Error("archive rejected"));
    await expect(
      ops.patchSession(h.host, sessionRow(1), { archived: true }, h.scope),
    ).resolves.toBe("failed");
    expect(h.pruneSidebarSessionEntry).not.toHaveBeenCalled();
  });

  it.each(["move", "create"])("preserves placement/order for %s", async (action) => {
    const h = createHarness();
    const rows = [
      makeRow(0, { pinnable: true, isChild: false }),
      makeRow(1, { pinnable: false, isChild: false }),
      makeRow(2, { key: "agent:main:subagent:hidden", pinnable: false, isChild: false }),
      makeRow(3, { pinnable: true, sidebarRoot: true, isChild: false }),
    ];
    if (action === "create") {
      h.host.knownSessionGroups = () => ["Projects"];
      await expect(ops.createSessionGroup(h.host, "Projects", rows, h.scope)).resolves.toBe(
        "completed",
      );
    } else {
      await h.action({ kind: "move-to-group", category: "Projects" }, rows, false);
    }
    expect(h.request.mock.calls.map(([, params]) => params)).toEqual([
      { targets: [sessionTarget(rows[0]!)], patch: { category: "Projects" } },
      { targets: [sessionTarget(rows[1]!)], patch: { category: "Projects", sidebarRoot: true } },
      { targets: rows.slice(2).map(sessionTarget), patch: { category: "Projects" } },
    ]);
    expect(h.publishSessionMutationError).not.toHaveBeenCalled();
  });

  it("rejects a hidden worker as an archive root", async () => {
    const h = createHarness();
    const root = sessionRow(0, {
      key: "agent:main:subagent:hidden",
      hasArchiveDescendants: true,
    });
    h.scope.sessions.describe = vi.fn(async () => ({
      session: {
        key: root.key,
        sessionId: root.sessionId,
        kind: "direct" as const,
        updatedAt: null,
      },
    }));
    await ops.archiveSessionWithUndo(h.host, root, h.scope);
    expect(h.request).not.toHaveBeenCalled();
    expectError(h, expect.objectContaining({ message: t("sessionsView.archiveTreeRootRequired") }));
  });

  it("binds Mark as read to the current session identity", async () => {
    const row = sessionRow(0);
    const h = createHarness();
    await expect(ops.patchSession(h.host, row, { unread: false }, h.scope)).resolves.toBe(
      "completed",
    );
    expectPatch(h, row, { unread: false });
  });

  it.each(["operator.write", "operator.sessions.write", "operator.admin"])(
    "acknowledges hidden runs with %s",
    async (scope) => {
      const run = makeRow(1, { key: "agent:main:subagent:done", isChild: true });
      const foreign = makeRow(2, { key: "agent:main:subagent:foreign", sharingRole: "member" });
      const parent = sessionRow(0, {
        unread: false,
        subagentSummary: {
          attention: { kind: "none" },
          runningChildCount: 0,
          failedChildCount: 0,
          unreadHiddenRuns: [run, foreign],
        },
      });
      const h = createHarness({ scopes: [scope] });
      expect(menuReason(h, [parent], "toggle-unread")).toBeUndefined();

      await h.action({ kind: "toggle-unread" }, [parent], true);
      await h.action({ kind: "toggle-unread" }, [parent], false);

      // Selected rows keep their explicit batch read; folded runs keep manual markers.
      expect(requestParams(h)).toEqual([
        mutation([parent], { unread: false }),
        mutation([parent], { unread: true }),
      ]);
      expect(h.patch).toHaveBeenCalledExactlyOnceWith(
        run.key,
        { unread: false },
        { agentId: "main", expectedMarkedUnreadAt: null, expectedSessionId: run.sessionId },
      );
      expect(h.publishSessionMutationError).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["foreign selection", true, "operator.sessions.write", "member"],
    ["read-only scope", true, "operator.sessions.read", "owner"],
    ["unavailable method", false, "operator.sessions.write", "owner"],
  ] as const)("denies unread changes for %s", async (_name, advertised, scope, sharingRole) => {
    const h = createHarness({
      methods: advertised ? ["sessions.patch", "sessions.patchMany"] : [],
      scopes: [scope],
    });
    const rows = [sessionRow(0), makeRow(1, { sharingRole })];
    expect(menuReason(h, rows, "toggle-unread")).toBeDefined();
    await h.action({ kind: "toggle-unread" }, rows, false);
    expectNoCalls(h.request, h.patch);
    expect(h.publishSessionMutationError).toHaveBeenCalledOnce();
  });

  it("preflights all identities before dispatch", async () => {
    const h = createHarness();
    const rows = batchRows(101);
    rows[100] = { ...rows[100]!, sessionId: undefined };

    await expect(h.patchRows(rows, { archived: false })).resolves.toBeNull();

    expect(h.request).not.toHaveBeenCalled();
    expectError(h, "Session lifecycle action requires a durable session identity.");
  });

  it.each([false, true])("chunks ordered outcomes (partial=%s)", async (partial) => {
    const guard = partial
      ? { expectedSidebarRoot: false, expectedCategory: null, expectedArchived: false }
      : {};
    const rows = batchRows(101).map((row) =>
      partial ? Object.assign(row, { archiveGuard: guard }) : row,
    );
    const failed = partial ? [rows[0]!, rows[100]!] : [];
    const successful = rows.filter((row) => !failed.includes(row));
    const h = createHarness({ failedKeys: failed.map((row) => row.key) });
    const patch = partial ? { archived: true } : { archived: true, unread: false };
    await expect(h.patchRows(rows, patch)).resolves.toEqual(successful);
    expect(h.request.mock.calls).toEqual(
      [rows.slice(0, 100), rows.slice(100)].map((chunk) => [
        "sessions.patchMany",
        mutation(chunk, patch, guard),
        { timeoutMs: 10 * 60_000 },
      ]),
    );
    expect(h.pruneSidebarSessionEntry.mock.calls.map(([key]) => key)).toEqual(
      successful.map((row) => row.key),
    );
    expect(h.reconcileMutation).toHaveBeenCalledOnce();
    if (partial) {
      expectError(h, failed.map((row) => `${row.key}: failed ${row.key}`).join("; "));
    }
  });

  it.each([
    { current: false, staleAfterRequest: undefined, count: 1, requests: 0 },
    { current: true, staleAfterRequest: 1, count: 101, requests: 1 },
  ])("stops stale scopes after $requests dispatched chunks", async (scenario) => {
    const h = createHarness(scenario);
    const rows = batchRows(scenario.count);
    await expect(h.patchRows(rows, { archived: true })).resolves.toBeNull();
    expect(h.request).toHaveBeenCalledTimes(scenario.requests);
    expect(h.reconcileMutation).not.toHaveBeenCalled();
  });

  it.each([
    ["rejected archive", 1, "invalid archive request"],
    ["later chunk rejection", 2, "unknown method: sessions.patchMany"],
  ] as const)("reports %s and retains completed chunks", async (_name, at, message) => {
    const rejection = new GatewayRequestError({ code: "INVALID_REQUEST", message });
    const h = createHarness({ requestFailure: { at, error: rejection } });
    const rows = batchRows(at === 1 ? 1 : 101);
    const result = await h.patchRows(rows, { archived: true });
    if (at === 1) {
      expect(result).toBeNull();
      expect(h.reconcileMutation).not.toHaveBeenCalled();
    } else {
      expect(result).toEqual(rows.slice(0, 100));
      expect(h.reconcileMutation).toHaveBeenCalledOnce();
    }
    expect(h.request).toHaveBeenCalledTimes(at);
    expectError(h, at === 1 ? rejection : message);
  });

  it.each<[string, Parameters<typeof createHarness>[0], SessionsPatchMutation, string | null]>([
    [
      "disconnected",
      { phase: "stopped" },
      { category: "Projects" },
      "Connect to the Gateway to change sessions.",
    ],
    ["method metadata unavailable", { methods: null }, { archived: true }, null],
    [
      "operator.write missing",
      { scopes: ["operator.read"] },
      { archived: true },
      "This action requires operator.write access.",
    ],
  ])("sends no mutation when %s", async (_name, options, patch, error) => {
    const h = createHarness(options);
    await expect(h.patchRows([sessionRow(0)], patch)).resolves.toBeNull();
    expectNoCalls(h.request, h.reconcileMutation);
    expect(h.publishSessionMutationError).toHaveBeenCalledOnce();
    if (error !== null) {
      expectError(h, error);
    }
  });

  it.each([
    { scope: "operator.sessions.write", archived: true },
    { scope: "operator.sessions.write", archived: false },
    { scope: "operator.write", archived: true },
    { scope: "operator.write", archived: false },
  ])("keeps archive=$archived owner-only with $scope", async ({ scope, archived }) => {
    const h = createHarness({
      scopes: ["operator.read", scope, "operator.questions", "operator.approvals", "operator.talk"],
    });
    const own = makeRow(0, { archived: !archived, sharingRole: "owner" as const });
    const member = makeRow(1, { archived: !archived, sharingRole: "member" as const });
    expect(menuReason(h, [own, member], "toggle-archived")).toBe(
      "Only the session creator or an admin can make this change.",
    );
    await expect(
      h.patchRows([own, member], { archived }, { sessionScope: true }),
    ).resolves.toBeNull();
    expectNoCalls(h.request, h.reconcileMutation);
    expectError(h, "Only the session creator or an admin can make this change.");

    await expect(h.patchRows([own], { archived }, { sessionScope: true })).resolves.toEqual([own]);
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.request.mock.calls[0]?.[1]).toMatchObject({
      targets: [{ key: own.key }],
      patch: { archived },
    });
  });
});

function expectNoCalls(...spies: unknown[]) {
  for (const spy of spies) {
    expect(spy).not.toHaveBeenCalled();
  }
}
function expectError(h: OperationsHarness, error: unknown) {
  expect(h.publishSessionMutationError).toHaveBeenCalledWith(h.scope, error);
}
function expectPatch(
  h: OperationsHarness,
  row: SidebarRecentSession,
  patch: SessionsPatchMutation,
) {
  expect(h.patch).toHaveBeenLastCalledWith(row.key, patch, {
    agentId: "main",
    expectedSessionId: row.sessionId,
  });
}
function expectArchive(h: OperationsHarness, rows: SidebarRecentSession[], archived: boolean) {
  expect(h.request.mock.calls.map(([method]) => method)).toEqual(["sessions.patchMany"]);
  expect(requestParams(h)).toEqual([mutation(rows, { archived })]);
}
const requestParams = (h: OperationsHarness) => h.request.mock.calls.map(([, params]) => params);
const mutation = (rows: SidebarRecentSession[], patch: SessionsPatchMutation, guard = {}) => ({
  targets: rows.map((row) => ({ ...sessionTarget(row), ...guard })),
  patch,
});
function batchRows(count: number) {
  return Array.from({ length: count }, (_, index) => sessionRow(index));
}
async function answer(decision: "confirm" | "cancel" = "confirm") {
  answerConfirmDialog(await waitForConfirmDialogActions(), decision);
}
function preservedWorktree(
  reason: NonNullable<SessionDeleteOutcome["worktreePreserved"]>["reason"],
  id = "wt-1",
  branch = "feature",
  path = "/tmp/worktree",
) {
  return { id, branch, path, reason };
}
type OperationsHarness = ReturnType<typeof createHarness>;
function makeRow(index: number, overrides: Partial<SidebarRecentSession>) {
  return { ...sessionRow(index), ...overrides };
}
function menuReason(
  h: OperationsHarness,
  rows: SidebarRecentSession[],
  action: keyof ReturnType<typeof sessionMenuReasons>,
) {
  return sessionMenuReasons({
    snapshot: h.scope.gateway.snapshot,
    session: rows[0]!,
    batchRows: rows,
  })[action];
}
function createHarness(config?: Parameters<typeof createBaseHarness>[0]) {
  const h = createBaseHarness(config);
  return {
    ...h,
    action: (action: SessionMenuAction, rows: SidebarRecentSession[], unread = false) =>
      ops.runBatchSessionAction(h.host, action, rows, unread, h.scope),
    patchRows: (
      rows: SidebarRecentSession[],
      patch: SessionsPatchMutation,
      options?: Parameters<typeof patchSessionRows>[4],
    ) => patchSessionRows(h.host, rows, patch, h.scope, options),
    snooze: (row: SidebarRecentSession, options: Parameters<typeof ops.snoozeSessionWithUndo>[2]) =>
      ops.snoozeSessionWithUndo(h.host, row, options, h.scope),
    remove: (row = sessionRow(0), options?: Parameters<typeof ops.deleteSession>[3]) =>
      ops.deleteSession(h.host, row, h.scope, options),
  };
}

function worktreeHarness(reason: NonNullable<SessionDeleteOutcome["worktreePreserved"]>["reason"]) {
  const h = createHarness({
    ...destructiveHarness,
    methods: [...destructiveHarness.methods, "worktrees.remove"],
  });
  h.deleteOne.mockResolvedValueOnce({
    deleted: true,
    worktreePreserved: preservedWorktree(reason),
  } as never);
  return h;
}
const destructiveHarness = {
  methods: ["sessions.delete", "sessions.reclaim", "sessions.groups.delete"],
  scopes: ["operator.write", "operator.admin"],
};

function cloudWorkerRow(hasActiveRun: boolean): SidebarRecentSession {
  return makeRow(0, {
    hasActiveRun,
    cloudWorkerStopAction: {
      method: "sessions.reclaim",
      requiredScope: "operator.write",
      blocksActiveRun: true,
    },
  });
}

const destructiveOperations = [
  {
    name: "batch delete",
    run: (h: OperationsHarness) =>
      ops.deleteSessionsBatch(h.host, [sessionRow(0), sessionRow(1)], h.scope),
    mutation: (h: OperationsHarness) => h.deleteMany,
    staleMessage: t("sessionsView.deleteSessionsStale", { count: "2" }),
  },
  {
    name: "session delete",
    run: (h: OperationsHarness) => h.remove(),
    mutation: (h: OperationsHarness) => h.deleteOne,
    staleMessage: t("sessionsView.deleteSessionStale", { session: sessionRow(0).label }),
  },
  {
    name: "cloud worker stop",
    run: (h: OperationsHarness) => ops.stopCloudWorker(h.host, cloudWorkerRow(false), h.scope),
    mutation: (h: OperationsHarness) => h.request,
    staleMessage: t("sessionsView.stopCloudWorkerStale", { session: cloudWorkerRow(false).label }),
  },
  {
    name: "session-group delete",
    run: (h: OperationsHarness) => ops.deleteSessionGroup(h.host, "Group A", h.scope),
    mutation: (h: OperationsHarness) => h.groupsDelete,
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

  it("shows worktree preservation after header unmount", async () => {
    const h = createHarness(destructiveHarness);
    const response = createDeferred<SessionDeleteOutcome>();
    h.deleteOne.mockImplementationOnce(() => response.promise);
    const pending = h.remove();
    await answer();
    await vi.waitFor(() => expect(h.deleteOne).toHaveBeenCalledOnce());
    h.retireScope();
    response.resolve({ deleted: true, worktreePreserved: preservedWorktree("busy", "wt-busy") });
    await pending;
    expect(showToast).toHaveBeenCalledWith({
      message: "Managed Worktrees:\nfeature — live run or cleanup active",
    });
  });

  it("confirms batch deletion and reports partial failure", async () => {
    const h = createHarness(destructiveHarness);
    const rows = [sessionRow(0), sessionRow(1)];
    const retryError = `Session ${rows[0]!.key} changed before deletion. Retry.`;
    h.deleteMany.mockResolvedValueOnce({
      deleted: [rows[1]!.key],
      errors: [{ target: { key: rows[0]!.key }, error: retryError }],
      preservedWorktrees: [
        preservedWorktree("busy", "wt-busy", "openclaw/busy", "/worktrees/busy"),
      ],
    });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);

    const pending = ops.deleteSessionsBatch(h.host, rows, h.scope);
    const actions = await waitForConfirmDialogActions();
    expect(modalElement()?.textContent).toContain("Delete 2 sessions and their transcripts?");
    answerConfirmDialog(actions, "confirm");
    await pending;

    expect(h.deleteMany).toHaveBeenCalledWith(
      rows.map((row) => Object.assign(sessionTarget(row), { deleteTranscript: true })),
    );
    expectError(h, retryError);
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
    expect(modalElement()).toBeNull();
    expect(showToast).toHaveBeenCalledWith({ message: operation.staleMessage });

    // Reconnecting must release the old dialog's lock before the operator retries.
    h.renewScope();
    const reopened = operation.run(h);
    await answer();
    await reopened;
    expect(operation.mutation(h)).toHaveBeenCalledOnce();
  });

  it("does not navigate on a retired worktree prompt", async () => {
    const h = worktreeHarness("cleanup-failed");
    const active = makeRow(0, { active: true });

    const pending = h.remove(active);
    await answer();
    const worktreeActions = await waitForConfirmDialogActions();
    h.retireScope();
    answerConfirmDialog(worktreeActions, "cancel");
    await pending;

    expectNoCalls(h.request, h.replaceCurrentSession);
    expect(showToast).toHaveBeenCalledWith({
      message: "Managed Worktrees:\nfeature — cleanup failed",
    });
  });

  it.each(["snapshot failure", "request rejection"] as const)(
    "reports forced worktree removal %s",
    async (failure) => {
      const h = worktreeHarness("snapshot-failed");
      const rejection = new Error("worktree removal failed");
      if (failure === "snapshot failure") {
        h.request.mockResolvedValueOnce({
          removed: true,
          snapshotError: "nested gitlink",
        } as never);
      } else {
        h.request.mockRejectedValueOnce(rejection);
      }

      const pending = h.remove();
      await answer();
      const worktreeActions = await waitForConfirmDialogActions();
      expect(modalElement()?.textContent).toContain("OpenClaw could not create a safety snapshot");
      answerConfirmDialog(worktreeActions, "confirm");
      await pending;

      expect(h.request).toHaveBeenCalledWith("worktrees.remove", { id: "wt-1", force: true });
      expect(h.publishSessionMutationError).toHaveBeenCalledOnce();
      expectError(h, failure === "snapshot failure" ? "nested gitlink" : rejection);
    },
  );

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
    const pending = h.remove(row, offerSkip ? { offerSkip } : undefined);
    if (confirm) {
      const actions = await waitForConfirmDialogActions();
      if (!offerSkip) {
        expect(document.body.querySelector(".exec-approval-skip")).toBeNull();
      }
      answerConfirmDialog(actions, "confirm");
    } else {
      expect(modalElement()).toBeNull();
    }
    await pending;
    expect(h.deleteOne).toHaveBeenCalledOnce();
    expect(h.deleteOne).toHaveBeenCalledWith(row.key, {
      agentId: "main",
      deleteTranscript: true,
      expectedSessionId: row.sessionId,
    });
  });

  it.each(["cloud worker stop", "preserved worktree removal"])(
    "never offers an opt-out on %s",
    async (operation) => {
      patchSettings({ sessionDeleteConfirm: false });
      const h = worktreeHarness("foreign-lock");
      const pending =
        operation === "cloud worker stop"
          ? ops.stopCloudWorker(h.host, cloudWorkerRow(false), h.scope)
          : h.remove();
      const actions = await waitForConfirmDialogActions();
      expect(document.body.querySelector(".exec-approval-skip")).toBeNull();
      answerConfirmDialog(actions, "cancel");
      await pending;
    },
  );

  it("refreshes the appearance settings view when the operator opts out", async () => {
    const h = createHarness(destructiveHarness);

    const pending = h.remove(sessionRow(0), { offerSkip: true });
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
    expect(h.refreshTheme).toHaveBeenCalledOnce();
    expect(loadSettings().sessionDeleteConfirm).toBe(false);
  });

  it("never opens the stop confirm for a reclaim target with an active run", async () => {
    const h = createHarness(destructiveHarness);

    await ops.stopCloudWorker(h.host, cloudWorkerRow(true), h.scope);

    expect(modalElement()).toBeNull();
    expect(h.request).not.toHaveBeenCalled();
  });
});

describe("session organizer batch archive confirmation", () => {
  it.each([
    { activity: { hasActiveRun: true }, decision: "cancel" },
    { activity: { gatewayHasActiveRun: true }, decision: "confirm" },
    { activity: { hasActiveSubagentRun: true }, decision: "retire" },
  ] as const)("waits for $decision on active work", async ({ activity, decision }) => {
    const modal = createModalDialogTestFixture();
    const h = createHarness();
    const rows = [sessionRow(0), makeRow(1, { ...activity })];
    vi.mocked(showToast).mockClear();
    try {
      const pending = modal.track(h.action({ kind: "toggle-archived" }, rows, false));
      const actions = await waitForConfirmDialogActions();
      expect(document.body.textContent).toContain("This selection contains active work.");
      expectNoCalls(h.beginArchive, h.request);
      if (decision === "retire") {
        h.retireScope();
      } else {
        answerConfirmDialog(actions, decision);
      }
      await pending;
      if (decision === "confirm") {
        expectArchive(h, rows, true);
        expect(h.finishArchive).toHaveBeenCalledTimes(rows.length);
      } else {
        expectNoCalls(h.beginArchive, h.request, h.reconcileMutation, h.pruneSidebarSessionEntry);
        expect(showToast).not.toHaveBeenCalled();
      }
    } finally {
      await modal.cleanup();
    }
  });

  it.each([false, true])("immediately toggles idle archived=%s", async (archived) => {
    const h = createHarness();
    const rows = [sessionRow(0), sessionRow(1)].map((row) =>
      Object.assign(row, { archived, hasActiveRun: true, gatewayHasActiveRun: false }),
    );
    await h.action({ kind: "toggle-archived" }, rows, false);
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    expectArchive(h, rows, !archived);
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
    await h.snooze(row, { snoozedUntil: now + 3_600_000 });
    expectPatch(h, row, { snoozedUntil: now + 3_600_000 });
    const toast = vi.mocked(showToast).mock.calls.at(-1)?.[0];
    expect(toast).toMatchObject({ message: "Snoozed until 10:00 AM", actionLabel: "Undo" });
    expect(toast?.onAction).toBeTypeOf("function");
    toast?.onAction?.();
    expectPatch(h, row, { snoozedUntil: null });
    expect(h.pruneSidebarSessionEntry).not.toHaveBeenCalled();
    h.retireScope();
    toast?.onAction?.();
    expect(h.patch).toHaveBeenCalledTimes(2);
  });

  it("remembers only successful custom snoozes, preserving the slot on presets, failures, and undo", async () => {
    const h = createHarness();
    const storage = createStorageMock();
    vi.stubGlobal("localStorage", storage);
    Object.assign(h.scope.client, {
      gatewayUrl: "wss://snooze.example",
      recoveryScope: "test-account",
    });
    const key = customSnoozeStorageKey("wss://snooze.example", "test-account");
    const until = Date.now() + 86_400_000;
    try {
      rememberCustomSnooze(key, until);
      const error = new Error("denied");
      h.patch.mockRejectedValueOnce(error);
      await h.snooze(sessionRow(1), { snoozedUntil: until + 1000, rememberCustom: true });
      expect(readCustomSnooze(key)).toBe(until);
      expectError(h, error);
      expect(showToast).not.toHaveBeenCalled();
      await h.snooze(sessionRow(1), { snoozedUntil: until + 2000 });
      expect(readCustomSnooze(key)).toBe(until);
      await h.snooze(sessionRow(1), { snoozedUntil: until + 3000, rememberCustom: true });
      expect(readCustomSnooze(key)).toBe(until + 3000);
      vi.mocked(showToast).mock.calls.at(-1)?.[0].onAction?.();
      expect(readCustomSnooze(key)).toBe(until + 3000);
      h.retireScope();
      await h.snooze(sessionRow(1), { snoozedUntil: until + 4000, rememberCustom: true });
      expect(readCustomSnooze(key)).toBe(until + 3000);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
