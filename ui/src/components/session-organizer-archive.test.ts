/* @vitest-environment jsdom */

import { assert, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  createGatewayStoreTestStore,
  stubGatewayStoreTestGlobals,
} from "../app/gateway-store.test-support.ts";
import { t } from "../i18n/index.ts";
import type { SessionPatchOptions, SessionPatchRoute } from "../lib/sessions/patch.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import type { SessionRefreshOptions } from "../lib/sessions/session-capability.ts";
import { patchReceipt } from "../lib/sessions/session-rpc.test-support.ts";
import { showToast } from "../lib/toast.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../test-helpers/modal-dialog.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  archiveConfirmedSessionsWithUndo,
  archiveSessionWithUndo,
  confirmSessionArchive,
  captureSessionArchivePins,
} from "./session-organizer-archive.runtime.ts";
import {
  createHarness,
  sessionRow,
  sessionTarget,
} from "./session-organizer-batch-mutations.test-support.ts";

vi.mock("../lib/toast.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/toast.ts")>()),
  showToast: vi.fn(),
}));

function prepareArchiveTree(
  harness: ReturnType<typeof createHarness>,
  rows: GatewaySessionRow[],
  childrenByParent?: ReadonlyMap<string, GatewaySessionRow[]>,
) {
  let children: GatewaySessionRow[] = [];
  const describeSession = vi.fn(async () => ({ session: rows[0]! }));
  const refreshList = vi.fn(async (query?: SessionRefreshOptions) => {
    children = childrenByParent
      ? (childrenByParent.get(query?.spawnedBy ?? "") ?? [])
      : rows.filter((row) => row.parentSessionKey === query?.spawnedBy);
  });
  harness.scope.sessions.describe = describeSession;
  harness.scope.sessions.refreshList = refreshList;
  harness.scope.sessions.listSnapshot = () => ({
    result: sessionsResult(children, 1),
    agentId: "main",
    loading: false,
    error: null,
  });
  return { describeSession, refreshList };
}

function gatewayRow(index: number, overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  const { key, sessionId, sharingRole } = sessionRow(index);
  return { key, sessionId, sharingRole, kind: "direct", updatedAt: index, ...overrides };
}

function guardedTarget(index: number) {
  return {
    ...sessionTarget(sessionRow(index)),
    expectedSidebarRoot: false,
    expectedCategory: null,
  };
}

