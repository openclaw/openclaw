import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import type { SandboxBackendHandle } from "../../agents/sandbox/backend-handle.types.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { createSandboxFsBridge } from "../../agents/sandbox/fs-bridge.js";
import {
  bindLocalSandboxWorkspace,
  prepareLocalSandboxWorkspace,
} from "../../agents/sandbox/local-workspace.js";
import { createSandboxTestContext } from "../../agents/sandbox/test-fixtures.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

export async function proveStoppedLocalWorkspaceCheckpoint(owner: LocalWorkspaceOwner) {
  await insertRegistryWorktree(process.env, owner.worktree);
  const sessionScope = { agentId: owner.agentId, sessionKey: owner.sessionKey };
  const entry = {
    sessionId: owner.sessionId,
    updatedAt: 1,
    worktree: {
      id: owner.worktree.id,
      branch: owner.worktree.branch,
      repoRoot: owner.worktree.repoRoot,
    },
  };
  await replaceSessionEntry(sessionScope, entry);
  const controller = new AbortController();
  let hostCurrent = true;
  using projection = await prepareLocalSandboxWorkspace({
    cfg: { worktreeAcceleration: false },
    agentId: owner.agentId,
    sessionKey: owner.sessionKey,
    workspaceDir: owner.worktree.path,
    sandbox: resolveSandboxConfigForAgent({}, owner.agentId),
    assertCurrent: () => controller.signal.throwIfAborted(),
    assertHost: () => {
      if (!hostCurrent) {
        throw new Error("Gateway owner closed");
      }
    },
  });
  if (!projection) {
    throw new Error("Expected managed projection");
  }
  const backend: SandboxBackendHandle = {
    id: "docker",
    runtimeId: "stopped-command",
    runtimeLabel: "stopped-command",
    workdir: "/workspace",
    buildExecSpec: async () => ({ argv: ["true"], env: {}, stdinMode: "pipe-closed" }),
    runShellCommand: async () => {
      throw new Error("New shell work must remain blocked");
    },
  };
  const sandbox = createSandboxTestContext({
    overrides: { workspaceDir: projection.workspaceDir, backend },
  });
  sandbox.fsBridge = createSandboxFsBridge({ sandbox: { ...sandbox, backend } });
  bindLocalSandboxWorkspace(sandbox, projection);
  await backend.buildExecSpec({ command: "true", env: {}, usePty: false });
  await fs.writeFile(path.join(projection.workspaceDir, "source.txt"), "stopped guest edit\n");
  const reason = createAgentRunDirectAbortError();
  controller.abort(reason);
  const outcome = { status: "failed" as const, exitCode: 0, timedOut: false };
  await expect(backend.finalizeExec!(outcome)).resolves.toBeUndefined();
  expect(await fs.readFile(path.join(owner.worktree.path, "source.txt"), "utf8")).toBe(
    "stopped guest edit\n",
  );
  await expect(backend.runShellCommand({ script: "true" })).rejects.toBe(reason);
  await expect(backend.buildExecSpec({ command: "true", env: {}, usePty: false })).rejects.toBe(
    reason,
  );
  await expect(
    sandbox.fsBridge.writeFile({ filePath: "late.txt", data: "must not write" }),
  ).rejects.toBe(reason);
  await expect(fs.stat(path.join(projection.workspaceDir, "late.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  hostCurrent = false;
  await expect(backend.finalizeExec!(outcome)).rejects.toThrow("Gateway owner closed");
  hostCurrent = true;
  await fs.writeFile(path.join(projection.workspaceDir, "source.txt"), "guest conflict\n");
  await fs.writeFile(path.join(owner.worktree.path, "source.txt"), "human conflict\n");
  await expect(backend.finalizeExec!(outcome)).rejects.toThrow("conflict");
  await fs.writeFile(path.join(owner.worktree.path, "source.txt"), "stopped guest edit\n");
  await backend.finalizeExec!(outcome);
  await replaceSessionEntry(sessionScope, { ...entry, sessionId: randomUUID(), updatedAt: 2 });
  await expect(backend.finalizeExec!(outcome)).rejects.toThrow(
    "Local sandbox workspace authority changed",
  );
}
