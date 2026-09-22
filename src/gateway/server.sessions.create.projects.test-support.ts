import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import { withTimeout } from "../infra/fs-safe.js";
import {
  getSessionWorkAdmissionRelease,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../sessions/session-lifecycle-admission.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { waitForChatAbortControllerRemoval } from "./chat-abort-lifecycle-internal.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";

const execFileAsync = promisify(execFile);

export async function copyGitWorkspace(template: string, root: string): Promise<string> {
  const workspace = path.join(root, "workspace");
  await fs.cp(template, workspace, {
    recursive: true,
    mode: fsConstants.COPYFILE_FICLONE,
  });
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
  return await fs.realpath(repo);
}

export async function settleWorkspaceRuns(
  context: { chatAbortControllers: Map<string, ChatAbortControllerEntry> },
  storePath: string,
  sessionKey: string | undefined,
  abort = false,
): Promise<void> {
  const targets = [...context.chatAbortControllers].map(([runId, entry]) => ({ runId, entry }));
  const released = getSessionWorkAdmissionRelease({
    scope: storePath,
    identities: [sessionKey],
  });
  if (abort) {
    for (const { entry } of targets) {
      entry.controller.abort();
    }
  }
  // Error paths revoke registration before persisting failure; the admission
  // retains custody until all dispatch and title work finishes in this test store.
  expect(
    await waitForChatAbortControllerRemoval({
      entries: context.chatAbortControllers,
      targets,
      timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
    }),
  ).toBe(true);
  if (released) {
    await withTimeout(released, SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS, "workspace run cleanup");
  }
}

export async function waitForCreatedSessionRun(
  context: { chatAbortControllers: Map<string, ChatAbortControllerEntry> },
  storePath: string,
  sessionKey: string | undefined,
) {
  const released = getSessionWorkAdmissionRelease({
    scope: storePath,
    identities: [sessionKey],
  });
  const removed = await waitForChatAbortControllerRemoval({
    entries: context.chatAbortControllers,
    targets: [...context.chatAbortControllers].map(([runId, entry]) => ({ runId, entry })),
    timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
  });
  if (released) {
    await withTimeout(
      released,
      SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      "worktree title run cleanup",
    );
  }
  return removed;
}
