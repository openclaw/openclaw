import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import type { WorkerWorkspaceReconcileRequest as ReconcileRequest } from "./tunnel-contract.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import {
  parseRemoteWorkspaceManifestEnvelope,
  type RemoteWorkspaceManifestEnvelope,
} from "./workspace-hash-memo.js";
import { createWorkerWorkspaceActions } from "./workspace-sync.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type RepositorySource = Extract<ReconcileRequest["source"], { kind: "repository" }>;
type Checkpoint = Parameters<RepositorySource["prepareCheckpoint"]>[0];
const paths = (entries: { path: string }[]) => entries.map((entry) => entry.path);
const copyTree = (from: string, to: string) => fs.cp(from, to, { recursive: true });
const repositorySource = {
  kind: "repository" as const,
  url: "https://example.invalid/repository.git",
  branch: "openclaw/session",
};
const filesAt = (root: string) => ({
  read: (file: string) => fs.readFile(path.join(root, file), "utf8"),
  write: (file: string, content: string) => fs.writeFile(path.join(root, file), content),
});

it.each([
  { operation: "clone", reason: "clone-failed", stage: "git clone" },
  { operation: "checkout", reason: "checkout-failed", stage: "git checkout --detach" },
])("surfaces $reason diagnostics to cloud placement", async ({ operation, reason, stage }) => {
  const service = createNodeWorkspaceTransferService({
    temporaryRoot: tempDirs.make("node-repository-failure-"),
    getOwner: () => undefined,
  });
  const actions = createNodeWorkerWorkspaceActions({
    environmentId: "environment-1",
    ownerEpoch: 1,
    sessionId: "session-1",
    ownerSignal: new AbortController().signal,
    isOwnerCurrent: () => true,
    workspaceTransfer: service,
    runWorkspaceCommand: async ({ argv }) => ({
      stdout: argv.includes("rev-parse") ? "a".repeat(40) : "",
      stderr: argv.includes(operation) ? "fatal: Permission denied\n" : "",
      code: argv.includes(operation) ? 128 : 0,
      signal: null,
      killed: false,
      termination: "exit",
      workspaceDir: "/node/workspace",
    }),
  });
  try {
    await expect(
      actions.syncWorkspace({
        sessionId: "session-1",
        generation: 1,
        source: repositorySource,
      }),
    ).rejects.toThrow(
      `Cloud repository preparation failed: ${reason}: ${stage}: exit (exit code 128, signal null): fatal: Permission denied`,
    );
  } finally {
    await service.closeAll();
  }
});

