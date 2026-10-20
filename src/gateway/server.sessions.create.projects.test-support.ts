import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import { withTimeout } from "../infra/fs-safe.js";
import {
  captureSessionControllerSettlement,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
} from "../sessions/session-controller.lifecycle.js";
import { requestRpcSourceCancellation } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { waitForChatAbortControllerRemoval } from "./chat-abort-lifecycle-internal.js";

const execFileAsync = promisify(execFile);

async function addWorkspaceOrigin(workspace: string): Promise<void> {
  const remote = `${workspace}.git`;
  await execFileAsync("git", ["clone", "--bare", workspace, remote]);
  await execFileAsync("git", ["-C", workspace, "remote", "add", "origin", remote]);
  await execFileAsync("git", ["-C", workspace, "fetch", "origin"]);
  await execFileAsync("git", ["-C", workspace, "remote", "set-head", "origin", "main"]);
}

export async function createGitWorkspace(root: string): Promise<string> {
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  await execFileAsync("git", ["-C", workspace, "init", "-b", "main"]);
  await fs.writeFile(path.join(workspace, "README.md"), "base\n");
  await execFileAsync("git", ["-C", workspace, "add", "README.md"]);
  await execFileAsync("git", [
    "-c",
    "user.name=OpenClaw Test",
    "-c",
    "user.email=openclaw-test@example.invalid",
    "-C",
    workspace,
    "commit",
    "-m",
    "initial",
  ]);
  await addWorkspaceOrigin(workspace);
  return await fs.realpath(workspace);
}

export async function copyGitWorkspace(template: string, root: string): Promise<string> {
  const workspace = path.join(root, "workspace");
  await fs.cp(template, workspace, {
    recursive: true,
    mode: fsConstants.COPYFILE_FICLONE,
  });
  await fs.cp(`${template}.git`, `${workspace}.git`, {
    recursive: true,
    mode: fsConstants.COPYFILE_FICLONE,
  });
  await execFileAsync("git", ["-C", workspace, "remote", "set-url", "origin", `${workspace}.git`]);
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

export async function initializeRepository(root: string, name: string): Promise<string> {
  const repo = path.join(root, name);
  await fs.mkdir(repo, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "OpenClaw Tests"]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "tests@openclaw.invalid"]);
  await fs.writeFile(path.join(repo, "README.md"), `${name}\n`);
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "initial"]);
  await addWorkspaceOrigin(repo);
  return await fs.realpath(repo);
}

export async function settleWorkspaceRuns(
  _context: unknown,
  storePath: string,
  sessionKey: string | undefined,
  abort = false,
): Promise<void> {
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
  // Error paths revoke registration before persisting failure; the admission
  // retains custody until all dispatch and title work finishes in this test store.
  expect(
    await waitForChatAbortControllerRemoval({
      targets,
      timeoutMs: SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
    }),
  ).toBe(true);
  if (released) {
    await withTimeout(released, SESSION_CONTROLLER_DRAIN_TIMEOUT_MS, "workspace run cleanup");
  }
}

export async function waitForCreatedSessionRun(
  _context: unknown,
  storePath: string,
  sessionKey: string | undefined,
) {
  const released = captureSessionControllerSettlement({
    scope: storePath,
    identities: [sessionKey],
  });
  const removed = await waitForChatAbortControllerRemoval({
    targets: [...rpcSourceTesting].map(([runId, entry]) => ({ runId, entry })),
    timeoutMs: SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
  });
  if (released) {
    await withTimeout(released, SESSION_CONTROLLER_DRAIN_TIMEOUT_MS, "worktree title run cleanup");
  }
  return removed;
}
