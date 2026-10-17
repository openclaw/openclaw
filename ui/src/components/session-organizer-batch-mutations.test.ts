/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  createHarness,
  sessionRow,
  sessionTarget,
} from "./session-organizer-batch-mutations.test-support.ts";
import { patchSessionRows } from "./session-organizer-batch-mutations.ts";
import {
  archiveSessionWithUndo,
  createSessionGroup,
  deleteSession,
  deleteSessionGroup,
  deleteSessionsBatch,
  patchSession,
  runBatchSessionAction,
  stopCloudWorker,
  snoozeSessionWithUndo,
} from "./session-organizer-operations.runtime.ts";

vi.mock("../lib/toast.ts", () => ({ showToast: vi.fn() }));

describe("patchSessionRows", () => {
  it.each(["move", "create"])(
    "preserves mixed group placement and target order for %s",
    async (action) => {
      const h = createHarness();
      const rows = [
        { ...sessionRow(0), pinnable: true, isChild: false },
        { ...sessionRow(1), pinnable: false, isChild: false },
        { ...sessionRow(2), key: "agent:main:subagent:hidden", pinnable: false, isChild: false },
        { ...sessionRow(3), pinnable: true, sidebarRoot: true, isChild: false },
      ];
      if (action === "create") {
        h.host.knownSessionGroups = () => ["Projects"];
        await expect(createSessionGroup(h.host, "Projects", rows, h.scope)).resolves.toBe(
          "completed",
        );
      } else {
        await runAction(h, { kind: "move-to-group", category: "Projects" }, rows, false);
      }
      expect(h.request.mock.calls.map(([, params]) => params)).toEqual([
        { targets: [sessionTarget(rows[0]!)], patch: { category: "Projects" } },
        { targets: [sessionTarget(rows[1]!)], patch: { category: "Projects", sidebarRoot: true } },
        { targets: rows.slice(2).map(sessionTarget), patch: { category: "Projects" } },
      ]);
      expect(h.publishSessionMutationError).not.toHaveBeenCalled();
    },
  );

  it("rejects a hidden worker as a tree root before reading or changing descendants", async () => {
    const h = createHarness();
    const root = {
      ...sessionRow(0),
      key: "agent:main:subagent:hidden",
      hasArchiveDescendants: true,
    };
    h.scope.sessions.describe = vi.fn(async () => ({
      session: {
        key: root.key,
        sessionId: root.sessionId,
        kind: "direct" as const,
        updatedAt: null,
      },
    }));
    await archiveSessionWithUndo(h.host, root, h.scope);
    expect(h.request).not.toHaveBeenCalled();
    expectError(h, expect.objectContaining({ message: t("sessionsView.archiveTreeRootRequired") }));
  });

  it("binds Mark as read to the current session identity", async () => {
    const row = sessionRow(0);
    const h = createHarness();

    await expect(patchSession(h.host, row, { unread: false }, h.scope)).resolves.toBe("completed");

    expect(h.patch).toHaveBeenCalledWith(
      row.key,
      { unread: false },
      { agentId: "main", expectedSessionId: row.sessionId },
    );
  });

  it.each(["operator.write", "operator.sessions.write", "operator.admin"])(
    "acknowledges hidden runs conditionally with %s",
    async (scope) => {
      const run = { ...sessionRow(1), key: "agent:main:subagent:done", isChild: true };
      const parent: SidebarRecentSession = {
        ...sessionRow(0),
        unread: false,
        subagentSummary: {
          attention: { kind: "none" },
          runningChildCount: 0,
          failedChildCount: 0,
          unreadHiddenRuns: [run],
        },
      };
      const h = createHarness({ scopes: [scope] });
      expect(
        sessionMenuReasons({ snapshot: h.scope.gateway.snapshot, session: parent })[
          "toggle-unread"
        ],
      ).toBeUndefined();

      await runAction(h, { kind: "toggle-unread" }, [parent], true);
      await runAction(h, { kind: "toggle-unread" }, [parent], false);

      // Selected rows keep their explicit batch read; folded runs keep manual markers.
      expect(h.request.mock.calls.map(([, params]) => params)).toEqual([
        { targets: [sessionTarget(parent)], patch: { unread: false } },
        { targets: [sessionTarget(parent)], patch: { unread: true } },
      ]);
      expect(h.patch.mock.calls).toEqual([
        [
          run.key,
          { unread: false },
          { agentId: "main", expectedMarkedUnreadAt: null, expectedSessionId: run.sessionId },
        ],
      ]);
    },
  );

  it.each([
    {
      name: "foreign selection",
      methods: ["sessions.patch", "sessions.patchMany"],
      scopes: ["operator.sessions.write"],
      sharingRole: "member" as const,
    },
    {
      name: "read-only scope",
      methods: ["sessions.patch", "sessions.patchMany"],
      scopes: ["operator.sessions.read"],
      sharingRole: "owner" as const,
    },
    {
      name: "unavailable method",
      methods: [],
      scopes: ["operator.sessions.write"],
      sharingRole: "owner" as const,
    },
  ])("denies unread changes for $name", async ({ methods, scopes, sharingRole }) => {
    const h = createHarness({ methods, scopes });
    const rows = [sessionRow(0), { ...sessionRow(1), sharingRole }];
    expect(
      sessionMenuReasons({
        snapshot: h.scope.gateway.snapshot,
        session: rows[0]!,
        batchRows: rows,
      })["toggle-unread"],
    ).toBeDefined();
    await runAction(h, { kind: "toggle-unread" }, rows, false);
    expectNoCalls(h.request, h.patch);
    expect(h.publishSessionMutationError).toHaveBeenCalledOnce();
  });

  it("leaves foreign hidden runs unread when an owner marks the parent read", async () => {
    const run = {
      ...sessionRow(1),
      key: "agent:main:subagent:foreign",
      sharingRole: "member" as const,
    };
    const parent = {
      ...sessionRow(0),
      subagentSummary: {
        attention: { kind: "none" as const },
        runningChildCount: 0,
        failedChildCount: 0,
        unreadHiddenRuns: [run],
      },
    };
    const h = createHarness({ scopes: ["operator.sessions.write"] });
    await runAction(h, { kind: "toggle-unread" }, [parent], true);
    expect(h.request).toHaveBeenCalledOnce();
    expectNoCalls(h.patch, h.publishSessionMutationError);
  });

  it("preflights every lifecycle identity before dispatching the first chunk", async () => {
    const h = createHarness();
    const rows = Array.from({ length: 101 }, (_, index) => sessionRow(index));
    rows[100] = { ...rows[100]!, sessionId: undefined };

    await expect(patchRows(h, rows, { archived: false })).resolves.toBeNull();

    expect(h.request).not.toHaveBeenCalled();
    expectError(h, "Session lifecycle action requires a durable session identity.");
  });

  it("dispatches 101 rows as ordered protocol-sized chunks and refreshes once", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => sessionRow(index));
    const h = createHarness();

    const archived = await patchRows(h, rows, { archived: true, unread: false });

    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.request.mock.calls.map((call) => call[2])).toEqual([
      { timeoutMs: 10 * 60_000 },
      { timeoutMs: 10 * 60_000 },
    ]);
    expect(h.request.mock.calls.map(([, params]) => params)).toEqual([
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
    expect(h.pruneSidebarSessionEntry.mock.calls.map(([key]) => key)).toEqual([
      rows[0]!.key,
      rows[100]!.key,
    ]);
    expect(h.reconcileMutation).toHaveBeenCalledOnce();
  });

  it.each([
    { current: false, staleAfterRequest: undefined, count: 1, requests: 0 },
    { current: true, staleAfterRequest: 1, count: 101, requests: 1 },
  ])("stops stale scopes after $requests dispatched chunks", async (scenario) => {
    const h = createHarness(scenario);
    const rows = Array.from({ length: scenario.count }, (_, index) => sessionRow(index));
    await expect(patchRows(h, rows, { archived: true })).resolves.toBeNull();
    expect(h.request).toHaveBeenCalledTimes(scenario.requests);
    expect(h.reconcileMutation).not.toHaveBeenCalled();
  });

  it("keeps ordered partial outcomes and prunes only successful archived rows", async () => {
    const rows = [sessionRow(0), sessionRow(1), sessionRow(2)].map((row) =>
      Object.assign(row, {
        archiveGuard: {
          expectedSidebarRoot: false,
          expectedCategory: null,
          expectedArchived: false,
        },
      }),
    );
    const h = createHarness({ failedKeys: [rows[0]!.key, rows[2]!.key] });

    await expect(patchRows(h, rows, { archived: true })).resolves.toEqual([rows[1]]);

    expect(h.request).toHaveBeenCalledWith(
      "sessions.patchMany",
      expect.objectContaining({
        targets: rows.map((row) => Object.assign(sessionTarget(row), row.archiveGuard)),
        patch: { archived: true },
      }),
      expect.anything(),
    );
    expect(h.pruneSidebarSessionEntry).not.toHaveBeenCalled();
    expectError(
      h,
      `${rows[0]!.key}: failed ${rows[0]!.key}; ${rows[2]!.key}: failed ${rows[2]!.key}`,
    );
    expect(h.reconcileMutation).toHaveBeenCalledOnce();
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
    const result = await patchRows(h, rows, patch);
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
  ])("sends no mutation when $name", async ({ harness: options, patch, error }) => {
    const h = createHarness(options);
    await expect(patchRows(h, [sessionRow(0)], patch)).resolves.toBeNull();
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
    const own = { ...sessionRow(0), archived: !archived, sharingRole: "owner" as const };
    const member = { ...sessionRow(1), archived: !archived, sharingRole: "member" as const };
    expect(
      sessionMenuReasons({
        snapshot: h.scope.gateway.snapshot,
        session: own,
        batchRows: [own, member],
      })["toggle-archived"],
    ).toBe("Only the session creator or an admin can make this change.");
    await expect(
      patchRows(h, [own, member], { archived }, { sessionScope: true }),
    ).resolves.toBeNull();
    expectNoCalls(h.request, h.reconcileMutation);
    expectError(h, "Only the session creator or an admin can make this change.");

    await expect(patchRows(h, [own], { archived }, { sessionScope: true })).resolves.toEqual([own]);
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
function preservedWorktree(
  reason: NonNullable<SessionDeleteOutcome["worktreePreserved"]>["reason"],
  id = "wt-1",
  branch = "feature",
  path = "/tmp/worktree",
) {
  return { id, branch, path, reason };
}
type OperationsHarness = ReturnType<typeof createHarness>;
function runAction(
  h: OperationsHarness,
  action: Parameters<typeof runBatchSessionAction>[1],
  rows: Parameters<typeof runBatchSessionAction>[2],
  unread: boolean,
) {
  return runBatchSessionAction(h.host, action, rows, unread, h.scope);
}
function patchRows(
  h: OperationsHarness,
  rows: Parameters<typeof patchSessionRows>[1],
  patch: Parameters<typeof patchSessionRows>[2],
  options?: Parameters<typeof patchSessionRows>[4],
) {
  return patchSessionRows(h.host, rows, patch, h.scope, options);
}
function snooze(
  h: OperationsHarness,
  row: Parameters<typeof snoozeSessionWithUndo>[1],
  options: Parameters<typeof snoozeSessionWithUndo>[2],
) {
  return snoozeSessionWithUndo(h.host, row, options, h.scope);
}
function removeSession(
  h: OperationsHarness,
  row = sessionRow(0),
  options?: Parameters<typeof deleteSession>[3],
) {
  return deleteSession(h.host, row, h.scope, options);
}

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
    run: (h: OperationsHarness) =>
      deleteSessionsBatch(h.host, [sessionRow(0), sessionRow(1)], h.scope),
    mutation: (h: OperationsHarness) => h.deleteMany,
    staleMessage: t("sessionsView.deleteSessionsStale", { count: "2" }),
  },
  {
    name: "session delete",
    run: (h: OperationsHarness) => removeSession(h, sessionRow(0)),
    mutation: (h: OperationsHarness) => h.deleteOne,
    staleMessage: t("sessionsView.deleteSessionStale", { session: sessionRow(0).label }),
  },
  {
    name: "cloud worker stop",
    run: (h: OperationsHarness) => stopCloudWorker(h.host, cloudWorkerRow(false), h.scope),
    mutation: (h: OperationsHarness) => h.request,
    staleMessage: t("sessionsView.stopCloudWorkerStale", { session: cloudWorkerRow(false).label }),
  },
  {
    name: "session-group delete",
    run: (h: OperationsHarness) => deleteSessionGroup(h.host, "Group A", h.scope),
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

  it("keeps a preservation notice when optimistic navigation unmounts the initiating header", async () => {
    const h = createHarness(destructiveHarness);
    const response = createDeferred<SessionDeleteOutcome>();
    h.deleteOne.mockImplementationOnce(() => response.promise);
    const pending = removeSession(h, sessionRow(0));
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    await vi.waitFor(() => expect(h.deleteOne).toHaveBeenCalledOnce());
    h.retireScope();
    response.resolve({
      deleted: true,
      worktreePreserved: preservedWorktree("busy", "wt-busy"),
    });
    await pending;
    expect(showToast).toHaveBeenCalledWith({
      message: "Managed Worktrees:\nfeature — live run or cleanup active",
    });
  });

  it("renders the localized batch-delete copy in-app and deletes once accepted", async () => {
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

    const pending = deleteSessionsBatch(h.host, rows, h.scope);
    const actions = await waitForConfirmDialogActions();
    expect(document.body.querySelector("openclaw-modal-dialog")?.textContent).toContain(
      "Delete 2 sessions and their transcripts?",
    );
    answerConfirmDialog(actions, "confirm");
    await pending;

    expect(h.deleteMany).toHaveBeenCalledWith(
      rows.map((row) => ({
        key: row.key,
        agentId: "main",
        expectedSessionId: row.sessionId,
        deleteTranscript: true,
      })),
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
    const h = createHarness({
      ...destructiveHarness,
      methods: [...destructiveHarness.methods, "worktrees.remove"],
    });
    h.deleteOne.mockResolvedValueOnce({
      deleted: true,
      worktreePreserved: preservedWorktree("cleanup-failed"),
    } as never);
    const active = { ...sessionRow(0), active: true } as SidebarRecentSession;

    const pending = removeSession(h, active);
    answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
    const worktreeActions = await waitForConfirmDialogActions();
    h.retireScope();
    answerConfirmDialog(worktreeActions, "cancel");
    await pending;

    expectNoCalls(h.request, h.replaceCurrentSession);
    // The session delete already landed; the worktree just stays put, same as
    // the no-access branch, so the operator learns where it went.
    expect(showToast).toHaveBeenCalledWith({
      message: "Managed Worktrees:\nfeature — cleanup failed",
    });
  });

  it.each(["snapshot failure", "request rejection"] as const)(
    "surfaces one forced worktree removal %s after confirmed session deletion",
    async (failure) => {
      const h = createHarness({
        ...destructiveHarness,
        methods: [...destructiveHarness.methods, "worktrees.remove"],
      });
      h.deleteOne.mockResolvedValueOnce({
        deleted: true,
        worktreePreserved: preservedWorktree("snapshot-failed"),
      } as never);
      const rejection = new Error("worktree removal failed");
      if (failure === "snapshot failure") {
        h.request.mockResolvedValueOnce({
          removed: true,
          snapshotError: "nested gitlink",
        } as never);
      } else {
        h.request.mockRejectedValueOnce(rejection);
      }

      const pending = removeSession(h, sessionRow(0));
      answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
      const worktreeActions = await waitForConfirmDialogActions();
      expect(document.body.querySelector("openclaw-modal-dialog")?.textContent).toContain(
        "OpenClaw could not create a safety snapshot",
      );
      answerConfirmDialog(worktreeActions, "confirm");
      await pending;

      expect(h.request).toHaveBeenCalledWith("worktrees.remove", {
        id: "wt-1",
        force: true,
      });
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
    const pending = removeSession(h, row, offerSkip ? { offerSkip } : undefined);
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
      run: (h: OperationsHarness) => stopCloudWorker(h.host, cloudWorkerRow(false), h.scope),
    },
    {
      name: "preserved worktree removal",
      run: (h: OperationsHarness) => {
        h.deleteOne.mockResolvedValueOnce({
          deleted: true,
          worktreePreserved: preservedWorktree("foreign-lock"),
        } as never);
        return removeSession(h, sessionRow(0));
      },
    },
  ])("never offers an opt-out on the $name confirm", async (operation) => {
    // Opting out of session deletes must not leak into the serious confirms.
    patchSettings({ sessionDeleteConfirm: false });
    const h = createHarness({
      ...destructiveHarness,
      methods: [...destructiveHarness.methods, "worktrees.remove"],
    });

    const pending = operation.run(h);
    const actions = await waitForConfirmDialogActions();
    expect(document.body.querySelector(".exec-approval-skip")).toBeNull();
    answerConfirmDialog(actions, "cancel");
    await pending;
  });

  it("refreshes the appearance settings view when the operator opts out", async () => {
    const h = createHarness(destructiveHarness);

    const pending = removeSession(h, sessionRow(0), {
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
    expect(h.refreshTheme).toHaveBeenCalledOnce();
    expect(loadSettings().sessionDeleteConfirm).toBe(false);
  });

  it("never opens the stop confirm for a reclaim target with an active run", async () => {
    const h = createHarness(destructiveHarness);

    await stopCloudWorker(h.host, cloudWorkerRow(true), h.scope);

    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(h.request).not.toHaveBeenCalled();
  });
});

describe("session organizer batch archive confirmation", () => {
  it.each([
    { activity: { hasActiveRun: true }, decision: "cancel" },
    { activity: { gatewayHasActiveRun: true }, decision: "confirm" },
    { activity: { hasActiveSubagentRun: true }, decision: "retire" },
  ] as const)(
    "waits for $decision before archiving active work",
    async ({ activity, decision }) => {
      const modal = createModalDialogTestFixture();
      const h = createHarness();
      const rows = [sessionRow(0), { ...sessionRow(1), ...activity }];
      vi.mocked(showToast).mockClear();
      try {
        const pending = modal.track(runAction(h, { kind: "toggle-archived" }, rows, false));
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
          expect(h.request.mock.calls.map(([method, params]) => [method, params])).toEqual([
            ["sessions.patchMany", { targets: rows.map(sessionTarget), patch: { archived: true } }],
          ]);
          expect(h.finishArchive).toHaveBeenCalledTimes(rows.length);
        } else {
          expectNoCalls(h.beginArchive, h.request, h.reconcileMutation, h.pruneSidebarSessionEntry);
          expect(showToast).not.toHaveBeenCalled();
        }
      } finally {
        await modal.cleanup();
      }
    },
  );

  it.each([false, true])(
    "keeps idle archive and archived=%s restore immediate",
    async (archived) => {
      const h = createHarness();
      const rows = [sessionRow(0), sessionRow(1)].map((row) =>
        Object.assign(row, { archived, hasActiveRun: true, gatewayHasActiveRun: false }),
      );
      await runAction(h, { kind: "toggle-archived" }, rows, false);
      expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(h.request.mock.calls.map(([method, params]) => [method, params])).toEqual([
        [
          "sessions.patchMany",
          { targets: rows.map(sessionTarget), patch: { archived: !archived } },
        ],
      ]);
    },
  );
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
    await snooze(h, row, { snoozedUntil: now + 3_600_000 });
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
      await snooze(h, sessionRow(1), { snoozedUntil: until + 1000, rememberCustom: true });
      expect(readCustomSnooze(key)).toBe(until);
      expectError(h, error);
      expect(showToast).not.toHaveBeenCalled();
      await snooze(h, sessionRow(1), { snoozedUntil: until + 2000 });
      expect(readCustomSnooze(key)).toBe(until);
      await snooze(h, sessionRow(1), { snoozedUntil: until + 3000, rememberCustom: true });
      expect(readCustomSnooze(key)).toBe(until + 3000);
      vi.mocked(showToast).mock.calls.at(-1)?.[0].onAction?.();
      expect(readCustomSnooze(key)).toBe(until + 3000);
      h.retireScope();
      await snooze(h, sessionRow(1), { snoozedUntil: until + 4000, rememberCustom: true });
      expect(readCustomSnooze(key)).toBe(until + 3000);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
