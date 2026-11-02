import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import type { PlacementStore } from "./placement-dispatch-test-fixtures.js";
import type { WorkerPlacementReclaimBarriers } from "./placement-reclaim-contract.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";
import type { PlacementRecoveryDeps } from "./placement-recovery-contract.js";
import type {
  WorkerWorkspaceConflictReport,
  WorkspaceResultConflictLookup,
} from "./workspace-conflicts.js";
import type {
  WorkerWorkspaceManifest,
  WorkerWorkspaceManifestEntry,
  WorkerWorkspaceReconciliationJournal,
} from "./workspace-manifest.js";

export type WorkerWorkspaceRecoveryFailureReport = WorkerSessionPlacementIdentity & {
  error: string;
};

export const runReclaimPreparation: WorkerPlacementReclaimBarriers["runReclaimPreparation"] =
  async ({ run, authorize, pendingOperations }) => {
    await pendingOperations?.settled;
    return await run(authorize);
  };

export function createWorkerWorkspaceRecoveryFixture(options: {
  resolveWorkspace: PlacementRecoveryDeps["resolveWorkspace"];
  resolveConflict?: (
    identity: WorkerSessionPlacementIdentity,
  ) => Promise<WorkspaceResultConflictLookup>;
  reportConflict?: (
    report: WorkerSessionPlacementIdentity & WorkerWorkspaceConflictReport,
  ) => Promise<void>;
  reportFailure?: (report: WorkerWorkspaceRecoveryFailureReport) => Promise<void>;
  reportNote?: (report: WorkerSessionPlacementIdentity & { note: string }) => Promise<void>;
}): Pick<PlacementRecoveryDeps, "resolveWorkspace" | "withPreparedRecovery"> {
  return {
    resolveWorkspace: options.resolveWorkspace,
    withPreparedRecovery: async ({ sessionId, sessionKey, agentId }, assertCurrent, run) => {
      const identity = { sessionId, sessionKey, agentId };
      const guarded = async <T>(action: () => T | Promise<T>): Promise<T> => {
        assertCurrent();
        const result = await action();
        assertCurrent();
        return result;
      };
      assertCurrent();
      const workspace = await options.resolveWorkspace(identity);
      assertCurrent();
      return await run({
        workspace,
        assertCurrent,
        resolveConflict: () =>
          guarded<WorkspaceResultConflictLookup>(
            () => options.resolveConflict?.(identity) ?? { kind: "absent" },
          ),
        reportConflict: (report) =>
          guarded(() => options.reportConflict?.({ ...identity, ...report })),
        reportFailure: (error) => guarded(() => options.reportFailure?.({ ...identity, error })),
        reportNote: (note) => guarded(() => options.reportNote?.({ ...identity, note })),
      });
    },
  };
}

type WorkspaceFiles = Record<string, string | Uint8Array>;
const digest = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex");
const fileEntry = (
  entryPath: string,
  content: Uint8Array,
  mode = 0o644,
): WorkerWorkspaceManifestEntry => ({
  path: entryPath,
  type: "file",
  mode,
  size: content.length,
  sha256: digest(content),
});

export async function writeWorkspaceFiles(root: string, files: WorkspaceFiles) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

export async function expectWorkspaceFiles(root: string, files: WorkspaceFiles) {
  for (const [relative, content] of Object.entries(files)) {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    await expect(fs.readFile(path.join(root, relative))).resolves.toEqual(bytes);
  }
}

export async function gitInit(root: string): Promise<void> {
  const { runCommandWithTimeout } = await import("../../process/exec.js");
  const result = await runCommandWithTimeout(["git", "-C", root, "init", "--quiet"], {
    timeoutMs: 10_000,
  });
  expect(result.code).toBe(0);
}

