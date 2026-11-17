import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../../infra/sqlite-worker-contract.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";
import {
  localWorkspaceProjectionFixture,
  readLocalWorkspaceProjection,
} from "./local-workspace-store.test-support.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
afterEach(() => vi.restoreAllMocks());

it("recovers an oversized committed row after reply loss without replaying or trimming bytes", async () => {
  const root = dirs.make("openclaw-local-workspace-transfer-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const worktreeId = randomUUID();
  await withLocalWorkspaceStore({ worktreeId, env }, (store) =>
    store.create(localWorkspaceProjectionFixture(worktreeId, root)),
  );
  const baseline = JSON.stringify({ synthetic: "x".repeat(SQLITE_WORKER_MAX_MESSAGE_BYTES / 4) });
  const journalPack = Buffer.alloc(1024, 7);
  const publicationPack = new Uint8Array(journalPack);
  let writes = 0;
  let retainedGuard: (() => void) | undefined;
  const lostReply = probe.command(stateWorker, async (command, executeOptions, scope) => {
    const result = await scope.execute(command, executeOptions);
    if (command.type === "localWorkspace.mutate") {
      writes += 1;
      throw new Error("Synthetic local workspace reply lost after native commit");
    }
    return result;
  });
  const acknowledged = await withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
    retainedGuard = store.assertCurrent;
    const row = await store.update(
      { ...store.get()!, base_commit: "f".repeat(40) },
      {
        baseline_ref: "sha256:oversized",
        baseline_json: baseline,
        journal_json: "{}",
        journal_pack: journalPack,
        paused_runtimes_json: undefined,
      },
      undefined,
      undefined,
      publicationPack,
    );
    expect(store.get()).toEqual(row);
    return row;
  });
  lostReply.mockRestore();
  expect(writes).toBe(1);
  assert(retainedGuard);
  expect(retainedGuard).toThrow();
  const committed = await readLocalWorkspaceProjection(worktreeId, env);
  expect(acknowledged).toMatchObject({
    revision: 1,
    baseline_ref: "sha256:oversized",
    base_commit: "a".repeat(40),
    journal_json: "{}",
    paused_runtimes_json: null,
  });
  expect(acknowledged.baseline_json).toBe(baseline);
  // Keep the worker's plain byte-view shape without another main-thread copy.
  expect(publicationPack.byteLength).toBe(0);
  expect(journalPack).toEqual(Buffer.alloc(1024, 7));
  expect(acknowledged.journal_pack?.constructor).toBe(Uint8Array);
  expect(acknowledged.journal_pack?.buffer).toBe(journalPack.buffer);
  expect(acknowledged.journal_pack?.byteOffset).toBe(journalPack.byteOffset);
  expect(acknowledged.journal_pack?.byteLength).toBe(journalPack.byteLength);
  expect(committed).toEqual(acknowledged);
  expect(committed?.baseline_json).toBe(baseline);
});
