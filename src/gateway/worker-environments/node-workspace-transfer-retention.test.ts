import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { listenLoopback } from "../../../test/helpers/gateway-integration-fixtures.js";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import {
  ensureStagedInputDirectory,
  stagedInputDirectory,
  stagedInputFileName,
} from "../../media/staged-inputs.js";
import { createStagedInputOwnershipFixture } from "../../media/staged-inputs.test-support.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { captureGitHubPublicationWorkspaceSnapshot } from "../github-publication-git-transport.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { createNodeWorkerWorkspaceFallback } from "./node-worker-workspace-fallback.js";
import {
  commitWorkspace,
  workspaceFiles,
} from "./node-workspace-transfer-fixtures.test-support.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import {
  startNodeWorkspaceTransferTestServer,
  transferOwner,
} from "./node-workspace-transfer.test-support.js";
import { memoryWorkspaceJournal } from "./tunnel.test-support.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import { ConcurrentWorkspacePathError } from "./workspace-reconcile.js";
import {
  deleteStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type ActionsOptions = Parameters<typeof createNodeWorkerWorkspaceActions>[0];

async function runtimeFixture(root: string, scope: string, credentialExpiry?: () => number) {
  const owner = new AbortController();
  const environmentId = `${scope}-worker`;
  const sessionId = `${scope}-session`;
  const ownerEpoch = 1;
  const createService = () =>
    createNodeWorkspaceTransferService({
      getOwner: () => transferOwner(sessionId, ownerEpoch, credentialExpiry?.()),
      temporaryRoot: path.join(root, "transfers"),
    });
  let service = createService();
  let server = await startNodeWorkspaceTransferTestServer(service);
  const runtime = new NodeWorkerWorkspaceRuntime({ root: path.join(root, "node") });
  const createActions = (restoredWorkspace?: ActionsOptions["restoredWorkspace"]) =>
    createNodeWorkerWorkspaceActions({
      environmentId,
      sessionId,
      ownerEpoch,
      ownerSignal: owner.signal,
      isOwnerCurrent: () => !owner.signal.aborted,
      workspaceTransfer: service,
      restoredWorkspace,
      supportsNativeQuiescence: async () => process.platform === "linux",
      runWorkspaceCommand: (command) =>
        runtime.exec(
          {
            ...command,
            ...(process.platform === "linux" &&
            !command.quiescence &&
            !command.process &&
            !command.transfer &&
            !command.seed &&
            !command.legacyQuiescence
              ? { nativeProcessOwner: true as const }
              : {}),
            argv: [...command.argv],
            gatewayNamespace: `gateway-${scope}-test`,
            environmentId,
            sessionId,
            generation: ownerEpoch,
          },
          command.signal,
          { url: server.gatewayUrl },
        ),
    });
  const stop = async () => {
    await service.closeAll();
    await server.close();
  };
  return {
    owner,
    sessionId,
    ownerEpoch,
    createActions,
    async restart() {
      await stop();
      service = createService();
      server = await startNodeWorkspaceTransferTestServer(service);
    },
    async close() {
      owner.abort();
      await stop();
    },
  };
}

async function expectGit(workspace: string, queries: Array<[string[], string]>) {
  for (const [args, expected] of queries) {
    expect((await requireGit(workspace, args)).trim()).toBe(expected);
  }
}

it("discards a failed origin clone before transferring the Gateway Git base", async () => {
  const root = await fs.realpath(tempDirs.make("node-workspace-origin-fallback-"));
  const origin = path.join(root, "origin");
  const localPath = path.join(root, "gateway-workspace");
  await fs.mkdir(origin);
  await fs.mkdir(localPath);
  await fs.writeFile(path.join(origin, "README"), "unrelated upstream repository\n");
  await commitWorkspace(origin, "upstream base");
  await requireGit(origin, ["update-server-info"]);
  await fs.writeFile(path.join(localPath, "project.txt"), "unpublished local project\n");
  await commitWorkspace(localPath, "unpublished local base");
  const baseCommit = (await requireGit(localPath, ["rev-parse", "HEAD"])).trim();
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture.test").pathname;
    requests.push(pathname);
    void fs.readFile(path.join(origin, ".git", pathname)).then(
      (bytes) => response.end(bytes),
      () => {
        response.statusCode = 404;
        response.end();
      },
    );
  });
  const sourceOrigin = `${await listenLoopback(server)}/`;
  try {
    await requireGit(localPath, ["remote", "add", "origin", sourceOrigin]);
    const fixture = await runtimeFixture(root, "origin-fallback");
    try {
      const synced = await fixture.createActions().syncWorkspace({
        source: { kind: "local", path: localPath },
        sessionId: fixture.sessionId,
        generation: fixture.ownerEpoch,
      });
      expect(requests).toContain("/HEAD");
      await expectGit(synced.remoteWorkspaceDir, [
        [["rev-parse", "HEAD"], baseCommit],
        [["ls-files"], "project.txt"],
        [["status", "--porcelain"], ""],
        [["remote", "get-url", "origin"], sourceOrigin],
      ]);
      await workspaceFiles(synced.remoteWorkspaceDir).expect(
        "project.txt",
        "unpublished local project\n",
      );
      await workspaceFiles(synced.remoteWorkspaceDir).missing("README");
    } finally {
      await fixture.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

it.each([
  "git",
  "git-with-empty-include",
  "git-with-explicit-include",
  "git-with-marker-only-include",
  "plain",
])(
  "reconciles private inputs staged after dispatch through the node transport (%s)",
  async (mode) => {
    const root = await fs.realpath(tempDirs.make("node-workspace-input-retention-"));
    const localPath = path.join(root, "gateway-workspace");
    const localFiles = workspaceFiles(localPath);
    await fs.mkdir(localPath);
    await localFiles.write("project.txt", "existing project file\n");
    await localFiles.write(
      ".gitignore",
      "unrelated-private.txt\nmedia/inbound/openclaw-staged-*/\n",
    );
    const explicitlyIncluded = `${stagedInputDirectory("d".repeat(64))}/input-secret.txt`;
    if (mode.startsWith("git-with-")) {
      const includePaths =
        mode === "git-with-explicit-include"
          ? [explicitlyIncluded, explicitlyIncluded.replace("secret.txt", "cache.pyc")]
          : mode === "git-with-marker-only-include"
            ? [`${stagedInputDirectory("a1".repeat(32))}/.gitignore`]
            : [];
      await localFiles.write(".worktreeinclude", includePaths.join("\n"));
    }
    if (mode !== "plain") {
      await commitWorkspace(localPath, "base before attachments");
    }
    await createStagedInputOwnershipFixture(localPath);
    const fixture = await runtimeFixture(root, "input", () => Date.now() + 60_000);
    const { owner, sessionId, ownerEpoch } = fixture;
    const actions = fixture.createActions();
    let initiatingTurnCurrent = true;
    try {
      const synced = await actions.syncWorkspace({
        authorize: () => {
          if (!initiatingTurnCurrent) {
            throw new Error("initiating turn closed");
          }
        },
        source: { kind: "local", path: localPath },
        sessionId,
        generation: ownerEpoch,
      });
      expect(synced.mode).toBe(mode === "plain" ? "plain" : "git");
      initiatingTurnCurrent = false;
      expect(owner.signal.aborted).toBe(false);
      const remote = synced.remoteWorkspaceDir;
      const remoteFiles = workspaceFiles(remote);
      // Initial inventory selection is covered by workspace-sync-tunnel.test.ts.
      // Keep unowned targets here for the node reconciliation collision boundary.
      await createStagedInputOwnershipFixture(remote);
      let baseManifestRef = synced.manifestRef;
      const journal = memoryWorkspaceJournal((ref) => {
        baseManifestRef = ref;
      });
      const reconcile = async (claimId: string) => {
        const ref = workerWorkspaceResultRef(claimId);
        let recorded: string | undefined;
        const quiescence = await actions.quiesceWorkspace(remote);
        try {
          const result = await actions.reconcileWorkspace({
            remoteWorkspaceDir: remote,
            baseManifestRef,
            source: {
              kind: "local",
              path: localPath,
              journal,
              stagedResult: {
                ref,
                record: (value) => {
                  recorded = value;
                },
              },
            },
          });
          const applied = await verifyReconciledWorkspaceFinal(result, quiescence);
          expect(recorded).toBe(ref);
          expect(baseManifestRef).toBe(result.manifestRef);
          await deleteStagedWorkerWorkspaceResult({ root: localPath, stagedResultRef: ref });
          return applied;
        } finally {
          await quiescence.resume();
        }
      };
      const attachmentsRoot = path.join(root, "attachments");
      await fs.mkdir(attachmentsRoot);
      const directory = stagedInputDirectory("a".repeat(64));
      await ensureStagedInputDirectory(attachmentsRoot, directory);
      const notesPath = `${directory}/${stagedInputFileName("notes.txt")}`;
      const pngPath = `${directory}/${stagedInputFileName("image.png")}`;
      const png = createSolidPngBuffer(3, 3, { r: 255, g: 0, b: 0 });
      const originalNotes = Buffer.from("original private notes\n");
      const expected = new Map([
        [notesPath, originalNotes],
        [`${directory}/input-cache.pyc`, Buffer.from("original input cache\n")],
        [pngPath, png],
        [`${directory}/${stagedInputFileName(".gitignore")}`, Buffer.from("!*\n")],
        [
          `${directory}/${stagedInputFileName(".git")}`,
          Buffer.from("ordinary input, not Git metadata\n"),
        ],
      ]);
      for (const [relative, bytes] of expected) {
        await fs.writeFile(path.join(attachmentsRoot, relative), bytes);
      }
      expected.set(
        `${directory}/.gitignore`,
        await fs.readFile(path.join(attachmentsRoot, directory, ".gitignore")),
      );
      const stage = () =>
        actions.stageAttachments!({
          localPath: attachmentsRoot,
          isAuthorized: () => !owner.signal.aborted,
          signal: owner.signal,
        });
      await stage();
      const editedNotes = Buffer.from("original private notes\nINPUT_EDIT_PRESERVED\n");
      await remoteFiles.write(notesPath, editedNotes);
      expected.set(notesPath, editedNotes);
      await fs.copyFile(path.join(remote, pngPath), path.join(remote, "proof-output.png"));
      await remoteFiles.write("unrelated-keep.txt", "unrelated worker file\n");
      await remoteFiles.write("unrelated-private.txt", "unselected ignored file\n");

      const assertRetained = async () => {
        for (const [relative, bytes] of expected) {
          // Assert Gateway bytes first: a successful upload alone did not prove retention.
          await localFiles.expect(relative, bytes);
          await remoteFiles.expect(relative, bytes);
        }
        await localFiles.expect("proof-output.png", png);
        await localFiles.expect("unrelated-keep.txt", "unrelated worker file\n");
        await localFiles.expect("project.txt", "existing project file\n");
        if (mode !== "plain") {
          await localFiles.missing("unrelated-private.txt");
          const publication = await captureGitHubPublicationWorkspaceSnapshot({ cwd: localPath });
          const published = (
            await requireGit(localPath, ["ls-tree", "-r", "--name-only", publication.workspaceTree])
          ).split("\n");
          expect(published).toEqual(
            expect.arrayContaining(["project.txt", "proof-output.png", "unrelated-keep.txt"]),
          );
          for (const relative of expected.keys()) {
            expect(published).not.toContain(relative);
          }
          expect(await requireGit(localPath, ["ls-files", "--", "media/inbound"])).toBe("");
        }
      };
      expect((await reconcile("first-input-turn"))?.conflictPaths).toEqual([]);
      await assertRetained();

      const nextDirectory = stagedInputDirectory("b".repeat(64));
      await ensureStagedInputDirectory(attachmentsRoot, nextDirectory);
      const nextPath = `${nextDirectory}/${stagedInputFileName("next.txt")}`;
      const nextBytes = Buffer.from("next turn input\n");
      await fs.writeFile(path.join(attachmentsRoot, nextPath), nextBytes);
      expected.set(nextPath, nextBytes);
      expected.set(
        `${nextDirectory}/.gitignore`,
        await fs.readFile(path.join(attachmentsRoot, nextDirectory, ".gitignore")),
      );
      // The source still contains originalNotes; repeated staging must preserve the worker edit.
      await stage();
      await remoteFiles.expect(notesPath, editedNotes);
      const editedCache = Buffer.from("edited input cache\n");
      await remoteFiles.write(`${directory}/input-cache.pyc`, editedCache);
      expected.set(`${directory}/input-cache.pyc`, editedCache);
      expect((await reconcile("next-input-turn"))?.conflictPaths).toEqual([]);
      await assertRetained();

      for (const { kind, identity, markerBefore } of [
        { kind: "addition", identity: "d".repeat(64), markerBefore: undefined },
        { kind: "replacement", identity: "e".repeat(64), markerBefore: Buffer.from("*\n") },
        {
          kind: "unchanged-marker-new-child",
          identity: "a1".repeat(32),
          markerBefore: expected.get(`${directory}/.gitignore`)!,
        },
      ]) {
        // Each marker addition/replacement starts from its own authoritative dispatch.
        const collisionDispatch = await actions.syncWorkspace({
          source: { kind: "local", path: localPath },
          sessionId,
          generation: ownerEpoch,
        });
        baseManifestRef = collisionDispatch.manifestRef;
        expect(collisionDispatch.remoteWorkspaceDir).toBe(remote);
        const collision = stagedInputDirectory(identity);
        const markerPath = path.join(localPath, collision, ".gitignore");
        if (markerBefore) {
          await expect(fs.readFile(markerPath)).resolves.toEqual(markerBefore);
        } else {
          await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
        const markerLinksBefore = markerBefore ? (await fs.lstat(markerPath)).nlink : undefined;
        await fs.mkdir(path.join(remote, collision), { recursive: true });
        const workerMarker = path.join(remote, collision, ".gitignore");
        await fs.rm(workerMarker, { force: true });
        await fs.writeFile(workerMarker, expected.get(`${directory}/.gitignore`)!, { flag: "wx" });
        const localPrivate = new Map<string, Buffer>();
        for (const name of ["input-secret.txt", "input-cache.pyc"]) {
          const relative = `${collision}/${name}`;
          localPrivate.set(relative, await fs.readFile(path.join(localPath, relative)));
          await fs.writeFile(path.join(remote, relative), `worker collision bytes: ${relative}\n`);
        }
        const acceptedBeforeCollision = baseManifestRef;
        const claimId = `unowned-target-${kind}`;
        const collisionError = await reconcile(claimId).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect.soft(collisionError).toBeInstanceOf(ConcurrentWorkspacePathError);
        expect.soft(collisionError).toMatchObject({ message: expect.stringContaining("unowned") });
        if (markerBefore) {
          await expect.soft(fs.readFile(markerPath)).resolves.toEqual(markerBefore);
          expect.soft((await fs.lstat(markerPath)).nlink).toBe(markerLinksBefore);
        } else {
          await expect.soft(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
        for (const [relative, bytes] of localPrivate) {
          await expect.soft(fs.readFile(path.join(localPath, relative))).resolves.toEqual(bytes);
          await expect
            .soft(fs.readFile(path.join(remote, relative), "utf8"))
            .resolves.toBe(`worker collision bytes: ${relative}\n`);
        }
        expect.soft(baseManifestRef).toBe(acceptedBeforeCollision);
        expect.soft(await journal.load()).toBeUndefined();
        if (collisionError !== undefined) {
          await deleteStagedWorkerWorkspaceResult({
            root: localPath,
            stagedResultRef: workerWorkspaceResultRef(claimId),
          });
        }
        await fs.rm(path.join(remote, collision), { recursive: true });
      }
    } finally {
      await fixture.close();
    }
  },
);

it("restores node reconciliation after Gateway bootstrap changes without replacing its Git base", async () => {
  const root = await fs.realpath(tempDirs.make("node-workspace-restart-"));
  const localPath = path.join(root, "gateway-workspace");
  await fs.mkdir(localPath);
  await fs.writeFile(path.join(localPath, "project.txt"), "base project\n");
  await commitWorkspace(localPath, "base before dispatch");
  const sourceOrigin = "git://127.0.0.1:19418/origin.git";
  await requireGit(localPath, ["remote", "add", "origin", sourceOrigin]);
  const baseCommit = (await requireGit(localPath, ["rev-parse", "HEAD"])).trim();
  const fixture = await runtimeFixture(root, "restart");
  const { owner, sessionId, ownerEpoch, createActions } = fixture;
  try {
    const actions = createActions();
    const synced = await actions.syncWorkspace({
      source: { kind: "local", path: localPath },
      sessionId,
      generation: ownerEpoch,
    });
    const remote = synced.remoteWorkspaceDir;
    await expectGit(remote, [
      [["remote", "get-url", "origin"], sourceOrigin],
      [["config", "--get", "remote.origin.fetch"], "+refs/heads/*:refs/remotes/origin/*"],
    ]);
    const nodeOrigin = "git://127.0.0.1:19418/node-owned.git";
    await requireGit(remote, ["remote", "set-url", "origin", nodeOrigin]);
    await createNodeWorkerWorkspaceFallback(actions.runWorkspaceCommand).finalizeSync(
      { localPath, sessionId, generation: ownerEpoch },
      synced,
    );
    await expectGit(remote, [[["remote", "get-url", "origin"], nodeOrigin]]);
    await fs.writeFile(path.join(remote, "worker-commit.txt"), "node commit content\n");
    await requireGit(remote, ["add", "worker-commit.txt"]);
    await requireGit(remote, ["commit", "--quiet", "-m", "node-owned history"]);
    const nodeCommit = (await requireGit(remote, ["rev-parse", "HEAD"])).trim();
    const nodeBranch = (await requireGit(remote, ["branch", "--show-current"])).trim();
    await requireGit(remote, ["pack-refs", "--all"]);
    await fs.rm(path.join(remote, ".git", "shallow"));
    await requireGit(remote, ["checkout", "--quiet", "--detach"]);
    for (const name of ["SOUL.md", "USER.md", "IDENTITY.md"]) {
      await fs.writeFile(path.join(localPath, name), `local bootstrap ${name}\n`);
    }
    await requireGit(localPath, ["add", "SOUL.md", "USER.md", "IDENTITY.md"]);
    await requireGit(localPath, ["commit", "--quiet", "-m", "local bootstrap after dispatch"]);
    const gatewayCommit = (await requireGit(localPath, ["rev-parse", "HEAD"])).trim();
    expect(gatewayCommit).not.toBe(baseCommit);
    await fs.writeFile(path.join(localPath, "project.txt"), "Gateway project edit\n");
    await fs.writeFile(path.join(remote, "project.txt"), "worker project edit\n");
    await fs.writeFile(path.join(remote, "result.txt"), "worker result\n");
    await fixture.restart();
    const restored = createActions({
      source: { kind: "local", path: localPath },
      manifestRef: synced.manifestRef,
      remoteWorkspaceDir: remote,
    });
    await restored.validateRestoredWorkspace();

    let accepted: string | undefined;
    const journal = memoryWorkspaceJournal((ref) => {
      accepted = ref;
    });
    const request = {
      remoteWorkspaceDir: remote,
      baseManifestRef: synced.manifestRef,
      source: {
        kind: "local" as const,
        path: localPath,
        journal,
        stagedResult: { ref: workerWorkspaceResultRef("restored-workspace"), record: () => {} },
      },
    };
    const quiescence = await restored.quiesceWorkspace(remote);
    try {
      const result = await restored.reconcileWorkspace(request);
      await verifyReconciledWorkspaceFinal(result, quiescence);
      expect(result.getAppliedWorkspaceResult?.()?.conflictPaths).toEqual(["project.txt"]);
      expect(accepted).toBe(result.manifestRef);
    } finally {
      await quiescence.resume();
    }
    for (const workspace of [localPath, remote]) {
      await workspaceFiles(workspace).expect("project.txt", "Gateway project edit\n");
      await workspaceFiles(workspace).expect("result.txt", "worker result\n");
    }
    for (const name of ["SOUL.md", "USER.md", "IDENTITY.md"]) {
      await workspaceFiles(localPath).expect(name, `local bootstrap ${name}\n`);
    }
    await expectGit(localPath, [[["rev-parse", "HEAD"], gatewayCommit]]);
    await expectGit(remote, [
      [["rev-parse", "HEAD"], nodeCommit],
      [["rev-parse", `refs/heads/${nodeBranch}`], nodeCommit],
      [["rev-parse", "--is-shallow-repository"], "false"],
      [["branch", "--show-current"], ""],
      [["remote", "get-url", "origin"], nodeOrigin],
      [["config", "--get", "remote.origin.fetch"], "+refs/heads/*:refs/remotes/origin/*"],
    ]);
    for (const workspace of [localPath, remote]) {
      await workspaceFiles(workspace).expect("worker-commit.txt", "node commit content\n");
    }
    owner.abort();
    await expect(restored.reconcileWorkspace(request)).rejects.toThrow(
      "Node workspace transfer context is unavailable",
    );
  } finally {
    await fixture.close();
  }
});
