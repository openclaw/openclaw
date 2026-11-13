import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS } from "../gateway/github-repository-publication-snapshot.js";
import { prepareNodeWorkerPublicationIntegration } from "../gateway/worker-environments/node-worker-publication-transfer.js";
import { createNodeWorkspaceTransferCommand } from "../gateway/worker-environments/node-workspace-transfer-command.js";
import { createNodeWorkspaceTransferService } from "../gateway/worker-environments/node-workspace-transfer-service.js";
import {
  startNodeWorkspaceTransferTestServer,
  transferOwner,
} from "../gateway/worker-environments/node-workspace-transfer.test-support.js";
import { captureWorkspaceSnapshot } from "../gateway/worker-environments/workspace-manifest-worker.js";
import {
  NODE_WORKSPACE_EMPTY_MANIFEST_REF,
  NodeWorkerPublicationConflictError,
} from "../worker/node-workspace-transfer-protocol.js";
import { mergeNodeRepositoryPublication } from "./node-worker-publication-merge.js";
import { runNodeWorkerWorkspaceTransfer } from "./node-worker-transfer-client.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

it("restores exact retained ancestry through transfer without changing later editing state", async () => {
  const root = temporary.make("publication-merge-");
  const workspace = path.join(root, "workspace");
  const inputRoot = path.join(root, "input");
  await fs.mkdir(workspace);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_COUNT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: workspace, env, encoding: "utf8" }).trim();
  const write = (name: string, content: string) =>
    fs.writeFile(path.join(workspace, name), content);
  git("init", "--quiet", "--initial-branch=main");
  await write("upstream.txt", "old upstream\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  const baseCommit = git("rev-parse", "HEAD");
  await write("upstream.txt", "included upstream\n");
  git("commit", "--quiet", "-am", "intermediate main");
  const parent = git("rev-parse", "HEAD");
  await write("fix.txt", "saved repair\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "accepted repair");
  const headCommit = git("rev-parse", "HEAD");
  execFileSync(
    process.execPath,
    ["-e", REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS, workspace, baseCommit, inputRoot],
    { env },
  );
  const snapshotDigest = `sha256:${createHash("sha256")
    .update(await fs.readFile(path.join(inputRoot, "snapshot.json")))
    .digest("hex")}`;
  const gitPackPath = path.join(root, "history.pack");
  await fs.writeFile(
    gitPackPath,
    execFileSync("git", ["pack-objects", "--revs", "--stdout"], {
      cwd: workspace,
      env,
      input: `${headCommit}\n^${baseCommit}\n`,
    }),
  );
  git("reset", "--hard", parent);
  await write("upstream.txt", "latest upstream\n");
  git("commit", "--quiet", "-am", "latest main");
  const targetCommit = git("rev-parse", "HEAD");
  git("reflog", "expire", "--expire=now", "--all");
  git("gc", "--prune=now");
  expect(spawnSync("git", ["cat-file", "-e", headCommit], { cwd: workspace, env }).status).not.toBe(
    0,
  );
  await write("fix.txt", "later editing work\n");
  git("add", "fix.txt");
  await write("fix.txt", "later unstaged work\n");
  const index = await fs.readFile(path.join(workspace, ".git", "index"));
  const input = {
    workspaceDir: workspace,
    inputRoot,
    inputDigest: snapshotDigest,
    outputRoot: path.join(root, "negative"),
    sourceUrl: pathToFileURL(workspace).href,
    targetUrl: pathToFileURL(workspace).href,
    targetCommit,
    token: "synthetic-token",
  };
  // Without its real parent, the normalized checkpoint falsely conflicts with later upstream edits.
  await expect(mergeNodeRepositoryPublication(input)).rejects.toBeInstanceOf(
    NodeWorkerPublicationConflictError,
  );
  await fs.copyFile(gitPackPath, path.join(inputRoot, "history.pack"));
  await expect(
    mergeNodeRepositoryPublication({
      ...input,
      gitHistory: { baseCommit, headCommit: parent, descendsFromBase: true },
    }),
  ).rejects.toBeInstanceOf(NodeWorkerPublicationConflictError);
  await fs.rm(path.join(inputRoot, "history.pack"));
  const service = createNodeWorkspaceTransferService({
    temporaryRoot: path.join(root, "transfers"),
    getOwner: () => transferOwner("session"),
  });
  await service.prepareRepository({
    environmentId: "environment",
    ownerEpoch: 1,
    sessionId: "session",
    baseCommit,
    baseManifestRef: NODE_WORKSPACE_EMPTY_MANIFEST_REF,
    isAuthorized: () => true,
  });
  const editingSnapshot = {
    ...(await captureWorkspaceSnapshot({ root: inputRoot, baseCommit: null })),
    root: inputRoot,
  };
  const editingToken = service.publishSnapshot("environment", editingSnapshot);
  await service.revoke("environment", editingToken);
  const server = await startNodeWorkspaceTransferTestServer(service);
  onTestFinished(async () => {
    await service.closeAll();
    await server.close();
  });
  const signal = new AbortController().signal;
  const transfer = createNodeWorkspaceTransferCommand(async (command) => {
    if (!command.transfer) {
      throw new Error("Expected a publication transfer");
    }
    const stdout = await runNodeWorkerWorkspaceTransfer({
      gatewayUrl: server.gatewayUrl,
      environmentId: "environment",
      workspaceDir: workspace,
      manifestHome: root,
      transfer: command.transfer,
      signal,
    });
    return {
      code: 0,
      termination: "exit",
      signal: null,
      killed: false,
      stdout,
      stderr: "",
      workspaceDir: workspace,
    };
  });
  const integrated = await prepareNodeWorkerPublicationIntegration(
    {
      environmentId: "environment",
      signal,
      workspaceTransfer: service,
      supportsIntegration: async () => true,
      transfer,
    },
    {
      snapshotRoot: inputRoot,
      snapshotDigest,
      sourceUrl: input.sourceUrl,
      targetUrl: input.targetUrl,
      targetCommit,
      token: "synthetic-token",
      assertCurrent: () => {},
      history: { gitPackPath, gitHistory: { baseCommit, headCommit, descendsFromBase: true } },
    },
  );
  try {
    expect(integrated.snapshot.baseCommit).toBe(targetCommit);
    expect(integrated.snapshot.entries.map((entry) => entry.path)).toEqual(["fix.txt"]);
    expect(
      await fs.readFile(
        path.join(integrated.snapshotRoot, "blobs", integrated.snapshot.entries[0]!.sha!),
        "utf8",
      ),
    ).toBe("saved repair\n");
  } finally {
    await integrated.release();
  }
  const emptyWorkspace = path.join(root, "empty-objects");
  await fs.mkdir(emptyWorkspace);
  execFileSync("git", ["init", "--bare", "--quiet"], { cwd: emptyWorkspace, env });
  await expect(
    mergeNodeRepositoryPublication({
      ...input,
      workspaceDir: emptyWorkspace,
      sourceUrl: pathToFileURL(path.join(root, "missing-source")).href,
    }),
  ).rejects.toThrow("fetch=source-base");
  expect(service.getSnapshot("environment", editingSnapshot.manifestRef)).toBeDefined();
  expect(git("rev-parse", "HEAD")).toBe(targetCommit);
  expect(git("symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(await fs.readFile(path.join(workspace, ".git", "index"))).toEqual(index);
  expect(await fs.readFile(path.join(workspace, "fix.txt"), "utf8")).toBe("later unstaged work\n");
});
