import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
  WORKSPACE_ATTESTATION_RECENT_MS,
} from "./workspace-state-store.js";
import { ensureAgentWorkspace, WORKSPACE_VANISHED_ERROR_CODE } from "./workspace.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "workspace-attestation-" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

it("commits captured attestations without main-thread SQL on cold and warm writes", async () => {
  const sql = observeMainThreadSql();
  try {
    for (const attestedAtMs of [1_000, 2_000]) {
      const generatedHashes = new Map([["AGENTS.md", "a".repeat(64)]]);
      const write = replaceWorkspaceAttestation({
        workspaceDir: state.workspaceDir,
        attestedAtMs,
        nowMs: attestedAtMs,
        generatedHashes,
      });
      generatedHashes.set("AGENTS.md", "b".repeat(64));
      expect(await write).toEqual({
        attestedAtMs,
        generatedHashes: new Map([["AGENTS.md", "a".repeat(64)]]),
      });
    }
    sql.expectIdle();
  } finally {
    sql.restore();
  }
  expect((await readWorkspaceStateSnapshot(state.workspaceDir)).attestation).toEqual({
    attestedAtMs: 2_000,
    generatedHashes: new Map([["AGENTS.md", "a".repeat(64)]]),
  });
});

it.each(
  (["attestation", "alias"] as const).flatMap((operation) =>
    (["transaction", "commit"] as const).map((stage) => ({ operation, stage })),
  ),
)(
  "rolls back $operation when the owner retires at worker $stage admission",
  async ({ operation, stage }) => {
    const input = {
      workspaceDir: state.workspaceDir,
      attestedAtMs: 1_000,
      nowMs: 1_000,
      generatedHashes: new Map([["AGENTS.md", "a".repeat(64)]]),
    };
    await replaceWorkspaceAttestation(input);
    const before = await readWorkspaceStateSnapshot(state.workspaceDir);
    const alias = state.path("workspace-link");
    await fs.symlink(state.workspaceDir, alias, process.platform === "win32" ? "junction" : "dir");
    const originalAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    let retired = false;
    vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        originalAdmission((request, grant) => {
          retired ||= request.stage === stage;
          admit(request, grant);
        }, attachment),
    );
    const error = new Error("workspace owner retired");
    const assertCurrent = () => {
      if (retired) {
        throw error;
      }
    };
    await expect(
      operation === "alias"
        ? readWorkspaceStateSnapshot(alias, { assertCurrent })
        : replaceWorkspaceAttestation({
            ...input,
            attestedAtMs: 2_000,
            nowMs: 2_000,
            generatedHashes: new Map([["SOUL.md", "b".repeat(64)]]),
            assertCurrent,
          }),
    ).rejects.toBe(error);
    expect(retired).toBe(true);
    expect(await readWorkspaceStateSnapshot(state.workspaceDir)).toEqual(before);
    expect(
      openOpenClawStateDatabase()
        .db.prepare("SELECT alias_key FROM workspace_path_aliases WHERE alias_path = ?")
        .get(alias),
    ).toBeUndefined();
  },
);

it("refreshes unchanged hashes so disappearance protection survives a database restart", async () => {
  const startedAt = Date.now() - WORKSPACE_ATTESTATION_RECENT_MS;
  const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
  await fs.writeFile(path.join(state.workspaceDir, "AGENTS.md"), "Synthetic instructions.\n");
  await ensureAgentWorkspace({ dir: state.workspaceDir });
  const original = (await readWorkspaceStateSnapshot(state.workspaceDir)).attestation!;
  expect(original.attestedAtMs).toBe(startedAt);

  const refreshedAt = startedAt + WORKSPACE_ATTESTATION_RECENT_MS - 1;
  clock.mockReturnValue(refreshedAt);
  const sql = observeMainThreadSql();
  try {
    await ensureAgentWorkspace({ dir: state.workspaceDir });
    sql.expectIdle();
  } finally {
    sql.restore();
  }
  const refreshed = (await readWorkspaceStateSnapshot(state.workspaceDir)).attestation!;
  expect(refreshed.generatedHashes).toEqual(original.generatedHashes);
  expect(refreshed.attestedAtMs).toBe(refreshedAt);
  await closeOpenClawStateDatabaseAsync();
  await fs.rm(state.workspaceDir, { recursive: true });
  clock.mockReturnValue(startedAt + WORKSPACE_ATTESTATION_RECENT_MS + 1);

  await expect(ensureAgentWorkspace({ dir: state.workspaceDir })).rejects.toMatchObject({
    code: WORKSPACE_VANISHED_ERROR_CODE,
  });
  await expect(fs.stat(state.workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
});
