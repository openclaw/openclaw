import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { WorktreeWorkerAuthority } from "../../agents/worktrees/types.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import {
  DEFAULT_WORKER_PENDING_BYTES,
  getWorkerComputeCapacity,
} from "../../infra/worker-task-capacity.js";
import * as commandRuntime from "../../process/exec.js";
import { sha256 } from "./workspace-manifest-fixtures.test-support.js";
import * as manifestWorker from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import {
  deleteStagedWorkerWorkspaceResult as deleteResult,
  hasWorkerWorkspaceResultRef as hasRef,
  preparedWorkerWorkspaceResultRef as preparedRef,
  workerWorkspaceResultRef as resultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const gitConfig = [
  `core.hooksPath=${os.devNull}`,
  "user.name=Workspace Test",
  "user.email=workspace@example.invalid",
  "commit.gpgsign=false",
].flatMap((setting) => ["-c", setting]);

async function git(root: string, ...args: string[]): Promise<void> {
  const result = await commandRuntime.runCommandWithTimeout(
    ["git", ...gitConfig, "-C", root, ...args],
    { timeoutMs: 10_000 },
  );
  expect(result.code, result.stderr || result.stdout).toBe(0);
}

it("queues related worktree ref mutations while another repository progresses", async () => {
  const repository = tempDirs.make("worker-result-main-");
  const unrelated = tempDirs.make("worker-result-unrelated-");
  const worktree = path.join(tempDirs.make("worker-result-linked-"), "worktree");
  for (const root of [repository, unrelated]) {
    await git(root, "init", "--quiet");
    await git(root, "commit", "--quiet", "--allow-empty", "-m", "base");
  }
  await git(repository, "worktree", "add", "--quiet", "--detach", worktree);
  const targets = [repository, worktree, unrelated].map((directory, index) => ({
    root: directory,
    stagedResultRef: preparedRef(resultRef(`claim-${index}`)),
  }));
  for (const target of targets) {
    await git(target.root, "update-ref", target.stagedResultRef, "HEAD");
  }
  await git(repository, "pack-refs", "--all");
  await git(unrelated, "pack-refs", "--all");

  const firstStarted = createDeferred();
  const secondReachedGit = createDeferred();
  const releaseFirst = createDeferred();
  const mutations: string[] = [];
  const runCommand = commandRuntime.runCommandWithTimeout;
  const spy = vi
    .spyOn(commandRuntime, "runCommandWithTimeout")
    .mockImplementation(async (argv, options) => {
      const cwd = argv[argv.indexOf("-C") + 1];
      if (cwd === worktree) {
        secondReachedGit.resolve();
      }
      if (argv.includes("update-ref")) {
        mutations.push(cwd!);
        if (cwd === repository) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
      }
      return await runCommand(argv, options);
    });
  const operations: Promise<void>[] = [];
  try {
    operations.push(deleteResult(targets[0]!));
    await firstStarted.promise;
    operations.push(deleteResult(targets[1]!));
    const independent = deleteResult(targets[2]!);
    operations.push(independent);
    // Only the unrelated repository may mutate while the first writer is held.
    await Promise.all([secondReachedGit.promise, independent]);
    expect(mutations).toEqual([repository, unrelated]);
    await expect(hasRef(targets[1]!)).resolves.toBe(true);
    await expect(hasRef(targets[2]!)).resolves.toBe(false);
    releaseFirst.resolve();
    await Promise.all(operations);
    expect(mutations).toEqual([repository, unrelated, worktree]);
    for (const target of targets) {
      await expect(hasRef(target)).resolves.toBe(false);
    }
  } finally {
    releaseFirst.resolve();
    await Promise.allSettled(operations);
    spy.mockRestore();
  }
});

async function mutationFixture(kind: "refs" | "staging") {
  const root = tempDirs.make("workspace-result-authority-");
  const stagingRoot = tempDirs.make("workspace-result-input-");
  await git(root, "init", "--quiet");
  await git(root, "commit", "--quiet", "--allow-empty", "-m", "base");
  const stagedResultRef = resultRef("authority");
  if (kind === "refs") {
    await git(root, "update-ref", stagedResultRef, "HEAD");
  }
  const raw = serializeWorkerWorkspaceManifest({ version: 1, baseCommit: null, entries: [] });
  return {
    root,
    present: () => hasRef({ root, stagedResultRef }),
    mutate: (
      assertCurrent: SessionSourceAssertion | undefined,
      workerAuthority?: WorktreeWorkerAuthority,
    ) =>
      kind === "refs"
        ? deleteResult({ root, stagedResultRef, assertCurrent, workerAuthority })
        : workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
            root,
            stagingRoot,
            stagedResultRef,
            baseManifestRaw: raw,
            currentManifestRaw: raw,
            baseManifestRef: `sha256:${sha256(raw)}`,
            currentManifestRef: `sha256:${sha256(raw)}`,
            assertCurrent,
            workerAuthority,
          }),
  };
}

