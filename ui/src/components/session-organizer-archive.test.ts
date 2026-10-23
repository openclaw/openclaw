/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished, vi } from "vitest";
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
import {
  archiveConfirmedSessionsWithUndo,
  archiveSessionWithUndo,
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

function prepareArchiveTree(harness: ReturnType<typeof createHarness>, rows: GatewaySessionRow[]) {
  let children: GatewaySessionRow[] = [];
  const describeSession = vi.fn(async () => ({ session: rows[0]! }));
  const refreshList = vi.fn(async (query?: SessionRefreshOptions) => {
    children = rows.filter((row) => row.parentSessionKey === query?.spawnedBy);
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