it("rejects repository sources on SSH before invoking any remote command", async () => {
  const run = vi.fn();
  const waitForPrepared = vi.fn();
  const actions = createWorkerWorkspaceActions({
    environmentId: "environment-ssh",
    ownerSignal: new AbortController().signal,
    runner: { run },
    waitForPrepared,
    tasks: new Set(),
    bundleHash: "a".repeat(64),
  });
  await expect(
    actions.syncWorkspace({
      sessionId: "session-ssh",
      generation: 1,
      source: repositorySource,
    }),
  ).rejects.toThrow("managed node");
  await expect(
    actions.reconcileWorkspace({
      remoteWorkspaceDir: "/worker/workspace",
      baseManifestRef: `sha256:${"b".repeat(64)}`,
      source: {
        kind: "repository",
        referenceManifestRef: `sha256:${"b".repeat(64)}`,
        prepareCheckpoint: vi.fn(),
      },
    }),
  ).rejects.toThrow("managed node");
  expect(waitForPrepared).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it.each([
  { publication: "available", filters: false, closeOwner: false },
  { publication: "blocked by filters", filters: true, closeOwner: false },
  { publication: "blocked when the owner closes", filters: true, closeOwner: true },
])(
  "preserves repository checkpoints with publication $publication",
  async ({ filters, closeOwner }) => {
    const root = await fs.realpath(tempDirs.make("node-repository-roundtrip-"));
    const origin = path.join(root, "origin");
    const home = path.join(root, "node-home");
    const originFiles = filesAt(origin);
    await fs.mkdir(path.join(origin, ".openclaw"), { recursive: true });
    await originFiles.write(".gitignore", "*.ignored\n");
    await originFiles.write(".worktreeinclude", "retained.ignored\n");
    await originFiles.write("retained-removal.ignored", "keep recovered bytes\n");
    await originFiles.write("tracked.txt", "base\n");
    await originFiles.write("a-original.txt", "turn one\n");
    if (filters) {
      await originFiles.write(".gitattributes", "*.dat filter=example\n");
    }
    await fs.writeFile(
      path.join(origin, ".openclaw", "worktree-setup.sh"),
      "#!/bin/sh\nprintf 'prepared\\n' > setup.txt\n",
      { mode: 0o755 },
    );
    const gitAt = async (cwd: string, ...args: string[]) => {
      const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], {
        timeoutMs: 10_000,
        baseEnv: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      expect(result.code, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const git = (...args: string[]) => gitAt(origin, ...args);
    await git("init", "--quiet");
    await git("add", ".");
    await git("add", "-f", "retained-removal.ignored");
    await git(
      "-c",
      "user.name=Repository Test",
      "-c",
      "user.email=repository@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "base",
    );
    const baseCommit = await git("rev-parse", "HEAD");
    let epoch = 1;
    const service = createNodeWorkspaceTransferService({
      temporaryRoot: path.join(root, "transfers"),
      getOwner: () => ({
        credential: { ownerEpoch: epoch, sessionId: "session-1" },
        environment: {
          ownerEpoch: epoch,
          attachedSessionIds: ["session-1"],
          destroyRequestedAtMs: null,
          state: "attached",
        },
      }),
    });
    const server = await startNodeWorkspaceTransferTestServer(service);
    const createRuntime = () =>
      new NodeWorkerWorkspaceRuntime({
        root: path.join(home, "node-host"),
        env: { PATH: process.env.PATH, HOME: home },
      });
    let runtime = createRuntime();
    const manifestCaptures: RemoteWorkspaceManifestEnvelope[] = [];
    const createActions = () => {
      const ownerEpoch = epoch;
      const ownerSignal = new AbortController().signal;
      return createNodeWorkerWorkspaceActions({
        environmentId: "environment-1",
        ownerEpoch,
        sessionId: "session-1",
        ownerSignal,
        isOwnerCurrent: () => epoch === ownerEpoch,
        workspaceTransfer: service,
        runWorkspaceCommand: async (command) => {
          if (epoch !== ownerEpoch) {
            throw new Error("node workspace authority closed");
          }
          try {
            const result = await runtime.exec(
              {
                gatewayNamespace: "gateway-1",
                environmentId: "environment-1",
                sessionId: "session-1",
                generation: ownerEpoch,
                ...command,
                argv: [...command.argv],
              },
              ownerSignal,
              { url: server.gatewayUrl },
            );
            if (command.argv.at(-1) === "memo-v1") {
              manifestCaptures.push(parseRemoteWorkspaceManifestEnvelope(result.stdout));
            }
            return result;
          } catch (error) {
            if (
              closeOwner &&
              command.transfer?.direction === "upload" &&
              command.transfer.publicationBaseCommit
            ) {
              epoch += 1;
            }
            throw error;
          }
        },
      });
    };
    const source = {
      kind: "repository" as const,
      url: pathToFileURL(origin).href,
      ref: "HEAD",
      branch: "openclaw/session",
      gitToken: "synthetic-repository-token",
      runSetupScript: true,
    };
    try {
      const actions = createActions();
      const first = await actions.syncWorkspace({
        sessionId: "session-1",
        generation: epoch,
        source,
      });
      expect(first.mode).toBe("repository");
      if (first.mode !== "repository") {
        throw new Error("Repository source was not prepared");
      }
      const workspace = first.remoteWorkspaceDir;
      const firstFiles = filesAt(workspace);
      expect(first.baseCommit).toBe(baseCommit);
      expect(first.manifestRef).not.toBe(first.baseManifestRef);
      expect(await firstFiles.read("setup.txt")).toBe("prepared\n");
      let checkpoint: Checkpoint | undefined;
      let revision = 0;
      const capture = async (active = actions, directory = workspace) => {
        const firstCapture = manifestCaptures.length;
        const phases: string[] = [];
        const result = await active.reconcileWorkspace({
          remoteWorkspaceDir: directory,
          baseManifestRef: first.baseManifestRef,
          source: {
            kind: "repository",
            markPhase: (phase) => phases.push(phase),
            referenceManifestRef: checkpoint?.currentManifestRef ?? first.manifestRef,
            prepareCheckpoint: async (payload) => {
              const stagingRoot = path.join(root, `checkpoint-${++revision}`);
              await copyTree(payload.stagingRoot, stagingRoot);
              if (filters) {
                expect(payload.publicationDigest).toBeUndefined();
                expect(payload.publicationStagingRoot).toBeUndefined();
              } else {
                expect(payload.publicationDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
                expect(
                  JSON.parse(await filesAt(payload.publicationStagingRoot!).read("snapshot.json")),
                ).toMatchObject({ baseCommit });
              }
              const publicationStagingRoot = payload.publicationStagingRoot
                ? path.join(root, `publication-${revision}`)
                : undefined;
              if (publicationStagingRoot) {
                await copyTree(payload.publicationStagingRoot!, publicationStagingRoot);
              }
              const captured = { ...payload, stagingRoot, publicationStagingRoot };
              return {
                verify: async () => {
                  expect(await fs.stat(stagingRoot)).toBeDefined();
                },
                publish: async () => {
                  checkpoint = captured;
                },
                discard: async () => {
                  await fs.rm(stagingRoot, { recursive: true, force: true });
                },
              };
            },
          },
        });
        expect(phases).toEqual([
          "repositoryCheckpointUpload",
          "repositoryVerification",
          "repositoryPublicationUpload",
          "repositoryVerification",
          "repositoryCheckpointStage",
        ]);
        await verifyReconciledWorkspaceFinal(result, {
          assertActive: async () => {},
          resume: async () => {},
        });
        const captures = manifestCaptures.slice(firstCapture);
        expect(captures).toHaveLength(4);
        expect(captures.slice(1).every(({ metrics }) => metrics.contentHashCount === 0)).toBe(true);
        expect(captures.slice(1).every(({ metrics }) => metrics.memoHitCount > 0)).toBe(true);
        return captures;
      };
      if (closeOwner) {
        await expect(capture()).rejects.toThrow();
        expect(revision).toBe(0);
        expect(checkpoint).toBeUndefined();
        return;
      }
      // Startup must accept setup output even when GitHub normalization is unavailable.
      const initialCaptures = await capture();
      expect(initialCaptures[0]!.metrics.contentHashCount).toBeGreaterThan(0);
      expect(revision).toBe(1);
      expect(checkpoint).toBeDefined();
      await gitAt(workspace, "rm", "--cached", "retained-removal.ignored");
      await firstFiles.write("published[1].ignored", "publishable\n");
      await firstFiles.write("retained.ignored", "recovery only\n");
      await gitAt(workspace, "--literal-pathspecs", "add", "-f", "--", "published[1].ignored");
      await firstFiles.write("first.txt", "turn one\n");
      const changedCaptures = await capture();
      expect(changedCaptures[0]!.metrics.contentHashCount).toBeGreaterThan(0);
      expect(changedCaptures[0]!.metrics.memoHitCount).toBeGreaterThan(0);
      await firstFiles.write("second.txt", "turn two\n");
      await fs.rm(path.join(workspace, "tracked.txt"));
      await capture();
      expect(checkpoint).toBeDefined();

      epoch += 1;
      const replacement = createActions();
      const restored = await replacement.syncWorkspace({
        sessionId: "session-1",
        generation: epoch,
        source: { ...source, baseCommit, checkpoint },
      });
      const restoredFiles = filesAt(restored.remoteWorkspaceDir);
      const restoredGit = (...args: string[]) => gitAt(restored.remoteWorkspaceDir, ...args);
      expect(restored.remoteWorkspaceDir).not.toBe(workspace);
      expect(restored.manifestRef).toBe(checkpoint!.currentManifestRef);
      expect(await restoredFiles.read("first.txt")).toBe("turn one\n");
      expect(await restoredFiles.read("second.txt")).toBe("turn two\n");
      expect(await restoredFiles.read("setup.txt")).toBe("prepared\n");
      await expect(
        fs.stat(path.join(restored.remoteWorkspaceDir, "tracked.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(checkpoint!.stagingRoot)).toSorted()).toEqual([
        "first.txt",
        "published[1].ignored",
        "retained.ignored",
        "second.txt",
        "setup.txt",
      ]);
      expect(await restoredFiles.read("published[1].ignored")).toBe("publishable\n");
      expect(await restoredGit("ls-files", "--", "published[1].ignored")).toBe(
        filters ? "" : "published[1].ignored",
      );
      expect(await restoredGit("ls-files", "--", "retained.ignored")).toBe("");
      expect(await restoredFiles.read("retained-removal.ignored")).toBe("keep recovered bytes\n");
      expect(await restoredGit("ls-files", "--", "retained-removal.ignored")).toBe(
        filters ? "retained-removal.ignored" : "",
      );
      expect(await restoredGit("diff", "--cached", "--name-only")).toBe(
        filters ? "" : "retained-removal.ignored\ntracked.txt",
      );
      // A node process restart loses in-memory transfer refs; the Gateway owns the accepted ref.
      runtime = createRuntime();
      await capture(replacement, restored.remoteWorkspaceDir);
      expect(paths(JSON.parse(checkpoint!.currentManifestRaw).entries)).toContain(
        "published[1].ignored",
      );
      if (!filters) {
        const snapshot = JSON.parse(
          await filesAt(checkpoint!.publicationStagingRoot!).read("snapshot.json"),
        );
        expect(paths(snapshot.entries)).toContain("published[1].ignored");
        expect(paths(snapshot.entries)).not.toContain("retained.ignored");
        expect(snapshot.entries).toContainEqual({
          path: "retained-removal.ignored",
          mode: "100644",
          sha: null,
        });
      }
    } finally {
      await server.close();
      await service.closeAll();
    }
  },
);