export async function manifestFor(root: string): Promise<WorkerWorkspaceManifest> {
  const entries: WorkerWorkspaceManifestEntry[] = [];
  const directories: string[] = [];
  const walk = async (relativeDirectory: string) => {
    for (const name of (await fs.readdir(path.join(root, relativeDirectory))).toSorted()) {
      if (!relativeDirectory && name === ".git") {
        continue;
      }
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const absolute = path.join(root, relative);
      const stats = await fs.lstat(absolute);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        directories.push(relative);
        await walk(relative);
      } else if (stats.isSymbolicLink()) {
        entries.push({
          path: relative,
          type: "symlink",
          mode: 0o777,
          target: await fs.readlink(absolute),
        });
      } else {
        const content = await fs.readFile(absolute);
        entries.push(fileEntry(relative, content, (stats.mode & 0o111) === 0 ? 0o644 : 0o755));
      }
    }
  };
  await walk("");
  return { version: 1, baseCommit: null, entries, directories };
}

export async function applyWorkspace(params: {
  root: string;
  stagingRoot: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
  begin?: (journal: WorkerWorkspaceReconciliationJournal) => void | Promise<void>;
  commit?: (manifestRef: string) => void | Promise<void>;
  abort?: () => void | Promise<void>;
  publishAcceptedManifest?: (accepted: {
    manifestRef: string;
    manifest: WorkerWorkspaceManifest;
    conflictPaths: string[];
  }) => Promise<void>;
}) {
  const { applyStagedWorkerWorkspace } = await import("./workspace-reconcile-apply.js");
  return await applyStagedWorkerWorkspace({
    ...params,
    baseManifestRef: `sha256:${"a".repeat(64)}`,
    currentManifestRef: `sha256:${"b".repeat(64)}`,
    acceptance: { kind: "reconcile", publish: params.publishAcceptedManifest },
    journal: {
      load: async () => undefined,
      begin: async (journal) => params.begin?.(journal),
      commit: async (manifestRef) => params.commit?.(manifestRef),
      abort: async () => params.abort?.(),
    },
  });
}

export async function stagePendingWorkerWorkspaceResult(params: {
  store: PlacementStore;
  claim: Awaited<ReturnType<PlacementStore["claimTurn"]>>;
  workspacePath: string;
  base?: string;
  current: string;
  record?: boolean;
  stagedResultRef?: string;
}): Promise<{ baseManifestRef: string; currentManifestRef: string; stagedResultRef: string }> {
  await fs.mkdir(params.workspacePath, { recursive: true });
  await gitInit(params.workspacePath);
  const { workerWorkspaceResultRef, workerWorkspaceResultStaging } =
    await import("./workspace-result-staging.js");
  const { stageWorkerWorkspaceResult } = workerWorkspaceResultStaging;
  const payload = path.join(params.workspacePath, ".staged-payload");
  await fs.mkdir(payload);
  await fs.writeFile(path.join(payload, "result.txt"), params.current);
  if (params.base !== undefined) {
    await fs.writeFile(path.join(params.workspacePath, "result.txt"), params.base);
  }
  const encode = (content: string | undefined) => {
    const raw = JSON.stringify({
      version: 1,
      baseCommit: null,
      entries: content === undefined ? [] : [fileEntry("result.txt", Buffer.from(content))],
    });
    return { raw, ref: `sha256:${digest(raw)}` };
  };
  const base = encode(params.base);
  const current = encode(params.current);
  await params.store.updateWorkspaceBaseManifest({ claim: params.claim, manifestRef: base.ref });
  await params.store.markWorkspaceResultPending(params.claim);
  const stagedResultRef = params.stagedResultRef ?? workerWorkspaceResultRef(params.claim.claimId);
  await stageWorkerWorkspaceResult({
    root: params.workspacePath,
    stagingRoot: payload,
    stagedResultRef,
    baseManifestRef: base.ref,
    currentManifestRef: current.ref,
    baseManifestRaw: base.raw,
    currentManifestRaw: current.raw,
  });
  if (params.record !== false) {
    await params.store.recordStagedWorkspaceResult(params.claim, stagedResultRef);
  }
  await fs.rm(payload, { recursive: true, force: true });
  return { baseManifestRef: base.ref, currentManifestRef: current.ref, stagedResultRef };
}
