import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { AgentSandboxConfig } from "../config/types.agents-shared.js";
import { resolveExecModePolicy } from "../infra/exec-approvals-core.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { createTestOperatorAuthority } from "./admitted-run-context.test-support.js";
import { projectAgentToolsExecPolicy } from "./agent-tools.execution-policy.js";
import { resolveExecToolConfig } from "./lazy-exec-tool.js";
import { prepareParticipationTestRun } from "./participation-ceiling.test-support.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";
import { prepareRunSessionPermissionPolicy } from "./session-permission-policy.js";
import { resolveAttemptWorkspaceSandbox, resolveHarnessWorkspace } from "./workspace-sandbox.js";
import { readRegistryWorktrees } from "./worktrees/registry-read.js";
import { insertRegistryWorktree } from "./worktrees/registry.js";
import { makeWorktreeRecord } from "./worktrees/service.test-support.js";

const sandboxConfig = (sandbox: AgentSandboxConfig) => ({ agents: { defaults: { sandbox } } });
const runParams = (workspaceDir: string, sessionId = "execution") => ({
  workspaceDir,
  sessionId,
  sessionKey: "agent:main:" + sessionId,
  agentId: "main",
});

it("records managed workspace use and retains default-mode participant execution policy", async () => {
  await withOpenClawTestState({ label: "workspace-activity" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    const params = runParams(state.workspaceDir, "activity");
    const record = makeWorktreeRecord(state.workspaceDir, "activity-worktree", {
      ownerId: params.sessionKey,
    });
    await insertRegistryWorktree(state.env, record);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: params.sessionKey },
      {
        sessionId: params.sessionId,
        updatedAt: 1,
        worktree: { id: record.id, branch: record.branch, repoRoot: record.repoRoot },
      },
    );
    const started = Date.now();
    using owner = await resolveAttemptWorkspaceSandbox({
      ...params,
      config: sandboxConfig({ mode: "off" }),
    });
    const updated = (await readRegistryWorktrees(state.env)).find((row) => row.id === record.id);
    expect(updated?.lastActiveAt).toBeGreaterThanOrEqual(started);
    expect(owner.effectiveCwd).toBe(state.workspaceDir);
    expect(owner.sessionPermissionPolicy).toBeUndefined();
    const participationCeiling = {
      kind: "send",
      profileId: "guest",
      sessionKey: params.sessionKey,
      permission: "workspace",
      source: {
        agentId: "main",
        sessionId: params.sessionId,
        lifecycleRevision: null,
        creatorProfileId: "creator",
        root: state.workspaceDir,
      },
    } as const;
    for (const [mode, expected] of [
      ["full", "workspace"],
      ["ask", "guarded"],
      ["allowlist", "guarded"],
      ["deny", "read-only"],
    ] as const) {
      using workspace = await resolveAttemptWorkspaceSandbox({
        ...params,
        sessionRoot: state.workspaceDir,
        admittedRunContext:
          await prepareParticipationTestRun(participationCeiling).preparedRunAdmission.admit(
            "embedded",
          ),
        config: { ...sandboxConfig({ mode: "off" }), tools: { exec: { mode } } },
      });
      expect(workspace.sessionPermissionPolicy).toMatchObject({
        root: state.workspaceDir,
        mode: expected,
      });
      const exec = projectAgentToolsExecPolicy({
        options: {
          ...prepareParticipationTestRun(participationCeiling),
          sessionPermissionPolicy: workspace.sessionPermissionPolicy,
          exec: { mode: expected === "guarded" ? "ask" : mode },
        },
        execConfig: resolveExecToolConfig({ cfg: { tools: { exec: { mode } } } }),
        model: {},
      });
      if (mode === "allowlist") {
        expect(exec).toMatchObject({ security: "allowlist", ask: "off" });
      }
    }
    expect(
      await prepareRunSessionPermissionPolicy({
        root: state.workspaceDir,
        agentId: "main",
        sandboxAvailable: true,
        ...prepareParticipationTestRun(participationCeiling),
      }),
    ).toMatchObject({ mode: "workspace", execPolicy: { security: "allowlist", ask: "on-miss" } });
    using alwaysAsk = await resolveAttemptWorkspaceSandbox({
      ...params,
      admittedRunContext:
        await prepareParticipationTestRun(participationCeiling).preparedRunAdmission.admit(
          "embedded",
        ),
      config: { tools: { exec: { security: "allowlist", ask: "always" } } },
    });
    const exact = projectAgentToolsExecPolicy({
      options: {
        ...prepareParticipationTestRun(participationCeiling),
        sessionPermissionPolicy: alwaysAsk.sessionPermissionPolicy,
      },
      execConfig: resolveExecToolConfig({}),
      model: {},
    });
    expect(
      resolveExecModePolicy({
        ...exact,
        security: exact.security ?? "full",
        ask: exact.ask ?? "off",
      }),
    ).toMatchObject({ security: "allowlist", ask: "always" });
  });
});

it("uses only admitted participation authority for the original root and permission floor", async () => {
  await withOpenClawTestState({ label: "admitted-participation-workspace" }, async (state) => {
    const root = state.path("original-root");
    await fs.mkdir(root);
    const authority = createTestOperatorAuthority({
      canonicalIdentity: null,
      profileId: "guest",
      scopes: [],
      participationCeiling: {
        kind: "send",
        profileId: "guest",
        sessionKey: "agent:main:original",
        permission: "read-only",
        tools: ["read"],
        source: {
          agentId: "main",
          lifecycleRevision: null,
          sessionId: "original",
          creatorProfileId: "creator",
          root,
        },
      },
    });
    const admission = prepareSystemAgentRunAdmission(
      {},
      "authority-only",
      "main",
      "test",
      undefined,
      authority,
    );
    try {
      using workspace = await resolveAttemptWorkspaceSandbox({
        ...runParams(state.workspaceDir),
        admittedRunContext: await admission.admit("embedded"),
        sessionRoot: state.workspaceDir,
        permissionMode: "full",
      });
      expect(workspace.sessionPermissionRoot).toBe(root);
      expect(workspace.effectiveFsWorkspaceOnly).toBe(true);
      expect(workspace.sessionPermissionPolicy).toMatchObject({ root, mode: "read-only" });
    } finally {
      admission.close();
    }
  });
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
      const resolveRealpath = fs.realpath.bind(fs);
      using realpath = vi.spyOn(fs, "realpath");
      if (boundary === "realpath") {
        realpath.mockImplementation(async (path, options) => {
          if (path === state.workspaceDir) {
            scope.close();
            return state.workspaceDir;
          }
          return resolveRealpath(path, options);
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
      ).rejects.toThrow("This agent run is no longer active. Start a new turn to retry.");
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
