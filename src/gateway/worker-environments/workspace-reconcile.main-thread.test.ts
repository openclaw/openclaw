import { randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { useWorkspaceFilesystemBlock } from "../../../test/helpers/workspace-filesystem-block.js";
import { captureWorkspaceFilesystemEvidence } from "../../agents/workspace-state-guard.js";
import {
  DEFAULT_WORKER_PENDING_BYTES,
  getWorkerComputeCapacity,
} from "../../infra/worker-task-capacity.js";
import { createDeferredCore as createDeferred } from "../../shared/deferred.js";
import { prepareWorkspaceReconciliation } from "./workspace-manifest-comparison.js";
import * as manifestWorker from "./workspace-manifest-worker.js";
import type { WorkerWorkspaceReconciliationJournal } from "./workspace-manifest.js";
import { applyStagedWorkerWorkspace } from "./workspace-reconcile-apply.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile-recovery.js";
import { manifestFor } from "./workspace-recovery.test-support.js";

const filesystemBlock = useWorkspaceFilesystemBlock();
const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture(
  before: string | Uint8Array = "before",
  after: string | Uint8Array = "after",
) {
  const root = temporary.make("reconcile-main-thread-");
  const staged = temporary.make("reconcile-main-thread-staged-");
  await fs.mkdir(path.join(root, "old-empty"));
  await fs.writeFile(path.join(root, "file"), before);
  await fs.mkdir(path.join(staged, "new-empty"));
  await fs.writeFile(path.join(staged, "file"), after);
  const base = await manifestFor(root);
  const current = await manifestFor(staged);
  let pending: WorkerWorkspaceReconciliationJournal | undefined;
  const journal = {
    load: async () => pending,
    begin: async (value: WorkerWorkspaceReconciliationJournal) => {
      pending = value;
    },
    commit: async () => {},
    abort: async () => {
      pending = undefined;
    },
  };
  return {
    root,
    journal,
    pending: () => pending!,
    params: {
      root,
      stagingRoot: staged,
      current,
      baseManifestRef: `sha256:${"a".repeat(64)}`,
      currentManifestRef: `sha256:${"b".repeat(64)}`,
      reconciliation: prepareWorkspaceReconciliation(base, current),
      journal,
      acceptance: { kind: "reconcile" as const },
    },
  };
}

it("applies and recovers real files and directories without synchronous host path lookups", async () => {
  const f = await fixture();
  const spies = [
    vi.spyOn(fsSync, "lstatSync"),
    vi.spyOn(fsSync, "statSync"),
    vi.spyOn(fsSync, "realpathSync"),
    vi.spyOn(fsSync, "openSync"),
    vi.spyOn(fsSync, "readdirSync"),
  ];
  await applyStagedWorkerWorkspace(f.params);
  expect(await fs.readFile(path.join(f.root, "file"), "utf8")).toBe("after");
  await recoverWorkerWorkspaceReconciliation({ root: f.root, journal: f.pending() });
  expect(await fs.readFile(path.join(f.root, "file"), "utf8")).toBe("before");
  expect((await fs.readdir(f.root)).toSorted()).toEqual(["file", "old-empty"]);
  expect(
    spies
      .flatMap((spy) => spy.mock.calls.map(([target]) => target))
      .filter((target) => typeof target === "string" && target.startsWith(f.root)),
  ).toEqual([]);
});

it.each(["state-selection", "retirement"] as const)(
  "keeps the journal and original bytes when %s changes before apply",
  async (kind) => {
    const f = await fixture();
    let patchPath: string | undefined;
    const write = fs.writeFile;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (typeof args[0] === "string" && args[0].includes("openclaw-workspace-apply-input-")) {
        patchPath = args[0];
      }
      return await write(...args);
    });
    const state = temporary.make("reconcile-state-selection-");
    const a = path.join(state, "a");
    const b = path.join(state, "b");
    const selected = path.join(state, "selected");
    const originalWorkspace = await captureWorkspaceFilesystemEvidence(
      temporary.make("reconcile-original-source-"),
    );
    await fs.mkdir(a);
    await fs.mkdir(b);
    await fs.symlink(a, selected);
    let live = true;
    const assertCurrent = () => {
      if (!live) {
        throw new Error("workspace owner retired");
      }
    };
    const observed = createDeferred();
    const begin = f.journal.begin;
    f.journal.begin = async (journal) => {
      await begin(journal);
      if (kind === "state-selection") {
        await fs.unlink(selected);
        await fs.symlink(b, selected);
      } else {
        // The first observation admits the operation; the second gates Git stdin.
        void filesystemBlock.arm(originalWorkspace.workspaceDir, 2).then(() => observed.resolve());
      }
    };
    const pending = applyStagedWorkerWorkspace({
      ...f.params,
      assertCurrent,
      workerAuthority: {
        assertCurrent,
        workspaceEvidence: [originalWorkspace],
        stateOwnerPath: { path: selected, canonicalPath: a },
      },
    });
    void pending.catch(() => {});
    if (kind === "retirement") {
      try {
        await observed.promise;
        expect(patchPath).toBeDefined();
        await fs.access(patchPath!);
        live = false;
      } finally {
        filesystemBlock.release();
      }
    }
    await expect(pending).rejects.toThrow(
      kind === "state-selection" ? "Sandbox workspace preparation" : "workspace owner retired",
    );
    expect(f.pending()).toBeDefined();
    expect(patchPath).toBeDefined();
    await expect(fs.access(path.dirname(patchPath!))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(f.root, "file"), "utf8")).toBe("before");
    expect((await fs.readdir(f.root)).toSorted()).toEqual(["file", "old-empty"]);
  },
);

