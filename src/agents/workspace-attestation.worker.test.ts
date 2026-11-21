import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
} from "./workspace-state-store.js";
import { ensureAgentWorkspace, WORKSPACE_VANISHED_ERROR_CODE } from "./workspace.js";

const WORKSPACE_ATTESTATION_RECENT_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

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

it.each(["transaction", "commit"] as const)(
  "rolls back attestation when the owner retires at worker %s admission",
  async (stage) => {
    const input = {
      workspaceDir: state.workspaceDir,
      attestedAtMs: 1_000,
      nowMs: 1_000,
      generatedHashes: new Map([["AGENTS.md", "a".repeat(64)]]),
    };
    await replaceWorkspaceAttestation(input);
    const before = await readWorkspaceStateSnapshot(state.workspaceDir);
    let retired = false;
    probe.admission(workerAdmission, (request, grant, admit) => {
      retired ||= request.stage === stage;
      admit(request, grant);
    });
    const error = new Error("workspace owner retired");
    await expect(
      replaceWorkspaceAttestation({
        ...input,
        attestedAtMs: 2_000,
        nowMs: 2_000,
        generatedHashes: new Map([["SOUL.md", "b".repeat(64)]]),
        assertCurrent: () => {
          if (retired) {
            throw error;
          }
        },
      }),
    ).rejects.toBe(error);
    expect(retired).toBe(true);
    expect(await readWorkspaceStateSnapshot(state.workspaceDir)).toEqual(before);
  },
);

it("preserves disappearance protection across a restart within the coalesced refresh window", async () => {
  const startedAt = Date.now() - WORKSPACE_ATTESTATION_RECENT_MS;
  const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
  await fs.writeFile(path.join(state.workspaceDir, "AGENTS.md"), "Synthetic instructions.\n");
  await ensureAgentWorkspace({ dir: state.workspaceDir });
  const original = (await readWorkspaceStateSnapshot(state.workspaceDir)).attestation!;
  expect(original.attestedAtMs).toBe(startedAt);

  const refreshedAt = startedAt + WORKSPACE_ATTESTATION_RECENT_MS - 1;
  clock.mockReturnValue(refreshedAt);
  await ensureAgentWorkspace({ dir: state.workspaceDir });
  const refreshed = (await readWorkspaceStateSnapshot(state.workspaceDir)).attestation!;
  expect(refreshed.generatedHashes).toEqual(original.generatedHashes);
  expect(refreshed.attestedAtMs).toBe(refreshedAt);
  clock.mockReturnValue(refreshedAt + HOUR_MS / 2);
  await ensureAgentWorkspace({ dir: state.workspaceDir });
  expect((await readWorkspaceStateSnapshot(state.workspaceDir)).attestation).toEqual(refreshed);
  await closeOpenClawStateDatabaseAsync();
  await fs.rm(state.workspaceDir, { recursive: true });
  clock.mockReturnValue(refreshedAt + (3 * HOUR_MS) / 4);

  await expect(ensureAgentWorkspace({ dir: state.workspaceDir })).rejects.toMatchObject({
    code: WORKSPACE_VANISHED_ERROR_CODE,
  });
  await expect(fs.stat(state.workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
});

it("skips all workspace requests on unchanged populated warm turns until the attestation is over an hour old", async () => {
  const startedAt = Date.now() - 2 * HOUR_MS;
  const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
  await fs.writeFile(path.join(state.workspaceDir, "seed.txt"), "Synthetic workspace content.\n");
  await ensureAgentWorkspace({ dir: state.workspaceDir, ensureBootstrapFiles: false });
  // Populate the read cache after first creation promotes the database identity.
  await readWorkspaceStateSnapshot(state.workspaceDir);
  const commands: string[] = [];
  probe.command(stateWorker, (command, options, scope) => {
    commands.push(command.type);
    return scope.execute(command, options);
  });
  for (const elapsedMs of [1_000, HOUR_MS, HOUR_MS + 1, HOUR_MS + 2]) {
    clock.mockReturnValue(startedAt + elapsedMs);
    commands.length = 0;
    await ensureAgentWorkspace({ dir: state.workspaceDir, ensureBootstrapFiles: false });
    expect(commands).toEqual(elapsedMs === HOUR_MS + 1 ? ["workspace.replaceAttestation"] : []);
  }
  expect(
    (await readWorkspaceStateSnapshot(state.workspaceDir, { readOnly: true })).attestation
      ?.attestedAtMs,
  ).toBe(startedAt + HOUR_MS + 1);
});

it("persists changed generated hashes immediately within the refresh hour", async () => {
  const startedAt = Date.now() - HOUR_MS;
  const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
  await ensureAgentWorkspace({ dir: state.workspaceDir, ensureBootstrapFiles: true });
  const original = (await readWorkspaceStateSnapshot(state.workspaceDir)).attestation!;
  expect(original.generatedHashes.has("AGENTS.md")).toBe(true);

  await fs.writeFile(
    path.join(state.workspaceDir, "AGENTS.md"),
    "Customized synthetic instructions.\n",
  );
  clock.mockReturnValue(startedAt + 1_000);
  await ensureAgentWorkspace({ dir: state.workspaceDir, ensureBootstrapFiles: false });
  const updated = (await readWorkspaceStateSnapshot(state.workspaceDir, { readOnly: true }))
    .attestation!;
  expect(updated.attestedAtMs).toBe(startedAt + 1_000);
  expect(updated.generatedHashes.has("AGENTS.md")).toBe(false);
  expect(updated.generatedHashes.size).toBe(original.generatedHashes.size - 1);
});

it("does not synchronously inventory skills when a recent attestation prevents expiry", async () => {
  const skillDir = path.join(state.workspaceDir, "skills", "synthetic");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Synthetic skill\n");
  await ensureAgentWorkspace({ dir: state.workspaceDir, ensureBootstrapFiles: false });
  const lstat = vi.spyOn(syncFs, "lstatSync");
  const stat = vi.spyOn(syncFs, "statSync");
  await ensureAgentWorkspace({ dir: state.workspaceDir, ensureBootstrapFiles: false });
  const skillReads = [...lstat.mock.calls, ...stat.mock.calls].filter(([file]) =>
    String(file).startsWith(path.join(state.workspaceDir, "skills") + path.sep),
  );
  expect(skillReads).toHaveLength(0);
  await fs.rm(state.workspaceDir, { recursive: true });
  await expect(ensureAgentWorkspace({ dir: state.workspaceDir })).rejects.toMatchObject({
    code: WORKSPACE_VANISHED_ERROR_CODE,
  });
});