it.each(["refs", "staging"] as const)(
  "refuses a retargeted original state selection before %s mutation",
  async (kind) => {
    const fixture = await mutationFixture(kind);
    const other = tempDirs.make("workspace-result-other-");
    const selection = path.join(tempDirs.make("workspace-result-selection-"), "state");
    await fs.symlink(fixture.root, selection, "dir");
    const stateOwnerPath = { path: selection, canonicalPath: await fs.realpath(selection) };
    await fs.unlink(selection);
    await fs.symlink(other, selection, "dir");
    await expect(fixture.mutate(() => {}, { stateOwnerPath })).rejects.toMatchObject({
      code: "GATEWAY_STATE_OWNER_REQUIRED",
    });
    await expect(fixture.mutate(undefined, { stateOwnerPath })).rejects.toMatchObject({
      code: "GATEWAY_STATE_OWNER_REQUIRED",
    });
    // The canonical repository is still intact; the original lexical selection owns refusal.
    await expect(fixture.present()).resolves.toBe(kind === "refs");
    await expect(fs.readdir(other)).resolves.toEqual([]);
  },
);

it.each(["refs", "staging"] as const)(
  "holds prepared source authority through %s process settlement",
  async (kind) => {
    const fixture = await mutationFixture(kind);
    let active = 0;
    let checks = 0;
    let workerChecks = 0;
    let releases = 0;
    let settled = 0;
    const assertion = Object.assign(() => {}, {
      prepareSessionSourceEffect: async () => {
        let current = true;
        active++;
        return {
          assertCurrent: () => {
            expect(current).toBe(true);
            checks++;
          },
          release: async () => {
            current = false;
            active--;
            releases++;
          },
        };
      },
    });
    const observe = async <T>(run: () => Promise<T>): Promise<T> => {
      expect(active).toBeGreaterThan(0);
      const result = await run();
      expect(active).toBeGreaterThan(0);
      settled++;
      return result;
    };
    const runCommand = commandRuntime.runCommandWithTimeout;
    const runExec = commandRuntime.runExec;
    const spy =
      kind === "refs"
        ? vi
            .spyOn(commandRuntime, "runCommandWithTimeout")
            .mockImplementation((argv, options) =>
              argv.includes("update-ref")
                ? observe(() => runCommand(argv, options))
                : runCommand(argv, options),
            )
        : vi
            .spyOn(commandRuntime, "runExec")
            .mockImplementation((command, args, options) =>
              args.includes("fast-import")
                ? observe(() => runExec(command, args, options))
                : runExec(command, args, options),
            );
    try {
      await fixture.mutate(assertion, {
        assertCurrent: () => {
          workerChecks++;
        },
      });
      await expect(fixture.present()).resolves.toBe(kind === "staging");
      expect(checks).toBeGreaterThan(0);
      expect(workerChecks).toBeGreaterThan(0);
      expect(releases).toBeGreaterThan(0);
      expect(active).toBe(0);
      expect(settled).toBe(1);
    } finally {
      spy.mockRestore();
    }
  },
);

it("keeps stage input inside the shared worker byte budget", async () => {
  const fixture = await mutationFixture("staging");
  const capacity = getWorkerComputeCapacity();
  const prepare = manifestWorker.prepareWorkspaceStageInput;
  const spy = vi
    .spyOn(manifestWorker, "prepareWorkspaceStageInput")
    .mockImplementation(async (...args) => {
      const reserved = DEFAULT_WORKER_PENDING_BYTES - capacity.getSnapshot().pendingBytes;
      expect(capacity.admit(reserved)).toBe(true);
      try {
        return await prepare(...args);
      } finally {
        capacity.finish(reserved);
      }
    });
  try {
    await expect(fixture.mutate(undefined)).rejects.toMatchObject({ code: "overloaded" });
    await expect(fixture.present()).resolves.toBe(false);
  } finally {
    spy.mockRestore();
  }
  await fixture.mutate(undefined);
  await expect(fixture.present()).resolves.toBe(true);
});
