import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { SandboxBackendHandle } from "../../agents/sandbox/backend-handle.types.js";
import { stagedInputDirectory, STAGED_INPUT_GITIGNORE } from "../../media/staged-inputs.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { localWorkspaceDigestBytes } from "./local-workspace-cas.js";
import { readLocalWorkspaceTree } from "./local-workspace-cas.kernel.js";
import type { LocalWorkspaceManifestCheckpoint } from "./local-workspace-manifest-scan.js";
import { withLocalWorkspaceProjection } from "./local-workspace-projection.js";
import * as workspaceStore from "./local-workspace-store.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";
import {
  observeLocalWorkspaceStoreSql,
  readLocalWorkspaceProjection,
} from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";
import { parseWorkerWorkspaceManifest } from "./workspace-manifest.js";

const prepare = (owner: LocalWorkspaceOwner) =>
  withLocalWorkspaceProjection(owner, (state) => state.prepare());
const synchronize = (owner: LocalWorkspaceOwner) =>
  withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
const writeText = (directory: string, relative: string, data: string) =>
  fs.writeFile(path.join(directory, relative), data);
const expectText = async (directory: string, relative: string, expected: string) =>
  expect(await fs.readFile(path.join(directory, relative), "utf8")).toBe(expected);
const expectMissing = async (directory: string, relative: string) =>
  expect(fs.stat(path.join(directory, relative))).rejects.toMatchObject({ code: "ENOENT" });

export function observeAcknowledgedUpdate(
  observe: (row: workspaceStore.LocalWorkspaceProjection) => void,
) {
  const withStore = workspaceStore.withLocalWorkspaceStore;
  return vi.spyOn(workspaceStore, "withLocalWorkspaceStore").mockImplementation((params, run) =>
    withStore(params, (store) =>
      run({
        ...store,
        update: async (row, patch, authority, manifest) => {
          const acknowledged = await store.update(row, patch, authority, manifest);
          observe(acknowledged);
          return acknowledged;
        },
      }),
    ),
  );
}

async function proveAcceptedResultPreparation(
  owner: LocalWorkspaceOwner,
  projection: string,
  legacy: boolean,
) {
  const pendingRef = (await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref;
  const preservedProjection = projection + "-preserved";
  await fs.rename(projection, preservedProjection);
  try {
    await expect(prepare(owner)).rejects.toThrow();
    expect((await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref).toBe(pendingRef);
  } finally {
    await fs.rename(preservedProjection, projection);
  }
  if (legacy) {
    const document = await withLocalWorkspaceProjection(owner, (state) => state.baselineDocument());
    await withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async (store) => {
      await store.update(store.get()!, {
        baseline_json: document.rawManifest,
        baseline_ref: document.manifestRef,
      });
    });
  }
}

export async function proveWorkerOwnedIncrementalWorkspace(owner: LocalWorkspaceOwner) {
  using cleanup = new DisposableStack();
  const sql = observeLocalWorkspaceStoreSql();
  cleanup.defer(sql.restore);
  sql.calibrate();
  const projection = await prepare(owner);
  await writeText(projection, "source.txt", "worker-persisted edit\n");
  const readFastState = () =>
    Promise.all([
      executeExistingOpenClawStateRead(
        {},
        { type: "config.health.read", input: undefined },
        { current: true, live: true },
      ),
      executeExistingOpenClawStateRead(
        {},
        { type: "subagents.runs", scope: { kind: "ids", runIds: ["synthetic-missing-run"] } },
        { current: true, live: true },
      ),
      executeExistingOpenClawStateRead(
        {},
        { type: "deliveryQueue.outbound", mode: "pending" },
        { current: true, live: true },
      ),
    ]);
  const expectedReads = await readFastState();
  expect(expectedReads.map((reply) => reply?.type)).toEqual([
    "config.health.read",
    "subagents.runs",
    "deliveryQueue.outbound",
  ]);
  let synchronized = false;
  const synchronizing = synchronize(owner).finally(() => {
    synchronized = true;
  });
  const reading = (async () => {
    for (;;) {
      expect(await readFastState()).toEqual(expectedReads);
      if (synchronized) {
        return;
      }
    }
  })();
  // Drain both owners on failure before the fixture can delete its workspace.
  await Promise.allSettled([synchronizing, reading]);
  await synchronizing;
  await reading;
  await expectText(owner.worktree.path, "source.txt", "worker-persisted edit\n");
  await withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async (store) => {
    expect(store.get()!.baseline_json).toBeNull();
    const baseline = await store.manifest(store.get()!, { kind: "materialize" });
    expect(baseline.kind).toBe("materialize");
    if (baseline.kind !== "materialize") {
      throw new Error("Expected complete baseline at the publication boundary");
    }
    const manifest = parseWorkerWorkspaceManifest(baseline.rawManifest, baseline.manifestRef);
    expect(manifest.entries.find((entry) => entry.path === "source.txt")).toMatchObject({
      type: "file",
      sha256: createHash("sha256").update("worker-persisted edit\n").digest("hex"),
    });
  });
  sql.expectIdle();
}

