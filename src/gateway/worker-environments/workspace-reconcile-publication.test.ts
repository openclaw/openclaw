import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import {
  applyStagedWorkerWorkspace,
  recoverWorkerWorkspaceReconciliation,
  type WorkerWorkspaceReconciliationJournal,
} from "./workspace-reconcile.js";
import {
  hasWorkerWorkspaceResultRef,
  preparedWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const workspaceWarning = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/worker-workspace"
        ? { ...logger, warn: workspaceWarning }
        : logger;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const read = (root: string, name = "result.txt") => fs.readFile(path.join(root, name));
afterEach(() => {
  workspaceWarning.mockReset();
  vi.unstubAllEnvs();
});

async function workspace(eol = "\n", added = false) {
  const root = tempDirs.make("publication-local-");
  const stagingRoot = tempDirs.make("publication-staged-");
  const baseBytes = Buffer.from(`base${eol}`);
  const workerBytes = Buffer.from(`worker${eol}`);
  const addedBytes = Buffer.from(`added${eol}`);
  await fs.writeFile(path.join(root, "result.txt"), baseBytes);
  await fs.writeFile(path.join(stagingRoot, "result.txt"), workerBytes);
  if (added) {
    await fs.writeFile(path.join(stagingRoot, "added.txt"), addedBytes);
  }
  const capture = (directory: string) =>
    captureWorkspaceManifest({ root: directory, baseCommit: null });
  const base = await capture(root);
  const current = await capture(stagingRoot);
  return {
    root,
    stagingRoot,
    baseBytes,
    workerBytes,
    addedBytes,
    base: base.manifest,
    current: current.manifest,
    baseManifestRef: base.manifestRef,
    currentManifestRef: current.manifestRef,
  };
}

function journalFixture(onCommit = async () => {}, onAbort = async () => {}) {
  let pending: WorkerWorkspaceReconciliationJournal | undefined;
  const settle = (before: () => Promise<void>) =>
    vi.fn(async () => {
      await before();
      pending = undefined;
    });
  const journal = {
    load: async () => pending,
    begin: async (value: WorkerWorkspaceReconciliationJournal) => {
      pending = value;
    },
    commit: settle(onCommit),
    abort: settle(onAbort),
  };
  return { journal, pending: () => pending };
}

it.each([
  ["true", "\n", "apply"],
  ["true", "\r\n", "apply"],
  ["input", "\n", "apply"],
  ["input", "\r\n", "apply"],
  ["false", "\n", "apply"],
  ["false", "\r\n", "apply"],
  ["false", "\n", "commit"],
  ["false", "\n", "reject"],
] as const)(
  "settles %s autocrlf publication with EOL=%j and failure at %s",
  async (autocrlf, eol, phase) => {
    const config = [
      ["core.autocrlf", autocrlf],
      ["core.eol", "crlf"],
      ["core.safecrlf", "true"],
    ];
    vi.stubEnv("GIT_CONFIG_COUNT", String(config.length));
    config.forEach(([key, value], index) => {
      vi.stubEnv(`GIT_CONFIG_KEY_${index}`, key);
      vi.stubEnv(`GIT_CONFIG_VALUE_${index}`, value);
    });
    const definitive = phase === "reject";
    const f = await workspace(eol, !definitive);
    const publicationFailure = definitive
      ? new Error("publication rejected")
      : new AcceptedWorkspacePublicationIndeterminateError(
          phase,
          new Error(`${phase} transport lost`),
        );
    const state = journalFixture(
      async () => {
        if (phase === "commit") {
          throw publicationFailure;
        }
      },
      async () => {
        if (definitive) {
          expect(await read(f.root)).toEqual(f.baseBytes);
        }
      },
    );
    const { journal } = state;
    await expect(
      applyStagedWorkerWorkspace({
        ...f,
        journal,
        acceptance: {
          kind: "reconcile",
          publish: async () => {
            if (phase !== "commit") {
              throw publicationFailure;
            }
          },
        },
      }),
    ).rejects.toBe(publicationFailure);
    if (definitive) {
      expect(state.pending()).toBeUndefined();
      expect(journal.abort).toHaveBeenCalledOnce();
      await expect(read(f.root)).resolves.toEqual(f.baseBytes);
      return;
    }
    expect(state.pending()).toBeDefined();
    expect(journal.commit).toHaveBeenCalledTimes(phase === "apply" ? 0 : 1);
    expect(journal.abort).not.toHaveBeenCalled();
    await expect(read(f.root)).resolves.toEqual(f.workerBytes);
    await expect(read(f.root, "added.txt")).resolves.toEqual(f.addedBytes);
    await recoverWorkerWorkspaceReconciliation({ root: f.root, journal: state.pending()! });
    await expect(read(f.root)).resolves.toEqual(f.baseBytes);
    await expect(fs.access(path.join(f.root, "added.txt"))).rejects.toThrow();
    expect(state.pending()).toBeDefined();
  },
);

it.each([
  ["preserves committed results and recovery refs when scratch cleanup fails", true, false],
  ["preserves publication failures and rollback when scratch cleanup fails", true, true],
  ["removes disposable scratch without warning when cleanup succeeds", false, false],
])("%s", async (_name, cleanupFails, publicationFails) => {
  const f = await workspace();
  const publicationError = new Error("accepted publication rejected");
  const cleanupError = new Error("scratch removal failed");
  const ref = workerWorkspaceResultRef("claim-staging-cleanup");
  const hasRef = (stagedResultRef: string) =>
    hasWorkerWorkspaceResultRef({ root: f.root, stagedResultRef });
  const candidateRef = preparedWorkerWorkspaceResultRef(ref);
  const record = vi.fn();
  const commit = vi.fn(async () => {});
  const abort = vi.fn(async () => {});
  const prepared = await workerWorkspaceResultStaging.prepareRequestedWorkerWorkspaceResult({
    request: {
      localPath: f.root,
      remoteWorkspaceDir: "/worker/workspace",
      baseManifestRef: f.baseManifestRef,
      journal: { load: async () => undefined, begin: async () => {}, commit, abort },
      stagedResult: { ref, record },
    },
    stagingRoot: f.stagingRoot,
    currentManifestRef: f.currentManifestRef,
    baseManifestRaw: serializeWorkerWorkspaceManifest(f.base),
    currentManifestRaw: serializeWorkerWorkspaceManifest(f.current),
    publishAcceptedManifest: async () => {
      if (publicationFails) {
        throw publicationError;
      }
    },
  });
  const remove = fs.rm;
  const scratch = tempDirs.make("openclaw-workspace-result-cleanup-scratch-");
  const makeScratch = vi.spyOn(fs, "mkdtemp").mockResolvedValueOnce(scratch);
  const removeSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
    if (target === scratch) {
      if (cleanupFails) {
        throw cleanupError;
      }
    }
    return await remove(target, options);
  });

  try {
    await expect(hasRef(candidateRef)).resolves.toBe(true);
    const finalized = verifyReconciledWorkspaceFinal(
      {
        ...prepared,
        manifestRef: f.currentManifestRef,
        changed: true,
        verifyStable: async () => {},
      },
      { assertActive: async () => {}, resume: async () => {} },
    );
    if (publicationFails) {
      await expect(finalized).rejects.toBe(publicationError);
      expect(abort).toHaveBeenCalledOnce();
    } else {
      await expect(finalized).resolves.toMatchObject({ manifestRef: f.currentManifestRef });
      expect(commit).toHaveBeenCalledOnce();
    }
    await expect(read(f.root)).resolves.toEqual(publicationFails ? f.baseBytes : f.workerBytes);
    await expect(hasRef(ref)).resolves.toBe(!publicationFails);
    await expect(hasRef(candidateRef)).resolves.toBe(false);
    expect(record).toHaveBeenCalledTimes(publicationFails ? 0 : 1);
    expect(workspaceWarning.mock.calls).toEqual(
      cleanupFails ? [["worker workspace staging cleanup failed: scratch removal failed"]] : [],
    );
    if (cleanupFails) {
      await fs.access(scratch);
    } else {
      await expect(fs.access(scratch)).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    makeScratch.mockRestore();
    removeSpy.mockRestore();
    await remove(scratch, { recursive: true, force: true });
  }
});
