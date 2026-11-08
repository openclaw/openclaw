/* @vitest-environment jsdom */

import { assert, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import type { SessionRefreshOptions } from "../lib/sessions/session-capability.ts";
import { showToast } from "../lib/toast.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../test-helpers/modal-dialog.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { isArchiveHeld, undoHeldArchive } from "./session-archive-hold.ts";
import {
  archiveConfirmedSessionsWithUndo,
  archiveSessionWithUndo,
  confirmSessionArchive,
} from "./session-organizer-archive.runtime.ts";
import {
  createHarness,
  endArchiveUndoWindow,
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

  it("commits a held tree after navigation and reports its partial failure", async () => {
    const rows = [sessionRow(1), sessionRow(2), sessionRow(3)];
    const harness = createHarness({ failedKeys: [rows[1]!.key] });
    vi.mocked(showToast).mockClear();

    expect(archiveConfirmedSessionsWithUndo(harness.host, rows, harness.scope)).toBe("completed");
    expect(harness.beginArchive).toHaveBeenCalledTimes(3);
    expect(harness.request).not.toHaveBeenCalled();
    expect(lastToast().message).toBe(t("sessionsView.sessionsArchived", { count: "3" }));

    // The page retires, but the same connection still owns the held archive.
    vi.mocked(harness.host.sessionData.isSessionMutationScopeCurrent).mockReturnValue(false);
    await endArchiveUndoWindow(harness);
    expect(harness.request.mock.calls.map(([, params]) => params)).toEqual([
      { targets: rows.map(sessionTarget), patch: { archived: true } },
    ]);
    expect(harness.finishArchive).toHaveBeenCalledTimes(3);
    expect(showToast).toHaveBeenCalledWith({
      severity: "error",
      message: expect.stringContaining(rows[1]!.key),
    });
    expect(harness.publishSessionMutationError).not.toHaveBeenCalled();
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
        "“Batch 0” has 1 directly nested session. If you archive only this session, that nested session moves to the top level.",
      );
      expect(document.body.textContent).toContain(t("sessionsView.archiveRunningSessions"));
      expect(actions.textContent).toContain(`Archive all (${count})`);
      expect(harness.patch).not.toHaveBeenCalled();
      expect(harness.request).not.toHaveBeenCalled();
      answerConfirmDialog(actions, choice);
      await pending;
      if (choice !== "cancel") {
        await endArchiveUndoWindow(harness);
      }
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
      await endArchiveUndoWindow(harness);
      expect(harness.patch).toHaveBeenCalledOnce();
      expect(harness.request).not.toHaveBeenCalled();
      expect(reads.describeSession).toHaveBeenCalledTimes(hint ? 1 : 0);
      expect(reads.refreshList).toHaveBeenCalledTimes(hint ? 1 : 0);
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    },
  );
});

function lastToast() {
  const toast = vi.mocked(showToast).mock.calls.at(-1)?.[0];
  assert(toast);
  return toast;
}

describe("held archive Undo window", () => {
  it("hides the session and lets Undo restore it without any Gateway write", async () => {
    const harness = createHarness();
    vi.mocked(showToast).mockClear();
    await archiveSessionWithUndo(harness.host, sessionRow(1), harness.scope);
    expect(harness.beginArchive).toHaveBeenCalledExactlyOnceWith(
      sessionRow(1).key,
      sessionRow(1).sessionId,
    );
    const held = lastToast();
    expect(held.message).toBe(t("sessionsView.sessionArchived"));
    expect(harness.patch).not.toHaveBeenCalled();

    // The toast dismisses itself before it runs the action.
    held.onDismiss?.("action");
    held.onAction?.();
    expect(harness.finishArchive).toHaveBeenCalledOnce();
    held.onDismiss?.("timeout");
    window.dispatchEvent(new Event("pagehide"));
    await Promise.resolve();
    expect(harness.patch).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.finishArchive).toHaveBeenCalledOnce();
  });

  it("lets the session's own Undo cancel its held batch and retire the notice", async () => {
    const harness = createHarness();
    const rows = [sessionRow(1), sessionRow(2)];
    archiveConfirmedSessionsWithUndo(harness.host, rows, harness.scope);
    const held = lastToast();
    expect(held.signal?.aborted).toBe(false);
    expect(isArchiveHeld(rows[1]!.key)).toBe(true);
    undoHeldArchive("agent:main:not-held");
    expect(harness.finishArchive).not.toHaveBeenCalled();

    undoHeldArchive(rows[1]!.key);
    expect(held.signal?.aborted).toBe(true);
    expect(isArchiveHeld(rows[1]!.key)).toBe(false);
    expect(harness.finishArchive).toHaveBeenCalledTimes(2);
    // Retiring the notice reports a dismissal; the cancelled archive stays unsent.
    held.onDismiss?.("dismiss");
    window.dispatchEvent(new Event("pagehide"));
    await Promise.resolve();
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.patch).not.toHaveBeenCalled();
  });

  it.each(["timeout", "dismiss", "replaced"] as const)(
    "archives once the window closes by %s",
    async (reason) => {
      const harness = createHarness();
      await archiveSessionWithUndo(harness.host, sessionRow(1), harness.scope);
      const held = lastToast();
      held.onDismiss?.(reason);
      held.onDismiss?.(reason);
      // Once sending, the archive can no longer be cancelled from the session.
      expect(isArchiveHeld(sessionRow(1).key)).toBe(false);
      await waitForFast(() => expect(harness.finishArchive).toHaveBeenCalledOnce());
      expect(harness.patch).toHaveBeenCalledExactlyOnceWith(
        sessionRow(1).key,
        { archived: true },
        { agentId: "main", expectedSessionId: sessionRow(1).sessionId },
      );
      held.onAction?.();
      expect(harness.finishArchive).toHaveBeenCalledOnce();
    },
  );

  it("archives held sessions when the page is left before the window closes", async () => {
    const harness = createHarness();
    const rows = [sessionRow(1), sessionRow(2)];
    archiveConfirmedSessionsWithUndo(harness.host, rows, harness.scope);
    window.dispatchEvent(new Event("pagehide"));
    await waitForFast(() => expect(harness.finishArchive).toHaveBeenCalledTimes(2));
    expect(harness.request.mock.calls.map(([, params]) => params)).toEqual([
      { targets: rows.map(sessionTarget), patch: { archived: true } },
    ]);
    lastToast().onDismiss?.("timeout");
    await Promise.resolve();
    expect(harness.request).toHaveBeenCalledOnce();
  });
});

