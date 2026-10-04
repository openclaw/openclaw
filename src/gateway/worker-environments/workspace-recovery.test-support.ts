import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import type {
  WithPreparedWorkerWorkspaceRecovery,
  WorkerPlacementReclaimBarriers,
} from "./placement-reclaim-contract.js";
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
}): Pick<PlacementRecoveryDeps, "resolveWorkspace" | "withPreparedRecovery"> {
  const withPreparedRecovery: WithPreparedWorkerWorkspaceRecovery = async (
    { sessionId, sessionKey, agentId },
    assertCurrent,
    run,
  ) => {
    const identity = { sessionId, sessionKey, agentId };
    assertCurrent();
    const workspace = await options.resolveWorkspace(identity);
    assertCurrent();
    return await run({
      workspace,
      assertCurrent,
      resolveConflict: async () => {
        assertCurrent();
        const lookup = await options.resolveConflict?.(identity);
        assertCurrent();
        return lookup ?? { kind: "absent" };
      },
      reportConflict: async (report) => {
        assertCurrent();
        await options.reportConflict?.({ ...identity, ...report });
        assertCurrent();
      },
      reportFailure: async (error) => {
        assertCurrent();
        await options.reportFailure?.({ ...identity, error });
        assertCurrent();
      },
    });
  };
  return { resolveWorkspace: options.resolveWorkspace, withPreparedRecovery };
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
        entries.push({
          path: relative,
          type: "file",
          mode: (stats.mode & 0o111) === 0 ? 0o644 : 0o755,
          size: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
        });
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
  let pending: WorkerWorkspaceReconciliationJournal | undefined;
  return await applyStagedWorkerWorkspace({
    ...params,
    baseManifestRef: `sha256:${"a".repeat(64)}`,
    currentManifestRef: `sha256:${"b".repeat(64)}`,
    acceptance: { kind: "reconcile", publish: params.publishAcceptedManifest },
    journal: {
      load: async () => pending,
      begin: async (journal) => {
        pending = journal;
        await params.begin?.(journal);
      },
      commit: async (manifestRef) => {
        await params.commit?.(manifestRef);
        pending = undefined;
      },
      abort: async () => {
        await params.abort?.();
        pending = undefined;
      },
    },
  });
}