export async function proveIncrementalWorkspaceEdits(owner: LocalWorkspaceOwner) {
  const canonical = owner.worktree.path;
  const projection = await prepare(owner);
  await writeText(projection, "rename.txt", "rename me\n");
  await writeText(projection, "delete.txt", "delete me\n");
  await synchronize(owner);
  const previous = (await readLocalWorkspaceProjection(owner.worktree.id))!.baseline_ref;
  const before = await fs.stat(path.join(projection, "source.txt"));
  // Size and mtime are identical; ctime must invalidate the persisted hash.
  await writeText(projection, "source.txt", "modified\n");
  await fs.utimes(path.join(projection, "source.txt"), before.atime, before.mtime);
  await fs.rename(path.join(projection, "rename.txt"), path.join(projection, "renamed.txt"));
  await fs.chmod(path.join(projection, "renamed.txt"), 0o755);
  await fs.unlink(path.join(projection, "delete.txt"));
  await fs.symlink("source.txt", path.join(projection, "link"));
  await closeOpenClawStateDatabaseAsync();
  await synchronize(owner);
  await expectText(canonical, "source.txt", "modified\n");
  await expectText(canonical, "renamed.txt", "rename me\n");
  await expectMissing(canonical, "rename.txt");
  await expectMissing(canonical, "delete.txt");
  expect((await fs.stat(path.join(canonical, "renamed.txt"))).mode & 0o111).not.toBe(0);
  expect(await fs.readlink(path.join(canonical, "link"))).toBe("source.txt");
  expect(await readLocalWorkspaceProjection(owner.worktree.id)).toMatchObject({
    baseline_json: null,
    checkpoint_json: null,
    pending_ref: null,
  });
  expect((await readLocalWorkspaceProjection(owner.worktree.id))!.baseline_ref).not.toBe(previous);
  await prepare(owner);
  await expectText(projection, "source.txt", "modified\n");
}

export async function proveStagedInputCheckpointOwnership(owner: LocalWorkspaceOwner) {
  const projection = await prepare(owner);
  const directory = stagedInputDirectory(randomUUID());
  await fs.mkdir(path.join(projection, directory, "node_modules"), { recursive: true });
  await writeText(projection, `${directory}/.gitignore`, STAGED_INPUT_GITIGNORE);
  const input = `${directory}/node_modules/input.txt`;
  await writeText(projection, input, "first input\n");
  await synchronize(owner);
  await writeText(projection, input, "edited input\n");
  await synchronize(owner);
  await expectText(owner.worktree.path, input, "edited input\n");
  await prepare(owner);
  await expectText(projection, input, "edited input\n");
}

