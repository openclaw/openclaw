import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { AgentSandboxConfig } from "../config/types.agents-shared.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";
import { resolveAttemptWorkspaceSandbox, resolveHarnessWorkspace } from "./workspace-sandbox.js";

const sandboxConfig = (sandbox: AgentSandboxConfig) => ({ agents: { defaults: { sandbox } } });
const runParams = (workspaceDir: string, sessionId = "execution") => ({
  workspaceDir,
  sessionId,
  sessionKey: "agent:main:" + sessionId,
  agentId: "main",
});

it("keeps cwd authority with the selected local or remote workspace owner", () => {
  const sandbox = createSandboxTestContext({ overrides: { workspaceSource: "managed-worktree" } });
  const prepared = {
    effectiveCwd: "/private",
    effectiveWorkspace: "/private",
    resolvedWorkspace: "/canonical",
    sessionPermissionRoot: "/private",
    sandbox,
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
  await withOpenClawTestState({ label: "retired-workspace" }, async (state) => {
    const workspaceDir = state.path("must-not-exist");
    await expect(
      resolveAttemptWorkspaceSandbox({
        ...runParams(workspaceDir, "retired"),
        config: { agents: { entries: { main: { workspace: workspaceDir } } } },
        admittedRunContext: { operationalRunInstance: { runId: "retired", instanceId: "retired" } },
      }),
    ).rejects.toThrow("active admitted run");
    await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("keeps writable placement policy without preparing its paths locally", async () => {
  await withOpenClawTestState({ label: "placement-workspace-policy" }, async (state) => {
    const remoteWorkspace = state.path("remote-execution-only");
    const preparation = resolveAttemptWorkspaceSandbox({
      ...runParams(state.workspaceDir, "remote-policy"),
      requireWorkspaceOnly: true,
      config: sandboxConfig({ mode: "all", backend: "unavailable-fixture" }),
      placementSandbox: createSandboxTestContext({
        overrides: {
          workspaceDir: remoteWorkspace,
          agentWorkspaceDir: remoteWorkspace,
          containerWorkdir: "/native/guest",
        },
      }),
    });
    await expect(preparation).resolves.toMatchObject({
      effectiveWorkspace: state.workspaceDir,
      effectiveCwd: state.workspaceDir,
      effectiveFsWorkspaceOnly: true,
      sandbox: null,
    });
    await expect(fs.stat(remoteWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it.each(["realpath", "mkdir"] as const)(
  "rejects workspace preparation revoked during %s",
  async (boundary) => {
    await withOpenClawTestState({ label: "workspace-preparation-authority" }, async (state) => {
      const config = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
      const admission = prepareSystemAgentRunAdmission(config, boundary, "main", "test");
      const admittedRunContext = await admission.admit("embedded");
      using scope = { close: admission.close, [Symbol.dispose]: admission.close };
      using mkdir = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
      using realpath = vi.spyOn(fs, "realpath");
      if (boundary === "realpath") {
        realpath.mockImplementationOnce(async () => {
          scope.close();
          return state.workspaceDir;
        });
      } else {
        mkdir.mockImplementationOnce(async () => {
          scope.close();
          return undefined;
        });
      }
      await expect(
        resolveAttemptWorkspaceSandbox({
          config,
          ...runParams(state.workspaceDir, "workspace-preparation"),
          placementSandbox: createSandboxTestContext(),
          admittedRunContext,
        }),
      ).rejects.toThrow("admitted run authority is no longer active");
      // A revoked path lookup must not admit the following directory mutation.
      expect(mkdir).toHaveBeenCalledOnce();
    });
  },
);

it.each([false, true])("uses independent policy session (required=%s)", async (required) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const identity = "UNMATERIALIZED_SANDBOX_IDENTITY";
    await captureRuntimeConfigAsyncReader()();
    const sessionId = required ? "required" : "optional";
    const sessionKey = "agent:main:" + sessionId;
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId,
        updatedAt: 1,
        sandboxMode: "off",
        ...(required ? { sandbox: "required" as const } : {}),
      },
    );
    const prepare = () =>
      resolveAttemptWorkspaceSandbox({
        ...runParams(state.workspaceDir),
        sandboxSessionKey: sessionKey,
        config: sandboxConfig({
          mode: required ? "off" : "all",
          ...(required && {
            backend: "ssh",
            ssh: {
              target: "sandbox@example.invalid",
              identityData: { source: "env" as const, provider: "default", id: identity },
            },
          }),
        }),
      });
    if (required) {
      await expect(prepare()).rejects.toMatchObject({
        code: "sandbox_provisioning",
        cause: { code: "SECRET_SURFACE_UNAVAILABLE", ownerId: "agent-sandbox:main" },
      });
      return;
    }
    using mkdir = vi.spyOn(fs, "mkdir");
    const observed = observeHostDataSql();
    using sql = { queries: observed.queries, [Symbol.dispose]: observed.restore };
    expect(await prepare()).toMatchObject({
      sandbox: null,
      sandboxReport: { mode: "all", sandboxed: false },
    });
    expect(mkdir.mock.calls.filter(([dir]) => dir === state.workspaceDir)).toHaveLength(1);
    expect(
      sql.queries.filter((query) => /\bsession_(?:nodes|windows|participants)\b/.test(query)),
    ).toEqual([]);
  });
});