it("does not orphan a temporary directory when source settlement fails", async () => {
  const probe = await manifestWorker.prepareWorkspaceTemporaryDirectory(
    "reconcile-temporary-probe-",
  );
  const parent = path.dirname(probe);
  await fs.rm(probe, { recursive: true, force: true });
  const prefix = `reconcile-temporary-settlement-${Date.now()}-`;
  const assertion = Object.assign(() => {}, {
    prepareSessionSourceEffect: async () => ({
      assertCurrent: () => {},
      release: () => {
        throw new Error("source settlement refused");
      },
    }),
  });
  await expect(
    manifestWorker.prepareWorkspaceTemporaryDirectory(prefix, { assertCurrent: assertion }),
  ).rejects.toThrow("source settlement refused");
  const remaining = (await fs.readdir(parent)).filter((name) => name.startsWith(prefix));
  try {
    expect(remaining).toEqual([]);
  } finally {
    await Promise.all(
      remaining.map((name) => fs.rm(path.join(parent, name), { recursive: true, force: true })),
    );
  }
});

it("transfers large apply and recovery bytes outside the admitted command and cleans both artifacts", async () => {
  const before = randomBytes(1024 * 1024);
  const after = randomBytes(1024 * 1024);
  const f = await fixture(before, after);
  const artifacts: string[] = [];
  const write = fs.writeFile;
  vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    const target = args[0];
    if (
      typeof target === "string" &&
      /openclaw-workspace-(?:apply|recovery)-input-/u.test(target)
    ) {
      artifacts.push(target);
    }
    return await write(...args);
  });
  const capacity = getWorkerComputeCapacity();
  const reserved = DEFAULT_WORKER_PENDING_BYTES - capacity.getSnapshot().pendingBytes - 64 * 1024;
  expect(capacity.admit(reserved)).toBe(true);
  try {
    await applyStagedWorkerWorkspace(f.params);
    expect(await fs.readFile(path.join(f.root, "file"))).toEqual(after);
    expect(f.pending().basePack.byteLength).toBeGreaterThan(64 * 1024);
    await recoverWorkerWorkspaceReconciliation({ root: f.root, journal: f.pending() });
    expect(await fs.readFile(path.join(f.root, "file"))).toEqual(before);
    expect(artifacts.map((entry) => path.basename(entry))).toEqual(["patch", "base.pack"]);
    for (const artifact of artifacts) {
      await expect(fs.access(path.dirname(artifact))).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    capacity.finish(reserved);
  }
});