export async function proveSharedSandboxCheckpoints(
  owner: LocalWorkspaceOwner,
  signal: AbortSignal,
) {
  const [projectionOwner, { prepareLocalSandboxWorkspace }, { resolveSandboxConfigForAgent }] =
    await Promise.all([
      import("./local-workspace-projection.js"),
      import("../../agents/sandbox/local-workspace.js"),
      import("../../agents/sandbox/config.js"),
    ]);
  let joinedAuthorityRevoked = false;
  vi.spyOn(projectionOwner, "resolveLocalWorkspaceOwner")
    .mockResolvedValueOnce({ ...owner, [Symbol.dispose]() {} })
    .mockResolvedValueOnce({
      ...owner,
      workerAuthority: {
        ...owner.workerAuthority,
        assertCurrent: () => {
          owner.workerAuthority?.assertCurrent?.();
          if (joinedAuthorityRevoked) {
            throw new Error("Joined checkpoint authority revoked");
          }
        },
      },
      [Symbol.dispose]() {},
    });
  const preparation = {
    cfg: { worktreeAcceleration: false },
    agentId: owner.agentId,
    sessionKey: owner.sessionKey,
    workspaceDir: owner.worktree.path,
    sandbox: resolveSandboxConfigForAgent({}, owner.agentId),
  };
  using first = await prepareLocalSandboxWorkspace(preparation);
  using second = await prepareLocalSandboxWorkspace(preparation);
  if (!first || !second) {
    throw new Error("Expected managed projections");
  }
  const withStore = workspaceStore.withLocalWorkspaceStore;
  let scans = 0;
  let beforeRun: (() => Promise<void>) | undefined;
  let afterScan: (() => Promise<void>) | undefined;
  vi.spyOn(workspaceStore, "withLocalWorkspaceStore").mockImplementation((params, run) =>
    withStore(params, async (store) => {
      await beforeRun?.();
      return await run({
        ...store,
        manifest: async (row, action) => {
          const result = await store.manifest(row, action);
          if (action.kind === "scan" && action.target === "canonical") {
            scans++;
            await afterScan?.();
          }
          return result;
        },
      });
    }),
  );
  for (const phase of ["waiting", "captured", "revoked"] as const) {
    const entered = createDeferred();
    const released = createDeferred();
    const pause = async () => {
      beforeRun = undefined;
      afterScan = undefined;
      entered.resolve();
      await released.promise;
    };
    beforeRun = phase !== "captured" ? pause : undefined;
    afterScan = phase === "captured" ? pause : undefined;
    scans = 0;
    if (phase === "waiting") {
      await writeText(first.workspaceDir, "source.txt", "shared checkpoint\n");
    }
    const initial = first.checkpoint();
    let later: Promise<void> | undefined;
    let results: PromiseSettledResult<void | undefined>[];
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, initial, "Checkpoint did not reach its gate"),
        signal,
      );
      if (phase === "captured") {
        await writeText(second.workspaceDir, "late.txt", "write after capture\n");
      }
      later = second.checkpoint();
      joinedAuthorityRevoked = phase === "revoked";
    } finally {
      released.resolve();
      results = await Promise.allSettled([initial, later]);
      joinedAuthorityRevoked = false;
    }
    expect(results[0]).toEqual({ status: "fulfilled", value: undefined });
    expect(results[1]).toEqual(
      phase === "revoked"
        ? { status: "rejected", reason: new Error("Joined checkpoint authority revoked") }
        : { status: "fulfilled", value: undefined },
    );
    expect.soft(scans).toBe(phase === "captured" ? 2 : 1);
    await expectText(owner.worktree.path, "source.txt", "shared checkpoint\n");
    if (phase === "captured") {
      await expectText(owner.worktree.path, "late.txt", "write after capture\n");
    }
  }
}