describe("session organizer nested archive choice", () => {
  it("confirms only the selected offline parent without discovering or archiving its subtree", async () => {
    const h = createHarness({ phase: "reconnecting" });
    h.scope.allowDeferred = true;
    const root = { ...sessionRow(0), hasArchiveDescendants: true };
    const tree = prepareArchiveTree(h, [gatewayRow(0), gatewayRow(1)]);
    const modal = createModalDialogTestFixture();
    onTestFinished(() => modal.cleanup());
    const pending = modal.track(confirmSessionArchive(root, h.scope, () => true));
    const dialog = await waitForConfirmDialogActions();
    expect(document.body.textContent).toContain("Reconnect to archive the complete subtree.");
    answerConfirmDialog(dialog, "confirm");
    await expect(pending).resolves.toEqual({ kind: "single" });
    expect(tree.describeSession).not.toHaveBeenCalled();
    expect(tree.refreshList).not.toHaveBeenCalled();
  });
  it("includes unexpanded persistent descendants through workers but excludes independent branches", async () => {
    const modal = createModalDialogTestFixture();
    onTestFinished(() => modal.cleanup());
    const harness = createHarness();
    const root = gatewayRow(0);
    const worker = gatewayRow(1, { key: "agent:main:subagent:worker" });
    const child = gatewayRow(2);
    const grandchild = gatewayRow(3);
    const children = new Map([
      [
        root.key,
        [
          worker,
          gatewayRow(4, { sidebarRoot: true }),
          gatewayRow(5, { category: "Work" }),
          gatewayRow(6, { archived: true }),
        ],
      ],
      [worker.key, [child]],
      [child.key, [grandchild]],
      [grandchild.key, [root]],
    ]);
    const reads = prepareArchiveTree(harness, [root], children);
    const pending = modal.track(
      confirmSessionArchive(
        { ...sessionRow(0), hasArchiveDescendants: true },
        harness.scope,
        () => true,
      ),
    );
    const actions = await waitForConfirmDialogActions();
    expect(actions.textContent).toContain("Archive all (3)");
    expect(harness.patch).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
    answerConfirmDialog(actions, "confirm");
    expect(await pending).toMatchObject({
      kind: "tree",
      rows: [
        {
          key: grandchild.key,
          archiveGuard: { expectedSidebarAncestors: [guardedTarget(2), guardedTarget(0)] },
        },
        { key: child.key, archiveGuard: { expectedSidebarAncestors: [guardedTarget(0)] } },
        { key: root.key, archiveGuard: { expectedSidebarAncestors: [] } },
      ],
    });
    expect(reads.refreshList.mock.calls.map(([query]) => query?.spawnedBy)).toEqual([
      root.key,
      worker.key,
      child.key,
      grandchild.key,
    ]);
  });

  it("does not return a partial tree when a child read fails or the connection changes", async () => {
    const harness = createHarness();
    const root = { ...sessionRow(0), hasArchiveDescendants: true };
    const reads = prepareArchiveTree(harness, [gatewayRow(0)]);
    const isCurrent = () => harness.host.sessionData.isSessionMutationScopeCurrent(harness.scope);
    reads.refreshList.mockImplementation(async () => {
      throw new Error("unavailable");
    });
    await expect(confirmSessionArchive(root, harness.scope, isCurrent)).rejects.toThrow(
      "unavailable",
    );
    expect(await confirmSessionArchive(root, harness.scope, () => false)).toBeNull();
    expect(reads.describeSession).toHaveBeenCalledOnce();
    reads.refreshList.mockImplementation(async () => harness.retireScope());
    expect(await confirmSessionArchive(root, harness.scope, isCurrent)).toBeNull();
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(harness.patch).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("returns a partial archive failure while retaining successful-only Undo after navigation", async () => {
    const rows = [sessionRow(1), sessionRow(2), sessionRow(3)];
    const undoError = new Error("Undo denied after navigation");
    const harness = createHarness({
      failedKeys: [rows[1]!.key],
      requestFailure: { at: 2, error: undoError },
    });
    vi.mocked(showToast).mockClear();

    const outcome = await archiveConfirmedSessionsWithUndo(harness.host, rows, harness.scope);
    expect(outcome).toEqual({ status: "failed", error: expect.stringContaining(rows[1]!.key) });
    expect(harness.publishSessionMutationError).toHaveBeenCalledExactlyOnceWith(
      harness.scope,
      expect.stringContaining(rows[1]!.key),
    );
    const archived = vi.mocked(showToast).mock.calls.at(-1)![0];
    expect(archived.message).toBe(t("sessionsView.sessionsArchived", { count: "2" }));
    expect(archived.onAction).toBeTypeOf("function");
    expect(harness.finishArchive).toHaveBeenCalledTimes(3);

    // The page retires, but the same connection still owns the captured Undo.
    vi.mocked(harness.host.sessionData.isSessionMutationScopeCurrent).mockReturnValue(false);
    archived.onAction!();
    await waitForFast(() => expect(showToast).toHaveBeenCalledWith({ message: undoError.message }));
    expect(harness.request.mock.calls[1]?.[1]).toEqual({
      targets: [rows[0]!, rows[2]!].map(sessionTarget),
      patch: { archived: false },
    });
    expect(harness.publishSessionMutationError).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: "failed", error: expect.stringContaining(rows[1]!.key) });
  });

  it.each([
    ["confirm", 3, 0],
    ["alternative", 3, 0],
    ["cancel", 3, 0],
    ["confirm", 2, 1],
  ] as const)(
    "honors %s for %s sessions with active work at depth %s",
    async (choice, count, activeDepth) => {
      const modal = createModalDialogTestFixture();
      onTestFinished(() => modal.cleanup());
      const harness = createHarness();
      const root = {
        ...sessionRow(0),
        hasArchiveDescendants: true,
        hasActiveRun: activeDepth === 0,
      };
      prepareArchiveTree(
        harness,
        Array.from({ length: count }, (_, index) =>
          gatewayRow(index, {
            hasActiveRun: index === activeDepth,
            ...(index > 0 ? { parentSessionKey: sessionRow(index - 1).key } : {}),
          }),
        ),
      );
      const pending = modal.track(archiveSessionWithUndo(harness.host, root, harness.scope));
      const actions = await waitForConfirmDialogActions();
      expect(document.body.textContent).toContain(
        '"Batch 0" has 1 directly nested session. If you archive only this session, that nested session moves to the top level.',
      );
      expect(document.body.textContent).toContain(t("sessionsView.archiveRunningSessions"));
      expect(actions.textContent).toContain(`Archive all (${count})`);
      expect(harness.patch).not.toHaveBeenCalled();
      expect(harness.request).not.toHaveBeenCalled();
      answerConfirmDialog(actions, choice);
      await pending;
      expect(harness.patch).toHaveBeenCalledTimes(choice === "alternative" ? 1 : 0);
      expect(harness.request).toHaveBeenCalledTimes(choice === "confirm" ? 1 : 0);
      if (choice === "alternative") {
        expect(harness.patch).toHaveBeenCalledWith(
          root.key,
          { archived: true },
          { agentId: "main", expectedSessionId: root.sessionId },
        );
      } else if (choice === "confirm") {
        expect(harness.request.mock.calls[0]?.[1]).toEqual({
          targets: Array.from({ length: count }, (_, index) => count - index - 1).map((index) =>
            Object.assign(guardedTarget(index), {
              expectedArchived: false,
              expectedSidebarAncestors: Array.from({ length: index }, (_, ancestor) =>
                guardedTarget(index - ancestor - 1),
              ),
            }),
          ),
          patch: { archived: true },
        });
      }
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
      if (choice === "cancel") {
        expect(harness.beginArchive).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    "keeps single archive when no descendants remain (hint=%s)",
    async (hint) => {
      const harness = createHarness();
      const root = { ...sessionRow(0), hasArchiveDescendants: hint };
      const reads = prepareArchiveTree(harness, [gatewayRow(0)]);
      await archiveSessionWithUndo(harness.host, root, harness.scope);
      expect(harness.patch).toHaveBeenCalledOnce();
      expect(harness.request).not.toHaveBeenCalled();
      expect(reads.describeSession).toHaveBeenCalledTimes(hint ? 1 : 0);
      expect(reads.refreshList).toHaveBeenCalledTimes(hint ? 1 : 0);
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    },
  );
});

function createOfflineArchiveHarness() {
  const h = createHarness({ phase: "reconnecting" });
  h.scope.allowDeferred = true;
  Object.assign(h.scope.context, { gateway: h.scope.gateway, sessions: h.scope.sessions });
  Object.assign(h.scope.client, { recoveryScope: "archive-owner", recoveryScopeReady: true });
  const connection = { client: h.scope.client, epoch: 1 };
  h.scope.sessions.captureConnectionScope = () =>
    h.scope.gateway.snapshot.phase === "connected" ? connection : null;
  h.scope.sessions.isConnectionScopeCurrent = (candidate) =>
    h.scope.gateway.snapshot.phase === "connected" &&
    h.scope.gateway.snapshot.client === candidate.client;
  return h;
}

describe("personal pin archive Undo", () => {
  it.each(["restored", "rejected", "manual"] as const)(
    "settles a personal pin after Undo during archive replay (%s)",
    async (outcome) => {
      stubGatewayStoreTestGlobals();
      onTestFinished(() => {
        vi.unstubAllGlobals();
      });
      const store = createGatewayStoreTestStore();
      store.gateway.start();
      const client = store.current();
      client.testOptions.offlineRecoveryScope = "archive-owner";
      Object.assign(client, { recoveryScope: "archive-owner", recoveryScopeReady: true });
      const hello = {
        ...gatewayHelloForMethods([
          "sessions.patch",
          "sessions.list",
          "sessions.describe",
          "sessions.subscribe",
        ]),
        auth: { role: "operator", scopes: ["operator.admin"], recoveryScope: "archive-owner" },
      };
      let row: GatewaySessionRow = gatewayRow(1);
      const archiveReply = createDeferred();
      const undoReply = createDeferred();
      const archiveStarted = createDeferred();
      const undoStarted = createDeferred();
      client.request.mockImplementation(async (method, params) => {
        if (method === "sessions.list") {
          return sessionsResult([{ ...row }]);
        }
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method === "sessions.patch") {
          const patch = params as { archived: boolean };
          if (patch.archived) {
            archiveStarted.resolve();
            await archiveReply.promise;
          } else {
            undoStarted.resolve();
            await undoReply.promise;
            if (outcome === "rejected") {
              throw new Error("Undo denied");
            }
          }
          row = { ...row, archived: patch.archived, pinned: false };
          return patchReceipt(row.key, row);
        }
        return {};
      });
      client.testOptions.onHello?.(hello);
      const sessions = createTestSessionCapability(store.gateway);
      onTestFinished(() => {
        archiveReply.resolve();
        undoReply.resolve();
        sessions.dispose();
        store.gateway.stop();
      });
      await sessions.refresh({ agentId: "main" });
      client.testOptions.onClose?.({ code: 1006, reason: "offline", willRetry: true });
      const h = createOfflineArchiveHarness();
      Object.assign(h.scope, { gateway: store.gateway, client, sessions });
      Object.assign(h.scope.context, { gateway: store.gateway, sessions });
      const navigation = h.scope.context.navigation;
      const pin = "session:" + row.key;
      navigation.update({ sidebarEntries: [pin] });
      h.host.pruneSidebarSessionEntry = (key) =>
        navigation.update({
          sidebarEntries: navigation.snapshot.sidebarEntries.filter(
            (entry) => entry !== "session:" + key,
          ),
        });
      await archiveSessionWithUndo(h.host, sessionRow(1), h.scope);
      const undo = vi.mocked(showToast).mock.calls.at(-1)?.[0].onAction;
      assert(undo);
      client.testOptions.onHello?.(hello);
      await archiveStarted.promise;
      undo();
      await waitForFast(() => expect(store.gateway.snapshot.deferredIntentCount).toBe(1));
      archiveReply.resolve();
      await undoStarted.promise;
      expect(navigation.snapshot.sidebarEntries).toEqual([]);
      if (outcome === "manual") {
        navigation.update({ sidebarEntries: [pin] });
        navigation.update({ sidebarEntries: [] });
      }
      undoReply.resolve();
      await waitForFast(() => expect(store.gateway.snapshot.deferredIntentDraining).toBe(false));
      expect(row.archived).toBe(outcome === "rejected");
      expect(navigation.snapshot.sidebarEntries).toEqual(outcome === "restored" ? [pin] : []);
    },
  );

  it.each(["same-client", "replacement-client", "recovery-scope", "manual"] as const)(
    "settles an offline personal pin receipt after reconnect (%s)",
    async (outcome) => {
      const h = createOfflineArchiveHarness();
      const key = sessionRow(1).key;
      const pin = "session:" + key;
      const retained = ["session-rail:" + key];
      const navigation = h.scope.context.navigation;
      navigation.update({ sidebarEntries: [pin, ...retained] });
      const undoPins = captureSessionArchivePins(h.scope, [key]);
      navigation.update({ sidebarEntries: retained });
      h.scope.gateway.snapshot.phase = "connected";
      if (outcome === "replacement-client") {
        h.scope.gateway.snapshot.client = createTestGatewayClient(async () => ({}));
      }
      const reply = createDeferred<readonly string[]>();
      const restore = vi.fn(() => reply.promise);
      const operation = undoPins.restore(restore);
      if (outcome === "recovery-scope") {
        Object.assign(h.scope.client, { recoveryScope: "another-owner" });
      } else if (outcome === "manual") {
        navigation.update({ sidebarEntries: [...retained, pin] });
        navigation.update({ sidebarEntries: retained });
      }
      reply.resolve([key]);
      await operation;
      expect(navigation.snapshot.sidebarEntries).toEqual(
        outcome === "same-client" ? [...retained, pin] : retained,
      );
      expect(restore).toHaveBeenCalledTimes(outcome === "replacement-client" ? 0 : 1);
    },
  );

  it.each(["header", "sidebar"] as const)(
    "restores a personal pin through %s Undo after offline archive replay",
    async (surface) => {
      const h = createOfflineArchiveHarness();
      const row = { ...sessionRow(1), sessionId: "archived-offline" };
      const pin = "session:" + row.key;
      const navigation = h.scope.context.navigation;
      navigation.update({ sidebarEntries: [pin] });
      h.host.pruneSidebarSessionEntry = (key) =>
        navigation.update({
          sidebarEntries: navigation.snapshot.sidebarEntries.filter(
            (entry) => entry !== "session:" + key,
          ),
        });
      let onConfirmed: SessionPatchOptions["onConfirmed"];
      const patch = vi.fn<SessionPatchRoute>(async (key, fields, options) => {
        if (fields.archived === true) {
          onConfirmed = options?.onConfirmed;
          return { queued: true };
        }
        return patchReceipt(key, { sessionId: row.sessionId });
      });
      h.scope.sessions.patch = patch;
      h.scope.sessions.invalidate = vi.fn();
      h.scope.sessions.refreshReplacement = vi.fn(async () => sessionsResult([], 1));

      if (surface === "header") {
        await archiveSessionWithUndo(h.host, row, h.scope);
      } else {
        await archiveConfirmedSessionsWithUndo(h.host, [row], h.scope);
      }
      expect(navigation.snapshot.sidebarEntries).toEqual([pin]);
      const undo = vi.mocked(showToast).mock.calls.at(-1)?.[0].onAction;
      assert(undo);
      assert(onConfirmed);
      h.scope.gateway.snapshot.phase = "connected";
      onConfirmed(patchReceipt(row.key, { sessionId: row.sessionId }));
      expect(navigation.snapshot.sidebarEntries).toEqual([]);
      if (surface === "sidebar") {
        // Reconnect retires the pane's confirmation epoch, not the admitted offline intent.
        vi.mocked(h.host.sessionData.isSessionMutationScopeCurrent).mockReturnValue(false);
      }
      const repinned = createDeferred();
      onTestFinished(
        navigation.subscribe(({ sidebarEntries }) => {
          if (sidebarEntries.includes(pin)) {
            repinned.resolve();
          }
        }),
      );
      undo();
      await repinned.promise;
      expect(navigation.snapshot.sidebarEntries).toEqual([pin]);
      expect(patch.mock.calls.map(([, fields]) => fields)).toEqual([
        { archived: true },
        { archived: false },
      ]);
      expect(h.publishSessionMutationError).not.toHaveBeenCalled();
    },
  );

  it("undoes an offline bulk archive without attempting a pin write", async () => {
    const h = createOfflineArchiveHarness();
    h.scope.sessions.invalidate = vi.fn();
    h.scope.sessions.refreshReplacement = vi.fn(async () => null);
    const queuedPatch = vi.fn<SessionPatchRoute>(async () => ({ queued: true }));
    h.scope.sessions.patch = queuedPatch;
    onTestFinished(() => {
      for (const call of queuedPatch.mock.calls) {
        call[2]?.onDeferredSettled?.();
      }
    });
    const rows = [sessionRow(0), sessionRow(100)];
    await archiveConfirmedSessionsWithUndo(h.host, rows, h.scope);
    vi.mocked(showToast).mock.calls.at(-1)![0].onAction!();
    await waitForFast(() => expect(h.scope.sessions.patch).toHaveBeenCalledTimes(4));
    expect(vi.mocked(h.scope.sessions.patch).mock.calls.map(([, patch]) => patch)).toEqual([
      { archived: true },
      { archived: true },
      { archived: false },
      { archived: false },
    ]);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.publishSessionMutationError).not.toHaveBeenCalled();
  });
  it.each(["success", "failure", "profile", "manual"] as const)(
    "settles a personal pin receipt without replacing newer intent (%s)",
    async (outcome) => {
      const h = createHarness();
      const key = sessionRow(1).key;
      const pin = "session:" + key;
      const retained = ["session-rail:" + key, "session:agent:main:other"];
      const navigation = h.scope.context.navigation;
      navigation.update({ sidebarEntries: [pin, ...retained] });
      const undoPins = captureSessionArchivePins(h.scope, [key]);
      navigation.update({ sidebarEntries: retained });
      const reply = createDeferred<readonly string[]>();
      const operation = undoPins.restore(() => reply.promise);
      expect(navigation.snapshot.sidebarEntries).toEqual(retained);
      if (outcome === "profile") {
        h.retireScope();
        navigation.update({ sidebarEntries: ["session:agent:main:another-profile"] });
      } else if (outcome === "manual") {
        navigation.update({ sidebarEntries: [...retained, pin] });
        navigation.update({ sidebarEntries: retained });
      } else if (outcome === "success") {
        navigation.update({ sidebarEntries: [...retained, "route:usage"] });
      }
      if (outcome === "failure") {
        reply.reject(new Error("Undo rejected"));
        await expect(operation).rejects.toThrow("Undo rejected");
      } else {
        reply.resolve([key]);
        await operation;
      }
      expect(navigation.snapshot.sidebarEntries).toEqual(
        outcome === "success"
          ? [...retained, "route:usage", pin]
          : outcome === "profile"
            ? ["session:agent:main:another-profile"]
            : retained,
      );
    },
  );

  it("repins only originally pinned sessions whose bulk Undo succeeds", async () => {
    const h = createHarness();
    const rows = [sessionRow(1), sessionRow(2), sessionRow(3)];
    const pins = rows.slice(0, 2).map((row) => "session:" + row.key);
    const rail = "session-rail:" + rows[0]!.key;
    const navigation = h.scope.context.navigation;
    navigation.update({ sidebarEntries: [...pins, rail] });
    h.host.pruneSidebarSessionEntry = (key) =>
      navigation.update({
        sidebarEntries: navigation.snapshot.sidebarEntries.filter(
          (entry) => entry !== "session:" + key,
        ),
      });
    h.scope.sessions.invalidate = vi.fn();
    h.scope.sessions.refreshReplacement = vi.fn(async () => sessionsResult([], 1));
    await archiveConfirmedSessionsWithUndo(h.host, rows, h.scope);
    expect(navigation.snapshot.sidebarEntries).toEqual([rail]);
    h.request.mockResolvedValueOnce({
      outcomes: rows.map((row, index) =>
        index === 1
          ? {
              key: row.key,
              ok: false as const,
              error: { code: "INVALID_REQUEST" as const, message: "Restore rejected" },
            }
          : { key: row.key, ok: true as const },
      ),
    });
    vi.mocked(showToast).mock.calls.at(-1)![0].onAction!();
    await waitForFast(() => expect(navigation.snapshot.sidebarEntries).toEqual([rail, pins[0]]));
    expect(h.publishSessionMutationError).toHaveBeenCalledWith(
      h.scope,
      expect.stringContaining("Restore rejected"),
    );
  });
});