function withCronList(
  harness: ReturnType<typeof createHarness>,
  list: (params: Record<string, unknown>) => Promise<unknown>,
) {
  const original = harness.request.getMockImplementation()!;
  const cronList = vi.fn(list);
  harness.request.mockImplementation(async (method, params, options) =>
    method === "cron.list"
      ? cronList(params as Record<string, unknown>)
      : original(method, params, options),
  );
  return cronList;
}

const cronPage = (...jobs: { id: string; name: string }[]) => ({
  jobs,
  total: jobs.length,
  offset: 0,
  limit: 10,
  hasMore: false,
  nextOffset: null,
});

describe("archive confirmation for bound automations", () => {
  it.each(["cancel", "confirm"] as const)(
    "names bound automations before archiving and records the %s",
    async (decision) => {
      const modal = createModalDialogTestFixture();
      onTestFinished(() => modal.cleanup());
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      onTestFinished(() => info.mockRestore());
      const harness = createHarness();
      const cronList = withCronList(harness, async () =>
        cronPage({ id: "job-1", name: "Nightly digest" }),
      );
      const row = { ...sessionRow(1), hasAutomation: true };
      const pending = modal.track(archiveSessionWithUndo(harness.host, row, harness.scope));
      const actions = await waitForConfirmDialogActions();
      expect(cronList).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: row.key,
          sessionAgentId: "main",
          enabled: "enabled",
          compact: true,
        }),
      );
      expect(document.body.textContent).toContain('Archiving "Batch 1" pauses its automations.');
      expect(document.body.textContent).not.toContain("openclaw automations");
      expect(document.body.textContent).toContain("Nightly digest (job-1)");
      expect(actions.textContent).toContain("Archive anyway");
      answerConfirmDialog(actions, decision);
      await pending;
      if (decision === "confirm") {
        await endArchiveUndoWindow(harness);
      }
      expect(harness.patch).toHaveBeenCalledTimes(decision === "confirm" ? 1 : 0);
      expect(info.mock.calls.map(([message]) => message)).toEqual([
        "[session-automation-confirm] archive shown",
        decision === "confirm"
          ? "[session-automation-confirm] archive confirmed"
          : "[session-automation-confirm] archive cancelled",
      ]);
    },
  );

  it("keeps the no-dialog archive for conversations without automations", async () => {
    const harness = createHarness();
    const cronList = withCronList(harness, async () => cronPage());
    await archiveSessionWithUndo(harness.host, sessionRow(1), harness.scope);
    await endArchiveUndoWindow(harness);
    expect(cronList).not.toHaveBeenCalled();
    expect(harness.patch).toHaveBeenCalledOnce();
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("still warns when automation names cannot be read", async () => {
    const modal = createModalDialogTestFixture();
    onTestFinished(() => modal.cleanup());
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    onTestFinished(() => info.mockRestore());
    const harness = createHarness();
    withCronList(harness, async () => {
      throw new Error("cron unavailable");
    });
    const pending = modal.track(
      archiveSessionWithUndo(
        harness.host,
        { ...sessionRow(1), hasAutomation: true },
        harness.scope,
      ),
    );
    const actions = await waitForConfirmDialogActions();
    expect(document.body.textContent).toContain(t("sessionsView.automationPauseUnlisted"));
    answerConfirmDialog(actions, "cancel");
    await pending;
    expect(harness.patch).not.toHaveBeenCalled();
  });

  it("adds bound automations to the nested archive choice", async () => {
    const modal = createModalDialogTestFixture();
    onTestFinished(() => modal.cleanup());
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    onTestFinished(() => info.mockRestore());
    const harness = createHarness();
    const root = gatewayRow(0);
    const child = gatewayRow(1, { parentSessionKey: root.key, hasAutomation: true });
    prepareArchiveTree(harness, [root, child]);
    const cronList = withCronList(harness, async () =>
      cronPage({ id: "job-2", name: "Child report" }),
    );
    const pending = modal.track(
      confirmSessionArchive(
        { ...sessionRow(0), hasArchiveDescendants: true },
        harness.scope,
        () => true,
      ),
    );
    const actions = await waitForConfirmDialogActions();
    expect(cronList).toHaveBeenCalledOnce();
    expect(cronList).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: child.key }));
    expect(document.body.textContent).toContain(
      "Automations are bound to 1 of these conversations.",
    );
    expect(document.body.textContent).toContain("Child report (job-2)");
    expect(actions.textContent).toContain("Archive all (2)");
    answerConfirmDialog(actions, "cancel");
    await expect(pending).resolves.toBeNull();
  });
});
