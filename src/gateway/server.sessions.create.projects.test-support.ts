import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import { managedWorktrees } from "../agents/worktrees/service.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { withTimeout } from "../infra/fs-safe.js";
import type { registerProjectRegistry } from "../projects/project-registry.js";
import {
  captureSessionControllerSettlement,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
} from "../sessions/session-controller.lifecycle.js";
import { requestRpcSourceCancellation } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import type { SessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../state/session-repository-workspaces.types.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { waitForChatAbortControllerRemoval } from "./chat-abort-lifecycle-internal.js";
import type { directSessionReq } from "./test/server-sessions.test-helpers.js";

const execFileAsync = promisify(execFile);
const git = (repo: string, ...args: string[]) => execFileAsync("git", ["-C", repo, ...args]);

async function addWorkspaceOrigin(workspace: string): Promise<void> {
  const remote = `${workspace}.git`;
  await execFileAsync("git", ["clone", "--bare", workspace, remote]);
  await git(workspace, "remote", "add", "origin", remote);
  await git(workspace, "fetch", "origin");
  await git(workspace, "remote", "set-head", "origin", "main");
}

export const createGitWorkspace = (root: string) =>
  initializeRepository(root, "workspace", "base\n");

export async function copyGitWorkspace(template: string, root: string): Promise<string> {
  const workspace = path.join(root, "workspace");
  for (const suffix of ["", ".git"]) {
    await fs.cp(`${template}${suffix}`, `${workspace}${suffix}`, {
      recursive: true,
      mode: fsConstants.COPYFILE_FICLONE,
    });
  }
  await git(workspace, "remote", "set-url", "origin", `${workspace}.git`);
  return await fs.realpath(workspace);
}

export const controlUiClient = {
  client: {
    connect: {
      scopes: ["operator.write"],
      client: {
        id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        version: "dev",
        platform: "web",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    },
  } as never,
};

export async function successfulSessionRequest<T = unknown>(
  ...args: Parameters<typeof directSessionReq<T>>
) {
  const { directSessionReq } = await import("./test/server-sessions.test-helpers.js");
  const result = await directSessionReq<T>(...args);
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  return result.payload!;
}

export function expectPreparedProject(
  entry: SessionEntry | null | undefined,
  sessionId: string,
  project: Awaited<ReturnType<typeof registerProjectRegistry>>,
  projectRoot: string,
) {
  expect(entry).toMatchObject({
    sessionId,
    projectId: project.id,
    worktree: { canonicalWorkspaceDir: projectRoot },
  });
  expect(entry?.spawnedCwd).not.toBe(projectRoot);
}

export function retryRemoteProjectSession(
  sessionKey: string,
  runId: string,
  context: Record<string, unknown>,
) {
  return successfulSessionRequest<{ runId: string; status: string }>(
    "chat.send",
    { sessionKey, agentId: "main", message: "Retry the remote project", idempotencyKey: runId },
    { ...controlUiClient, context },
  );
}

export async function removeOwnedSessionWorktree(key?: string) {
  const owned = key ? await managedWorktrees.findLiveByOwner("session", key) : undefined;
  if (owned) {
    await managedWorktrees.remove({
      id: owned.id,
      reason: "test-cleanup",
      allowSnapshotLoss: true,
    });
  }
}

export async function initializeRepository(root: string, name: string, readme = `${name}\n`) {
  const repo = path.join(root, name);
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "OpenClaw Tests");
  await git(repo, "config", "user.email", "tests@openclaw.invalid");
  await fs.writeFile(path.join(repo, "README.md"), readme);
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  await addWorkspaceOrigin(repo);
  return await fs.realpath(repo);
}

export async function settleWorkspaceRuns(
  ...scope: Parameters<typeof waitForCreatedSessionRun>
): Promise<void> {
  // Admission retains dispatch/title custody even after error-path deregistration.
  expect(await waitForCreatedSessionRun(...scope)).toBe(true);
}

export async function waitForCreatedSessionRun(
  _context: unknown,
  storePath: string,
  sessionKey: string | undefined,
  abort = false,
) {
  const targets = [...rpcSourceTesting].map(([runId, entry]) => ({ runId, entry }));
  const released = captureSessionControllerSettlement({
    scope: storePath,
    identities: [sessionKey],
  });
  if (abort) {
    for (const { entry } of targets) {
      requestRpcSourceCancellation(entry);
    }
  }
  const removed = await waitForChatAbortControllerRemoval({
    targets,
    timeoutMs: SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
  });
  if (released) {
    await withTimeout(released, SESSION_CONTROLLER_DRAIN_TIMEOUT_MS, "worktree title run cleanup");
  }
  return removed;
}

export async function publishRepositoryFixtureCheckpoint(
  store: SessionRepositoryWorkspaceStore,
  source: SessionRepositoryWorkspaceRecord,
  root: string,
) {
  const [{ captureWorkspaceManifest }, { serializeWorkerWorkspaceManifest }, checkpoints] =
    await Promise.all([
      import("./worker-environments/workspace-manifest-worker.js"),
      import("./worker-environments/workspace-manifest.js"),
      import("./worker-environments/session-repository-checkpoints.js"),
    ]);
  const baseCommit = "a".repeat(40);
  const base = await captureWorkspaceManifest({ root, baseCommit });
  const workspace = await store.bindBase({
    workspaceId: source.workspaceId,
    expectedRevision: source.revision,
    baseCommit,
    baseManifestHash: base.manifestRef,
    assertCurrent() {},
  });
  await fs.writeFile(path.join(root, "parent.txt"), "accepted parent bytes\n");
  const current = await captureWorkspaceManifest({ root, baseCommit });
  const checkpoint = await checkpoints.stageSessionRepositoryCheckpoint({
    store,
    workspaceId: workspace.workspaceId,
    expectedRevision: workspace.revision,
    stagingRoot: root,
    baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
    currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
    baseManifestRef: base.manifestRef,
    currentManifestRef: current.manifestRef,
    assertCurrent() {},
  });
  return await checkpoint.publish();
}