export async function proveSandboxMutationCheckpoints(owner: LocalWorkspaceOwner) {
  const [
    projectionOwner,
    { prepareLocalSandboxWorkspace, bindLocalSandboxWorkspace },
    { resolveSandboxConfigForAgent },
    { createSandboxTestContext },
    { createHostSandboxFsBridge },
    { createSandboxedWriteTool },
    { createApplyPatchTool },
  ] = await Promise.all([
    import("./local-workspace-projection.js"),
    import("../../agents/sandbox/local-workspace.js"),
    import("../../agents/sandbox/config.js"),
    import("../../agents/sandbox/test-fixtures.js"),
    import("../../agents/test-helpers/host-sandbox-fs-bridge.js"),
    import("../../agents/agent-tools.read.js"),
    import("../../agents/apply-patch.js"),
  ]);
  vi.spyOn(projectionOwner, "resolveLocalWorkspaceOwner").mockResolvedValue({
    ...owner,
    [Symbol.dispose]() {},
  });
  using projection = await prepareLocalSandboxWorkspace({
    cfg: { worktreeAcceleration: false },
    agentId: owner.agentId,
    sessionKey: owner.sessionKey,
    workspaceDir: owner.worktree.path,
    sandbox: resolveSandboxConfigForAgent({}, owner.agentId),
  });
  if (!projection) {
    throw new Error("Expected managed projection");
  }
  const backend: SandboxBackendHandle = {
    id: "docker",
    runtimeId: "file-checkpoint-fixture",
    runtimeLabel: "file-checkpoint-fixture",
    workdir: "/workspace",
    buildExecSpec: async () => {
      throw new Error("Unexpected command execution");
    },
    runShellCommand: async () => {
      throw new Error("Unexpected shell execution");
    },
  };
  const bridge = createHostSandboxFsBridge(projection.workspaceDir);
  const sandbox = createSandboxTestContext({
    overrides: { workspaceDir: projection.workspaceDir, backend, fsBridge: bridge },
  });
  bindLocalSandboxWorkspace(sandbox, projection);
  const write = createSandboxedWriteTool({ root: projection.workspaceDir, bridge });
  const patch = createApplyPatchTool({
    cwd: projection.workspaceDir,
    sandbox: {
      root: projection.workspaceDir,
      bridge,
      workspaceMounts: bridge.pathMappings,
    },
  });
  const withStore = workspaceStore.withLocalWorkspaceStore;
  const scans: string[] = [];
  vi.spyOn(workspaceStore, "withLocalWorkspaceStore").mockImplementation((params, run) =>
    withStore(params, (store) =>
      run({
        ...store,
        manifest: async (row, action) => {
          if (action.kind === "scan") {
            scans.push(action.target);
          }
          return await store.manifest(row, action);
        },
      }),
    ),
  );
  await write.execute("nested-write", { path: "written/nested/file.txt", content: "written\n" });
  await expectText(owner.worktree.path, "written/nested/file.txt", "written\n");
  expect.soft(scans).toEqual(["canonical"]);
  scans.length = 0;

  // Guest writes do not advance the database revision: the next caller must capture them.
  await writeText(projection.workspaceDir, "source.txt", "fresh guest edit\n");
  await patch.execute("nested-patch", {
    input: "*** Begin Patch\n*** Add File: patched/nested/file.txt\n+patched\n*** End Patch",
  });
  await expectText(owner.worktree.path, "source.txt", "fresh guest edit\n");
  await expectText(owner.worktree.path, "patched/nested/file.txt", "patched\n");
  await expectText(owner.worktree.path, "written/nested/file.txt", "written\n");
  expect.soft(scans).toEqual(["canonical"]);
  expect(await readLocalWorkspaceProjection(owner.worktree.id)).toMatchObject({
    pending_ref: null,
    pending_target: null,
    journal_json: null,
  });
}

function restoreV31CheckpointLayout(
  owner: LocalWorkspaceOwner,
  pending: workspaceStore.LocalWorkspaceProjection,
): void {
  const database = openOpenClawStateDatabase();
  const baseline = readLocalWorkspaceTree(database.db, pending.tree_root_digest!);
  const {
    treeRoot,
    previousTreeRoot: _previousTreeRoot,
    fingerprints: _fingerprints,
    ...checkpoint
  } = JSON.parse(pending.checkpoint_json!) as LocalWorkspaceManifestCheckpoint;
  const resulting = readLocalWorkspaceTree(database.db, localWorkspaceDigestBytes(treeRoot!));
  // Recreate the released v31 layout around the actual interrupted receipt.
  // Recovery must convert this projection online before staging and accepting its edits.
  for (const record of baseline.values()) {
    database.db
      .prepare(
        "INSERT INTO local_workspace_manifest_nodes (worktree_id, path, node_json) VALUES (?, ?, ?)",
      )
      .run(owner.worktree.id, record.node.path, JSON.stringify(record));
  }
  database.db
    .prepare(`UPDATE local_workspace_projections
    SET tree_root_digest = NULL, source_paths_digest = NULL,
      canonical_fingerprints = NULL, projection_fingerprints = NULL,
      source_paths_json = ?, checkpoint_json = ? WHERE worktree_id = ?`)
    .run(
      pending.source_paths_json,
      JSON.stringify({ ...checkpoint, records: [...resulting.values()] }),
      owner.worktree.id,
    );
}

