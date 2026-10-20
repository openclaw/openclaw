/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import type { SessionRefreshOptions } from "../lib/sessions/session-capability.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../test-helpers/modal-dialog.ts";
import { archiveSessionWithUndo } from "./session-organizer-archive.runtime.ts";
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

async function openArchive(
  harness: ReturnType<typeof createHarness>,
  root: ReturnType<typeof sessionRow>,
) {
  const modal = createModalDialogTestFixture();
  onTestFinished(() => modal.cleanup());
  const pending = modal.track(archiveSessionWithUndo(harness.host, root, harness.scope));
  const actions = await waitForConfirmDialogActions();
  expect(document.body.textContent).toContain(
    '"Batch 0" has a nested session. Archive only this one and it moves to the top level.',
  );
  expect(document.body.textContent).toContain(t("sessionsView.archiveRunningSessions"));
  return { pending, actions };
}

function guardedTarget(index: number) {
  return {
    ...sessionTarget(sessionRow(index)),
    expectedSidebarRoot: false,
    expectedCategory: null,
  };
}

describe("session organizer nested archive choice", () => {
  it.each(["confirm", "alternative", "cancel"] as const)(
    "honors %s with one active-work warning and guarded descendant-first batches",
    async (choice) => {
      const harness = createHarness();
      const root = { ...sessionRow(0), hasArchiveDescendants: true, hasActiveRun: true };
      prepareArchiveTree(harness, [
        gatewayRow(0, { hasActiveRun: true }),
        gatewayRow(1, { parentSessionKey: root.key }),
        gatewayRow(2, { parentSessionKey: sessionRow(1).key }),
      ]);
      const { pending, actions } = await openArchive(harness, root);
      expect(actions.textContent).toContain("Archive 3 sessions");
      expect(harness.patch).not.toHaveBeenCalled();
      expect(harness.request).not.toHaveBeenCalled();
      answerConfirmDialog(actions, choice);
      if (choice === "confirm") {
        await vi.waitFor(() => expect(harness.patch).toHaveBeenCalledOnce());
        expect(harness.patch).toHaveBeenCalledWith(
          root.key,
          { archived: true },
          { agentId: "main", expectedSessionId: root.sessionId },
        );
        expect(harness.request).not.toHaveBeenCalled();
      } else if (choice === "alternative") {
        await vi.waitFor(() => expect(harness.request).toHaveBeenCalledOnce());
        expect(harness.request.mock.calls[0]?.[1]).toEqual({
          targets: [2, 1, 0].map((index) =>
            Object.assign(guardedTarget(index), {
              expectedArchived: false,
              expectedSidebarAncestors: Array.from({ length: index }, (_, ancestor) =>
                guardedTarget(index - ancestor - 1),
              ),
            }),
          ),
          patch: { archived: true },
        });
        expect(harness.patch).not.toHaveBeenCalled();
      }
      await pending;
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
      if (choice === "cancel") {
        expect(harness.patch).not.toHaveBeenCalled();
        expect(harness.request).not.toHaveBeenCalled();
        expect(harness.beginArchive).not.toHaveBeenCalled();
      }
    },
  );

  it("warns for active work in a child and uses singular nested-session copy", async () => {
    const harness = createHarness();
    const root = { ...sessionRow(0), hasArchiveDescendants: true };
    prepareArchiveTree(harness, [
      gatewayRow(0),
      gatewayRow(1, { parentSessionKey: root.key, hasActiveRun: true }),
    ]);
    const { pending, actions } = await openArchive(harness, root);
    answerConfirmDialog(actions, "confirm");
    await vi.waitFor(() => expect(harness.patch).toHaveBeenCalledOnce());
    await pending;
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });

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
