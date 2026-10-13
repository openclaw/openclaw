/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type {
  SessionsPatchManyParams,
  SessionsPatchManyResult,
} from "../../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../../test-helpers/modal-dialog.ts";
import { createContext, createGateway, createPage } from "./sessions-page.test-support.ts";

async function setup(childCount: number) {
  const root: GatewaySessionRow = {
    key: "agent:main:tree-outcome",
    sessionId: "captured-root-session",
    kind: "direct",
    label: "Tree outcome",
    sharingRole: "owner",
  };
  const children: GatewaySessionRow[] = Array.from({ length: childCount }, (_, index) => ({
    key: "agent:main:tree-child-" + index,
    sessionId: "captured-child-session-" + index,
    parentSessionKey: root.key,
    kind: "direct",
    sharingRole: "owner",
  }));
  const rows = [root, ...children];
  const serverRows = structuredClone(rows);
  const failed = children[0]!;
  const failureMessage = "Child placement changed after confirmation";
  const pending = createDeferred<SessionsPatchManyResult>();
  const dispatched = createDeferred<SessionsPatchManyParams>();
  const restored = createDeferred<SessionsPatchManyParams>();
  const batches: SessionsPatchManyParams[] = [];
  const batchResult = (params: SessionsPatchManyParams): SessionsPatchManyResult => ({
    outcomes: params.targets.map((target) =>
      params.patch.archived === true && target.key === failed.key
        ? {
            ok: false,
            key: target.key,
            agentId: target.agentId,
            error: { code: "INVALID_REQUEST", message: failureMessage },
          }
        : { ok: true, key: target.key, agentId: target.agentId },
    ),
  });
  const request = vi.fn(async (method: string, raw?: unknown) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.describe") {
      return { session: structuredClone(serverRows[0]) };
    }
    if (method === "sessions.list") {
      const query = raw as { spawnedBy?: string } | undefined;
      const visible = query?.spawnedBy
        ? serverRows.filter((row) => row.parentSessionKey === query.spawnedBy)
        : serverRows;
      return { ...sessionsResult(structuredClone(visible), 1), hasMore: false, nextOffset: null };
    }
    if (method === "sessions.patchMany") {
      const params = raw as SessionsPatchManyParams;
      const archived = params.patch.archived;
      if (typeof archived !== "boolean") {
        throw new Error("Expected an archive or restore patch");
      }
      batches.push(params);
      if (batches.length === 1) {
        dispatched.resolve(params);
      }
      const result = batches.length === 1 ? await pending.promise : batchResult(params);
      const successful = new Set(
        result.outcomes.flatMap((outcome) => (outcome.ok ? [outcome.key] : [])),
      );
      for (const row of serverRows) {
        if (successful.has(row.key)) {
          row.archived = archived;
        }
      }
      if (!archived) {
        restored.resolve(params);
      }
      return result;
    }
    throw new Error("Unexpected request: " + method);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const gateway = createGateway(client);
  const sessions = createTestSessionCapability(gateway.gateway);
  const page = await createPage(createContext(gateway.gateway, sessions));
  const toast = document.createElement("openclaw-toast-host");
  document.body.append(toast);
  await sessions.refresh();
  return {
    root,
    rows,
    failed,
    failureMessage,
    pending,
    dispatched,
    restored,
    batches,
    batchResult,
    client,
    gateway,
    sessions,
    page,
    toast,
    undo: () => toast.querySelector<HTMLButtonElement>(".app-toast__action"),
  };
}

async function revealUndoAfterPartialError(fixture: Awaited<ReturnType<typeof setup>>) {
  await fixture.toast.updateComplete;
  // A success notification must not replace a partial failure before the operator can read it.
  expect(fixture.toast.textContent).toContain(fixture.failureMessage);
  if (!fixture.undo()) {
    const dismiss = fixture.toast.querySelector<HTMLButtonElement>(".app-toast__dismiss");
    expect(dismiss).not.toBeNull();
    dismiss!.click();
    await fixture.toast.updateComplete;
  }
  expect(fixture.toast.textContent).toContain(
    "Archived " + (fixture.rows.length - 1) + " sessions",
  );
  expect(fixture.undo()).not.toBeNull();
}

describe("Sessions page confirmed tree archive outcomes", () => {
  it("finishes remaining chunks after navigation and exposes partial errors plus successful-only Undo", async () => {
    const modal = createModalDialogTestFixture();
    // One more than the protocol batch maximum exercises a second confirmed chunk.
    const fixture = await setup(100);
    try {
      const operation = modal.track(fixture.page.archiveActions.archiveTree(fixture.root));
      const actions = await waitForConfirmDialogActions();
      expect(fixture.batches).toHaveLength(0);
      answerConfirmDialog(actions, "confirm");
      const first = await fixture.dispatched.promise;
      expect(first.targets).toHaveLength(100);
      fixture.page.remove();
      fixture.pending.resolve(fixture.batchResult(first));
      await operation;

      expect(fixture.batches.map((batch) => batch.targets.length)).toEqual([100, 1]);
      expect(fixture.batches[1]?.targets[0]?.key).toBe(fixture.root.key);
      expect(fixture.page.error).toBeNull();
      await revealUndoAfterPartialError(fixture);
      fixture.undo()!.click();
      await fixture.restored.promise;
      expect(fixture.batches).toHaveLength(3);
      expect(fixture.batches[2]).toEqual({
        targets: fixture.rows
          .toReversed()
          .filter((row) => row !== fixture.failed)
          .map((row) => ({
            key: row.key,
            agentId: "main",
            expectedSessionId: row.sessionId,
          })),
        patch: { archived: false },
      });
      expect(fixture.gateway.setSessionKey).not.toHaveBeenCalled();
    } finally {
      fixture.pending.resolve({ outcomes: [] });
      fixture.page.remove();
      await modal.cleanup();
      fixture.sessions.dispose();
      fixture.toast.remove();
    }
  });

  it("retires the confirmed tree Undo on a same-client reconnect after navigation", async () => {
    const modal = createModalDialogTestFixture();
    const fixture = await setup(2);
    try {
      const operation = modal.track(fixture.page.archiveActions.archiveTree(fixture.root));
      answerConfirmDialog(await waitForConfirmDialogActions(), "confirm");
      const first = await fixture.dispatched.promise;
      fixture.page.remove();
      fixture.pending.resolve(fixture.batchResult(first));
      await operation;
      await revealUndoAfterPartialError(fixture);

      fixture.gateway.emit({ phase: "reconnecting", client: null });
      fixture.gateway.emit({ phase: "connected", client: fixture.client });
      fixture.undo()!.click();
      await fixture.toast.updateComplete;
      expect(fixture.batches).toHaveLength(1);
      expect(fixture.gateway.setSessionKey).not.toHaveBeenCalled();
    } finally {
      fixture.pending.resolve({ outcomes: [] });
      fixture.page.remove();
      await modal.cleanup();
      fixture.sessions.dispose();
      fixture.toast.remove();
    }
  });
});