export async function prepareLocalWorkspaceArchiveFixture(
  owner: LocalWorkspaceOwner,
  provisionedPaths: string[] = [],
) {
  const [registry, { ManagedWorktreeService, SNAPSHOT_RETENTION_MS }] = await Promise.all([
    import("../../agents/worktrees/registry.js"),
    import("../../agents/worktrees/service.js"),
  ]);
  const service = new ManagedWorktreeService();
  owner.worktree.repoFingerprint = (
    await service.resolveRepositoryIdentity(owner.worktree.path)
  ).fingerprint;
  await registry.insertRegistryWorktree(process.env, owner.worktree, { provisionedPaths });
  return { service, registry, retentionMs: SNAPSHOT_RETENTION_MS };
}

export async function proveInterruptedWorkspaceCheckpoint(
  owner: LocalWorkspaceOwner,
  phase: string,
  setRevoked: (value: boolean) => void,
) {
  const projection = await prepare(owner);
  let edit = "interrupted guest edit\n";
  const accepted = phase.endsWith("accepted-result cleanup");
  const reserved =
    phase === "reservation" ||
    (phase.startsWith("v31 ") && phase !== "v31 rejected staged conversion");
  await writeText(projection, "source.txt", edit);
  const acknowledgement =
    accepted || reserved
      ? observeAcknowledgedUpdate((row) => {
          if (row.pending_ref && (reserved || row.pending_target === null)) {
            setRevoked(true);
          }
        })
      : undefined;
  const interrupted = {
    ...owner,
    assertCurrent: () => {
      if (
        !accepted &&
        !reserved &&
        readFileSync(path.join(owner.worktree.path, "source.txt"), "utf8") === edit
      ) {
        setRevoked(true);
      }
      owner.assertCurrent();
    },
  };
  await expect(
    withLocalWorkspaceProjection(interrupted, (state) => state.synchronize("canonical")),
  ).rejects.toThrow(accepted ? "revoked" : undefined);
  acknowledgement?.mockRestore();
  if (accepted) {
    expect(await readLocalWorkspaceProjection(owner.worktree.id)).toMatchObject({
      pending_ref: expect.any(String),
      pending_target: null,
      journal_json: null,
    });
    await writeText(owner.worktree.path, "source.txt", "later human edit\n");
  } else {
    const pending = await readLocalWorkspaceProjection(owner.worktree.id);
    expect(pending?.pending_ref).toBeTruthy();
    expect(pending?.checkpoint_json).toBeTruthy();
    if (reserved) {
      expect(pending?.journal_json).toBeNull();
      edit = "guest edit after interrupted reservation\n";
      await writeText(projection, "source.txt", edit);
    } else {
      expect(pending?.journal_json).toBeTruthy();
    }
  }
  setRevoked(false);
  if (phase.startsWith("v31 ")) {
    restoreV31CheckpointLayout(owner, (await readLocalWorkspaceProjection(owner.worktree.id))!);
    if (phase.startsWith("v31 rejected")) {
      openOpenClawStateDatabase()
        .db.prepare(`UPDATE local_workspace_manifest_nodes
        SET node_json = json_set(node_json, '$.node.sha256', ?)
        WHERE worktree_id = ? AND path = 'source.txt'`)
        .run("f".repeat(64), owner.worktree.id);
    }
  }
  if (accepted) {
    await proveAcceptedResultPreparation(
      owner,
      projection,
      phase === "legacy accepted-result cleanup",
    );
  }
  closeOpenClawStateDatabase();
  await withLocalWorkspaceProjection(owner, (state) => state.settle());
  await expectText(owner.worktree.path, "source.txt", accepted ? "later human edit\n" : edit);
  if (phase.startsWith("v31 rejected")) {
    await withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async (store) => {
      const baseline = await store.manifest(store.get()!, { kind: "materialize" });
      expect(baseline.kind).toBe("materialize");
      if (baseline.kind === "materialize") {
        expect(JSON.parse(baseline.rawManifest).entries).toContainEqual(
          expect.objectContaining({ path: ".gitignore" }),
        );
      }
    });
  }
  expect(await readLocalWorkspaceProjection(owner.worktree.id)).toMatchObject({
    journal_json: null,
    pending_ref: null,
    checkpoint_json: null,
    baseline_json: null,
  });
}
