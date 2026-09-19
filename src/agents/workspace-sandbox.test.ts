import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";
import { resolveAttemptWorkspaceSandbox, resolveHarnessWorkspace } from "./workspace-sandbox.js";

it("keeps cwd authority with the selected local or remote workspace owner", () => {
  const sandbox = createSandboxTestContext({
    overrides: {
      workspaceSource: "managed-worktree",
      workspaceDir: "/private",
      workspaceAccess: "rw",
    },
  });
  const prepared = {
    effectiveCwd: "/private",
    effectiveWorkspace: "/private",
    resolvedWorkspace: "/canonical",
    effectiveFsWorkspaceOnly: true,
    sessionPermissionRoot: "/private",
    sessionPermissionPolicy: undefined,
    sandbox,
    sandboxSessionKey: "guest",
    sessionAgentId: "main",
  };
  expect(() =>
    resolveHarnessWorkspace("/canonical", { cwd: "/outside" }, prepared, sandbox),
  ).toThrow("cwd override");
  expect(
    resolveHarnessWorkspace(
      "/canonical",
      { cwd: "/remote/subdir", sessionRoot: "/remote" },
      prepared,
      createSandboxTestContext(),
    ),
  ).toEqual({ workspaceDir: "/canonical", cwd: "/remote/subdir", sessionRoot: "/remote" });
});

it("refuses a retired admitted run before creating or preparing its workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-retired-workspace-"));
  const workspaceDir = path.join(root, "must-not-exist");
  try {
    await expect(
      resolveAttemptWorkspaceSandbox({
        workspaceDir,
        sessionId: "retired",
        sessionKey: "agent:main:retired",
        agentId: "main",
        config: { agents: { entries: { main: { workspace: workspaceDir } } } },
        admittedRunContext: { operationalRunInstance: { runId: "retired", instanceId: "retired" } },
      }),
    ).rejects.toThrow("active admitted run");
    await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
