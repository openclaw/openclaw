// Real MXC policy selection composed with host-owned sandbox context and workspace preparation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createMxcSandboxBackendFactory,
  resolveConfig,
  resolveMxcAgentConfig,
} from "../../extensions/mxc/test-api.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../src/agents/admitted-run-context.js";
import {
  registerSandboxBackend,
  type CreateSandboxBackendParams,
} from "../../src/agents/sandbox/backend.js";
import {
  ensureSandboxWorkspaceForSession,
  resolveSandboxContext,
} from "../../src/agents/sandbox/context.js";
import { sandboxConfig } from "../../src/agents/test-helpers/sandbox-backend-fixtures.js";
import * as localWorkspaceProjection from "../../src/gateway/worker-environments/local-workspace-projection.js";
import type { LocalWorkspaceOwner } from "../../src/gateway/worker-environments/local-workspace-types.js";
import type { SkillSnapshot } from "../../src/skills/types.js";
import { closeOpenClawAgentDatabasesAsync } from "../../src/state/openclaw-agent-db.js";

const updateRegistryMock = vi.hoisted(() => vi.fn());
const readRegisteredSandboxRuntimeIdsMock = vi.hoisted(() => vi.fn(async () => [] as string[]));
const syncSkillsToWorkspaceMock = vi.hoisted(() =>
  vi.fn<
    typeof import("../../src/skills/loading/workspace-skill-sync.runtime.js").syncWorkspaceSkills
  >(async () => []),
);
const ensureSandboxBrowserMock = vi.hoisted(() =>
  vi.fn<typeof import("../../src/agents/sandbox/browser.js").ensureSandboxBrowser>(
    async () => null,
  ),
);
const resolveNodeExecEligibilityMock = vi.hoisted(() => vi.fn(() => ({ canExec: false })));
const browserControlAuthMock = vi.hoisted(() => ({
  ensureBrowserControlAuth: vi.fn(async () => ({ auth: { token: "test-browser-token" } })),
  resolveBrowserControlAuth: vi.fn(() => ({ token: "test-browser-token" })),
}));
const browserProfilesMock = vi.hoisted(() => ({
  DEFAULT_BROWSER_EVALUATE_ENABLED: true,
  resolveBrowserConfig: vi.fn(() => ({
    evaluateEnabled: true,
    ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
  })),
}));
const containerEngineMocks = vi.hoisted(() => ({
  resolvePodmanSandboxRuntimeInfo: vi.fn(),
}));

// mock-isolation: Keep fixture runtime discovery and registry writes out of the shared state DB.
vi.mock("../../src/agents/sandbox/registry.js", () => ({
  readRegisteredSandboxRuntimeIds: readRegisteredSandboxRuntimeIdsMock,
  updateRegistry: updateRegistryMock,
}));

// mock-isolation: MXC context composition excludes browser container and bridge lifecycle state.
vi.mock("../../src/agents/sandbox/browser.js", () => ({
  ensureSandboxBrowser: ensureSandboxBrowserMock,
}));

// mock-isolation: Use fixed test credentials without loading browser plugin auth or generating config state.
vi.mock("../../src/plugin-sdk/browser-control-auth.js", () => browserControlAuthMock);

// mock-isolation: Use fixture browser defaults without resolving activated browser plugin profiles.
vi.mock("../../src/plugin-sdk/browser-profiles.js", () => browserProfilesMock);

vi.mock("../../src/agents/sandbox/docker.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/agents/sandbox/docker.js")>(
    "../../src/agents/sandbox/docker.js",
  );
  return {
    ...actual,
    resolvePodmanSandboxRuntimeInfo: containerEngineMocks.resolvePodmanSandboxRuntimeInfo,
  };
});

// mock-isolation: Pin skill node eligibility without reading host exec approval state.
vi.mock("../../src/agents/exec-defaults.js", () => ({
  resolveNodeExecEligibility: resolveNodeExecEligibilityMock,
}));

// mock-isolation: Use fixed skill eligibility without consulting process-wide remote node state.
vi.mock("../../src/skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: vi.fn(() => ({ note: "test-remote" })),
}));

// mock-isolation: Observe snapshot forwarding without materializing private library skills or writing skill files.
vi.mock("../../src/skills/loading/workspace-skill-sync.runtime.js", () => ({
  syncWorkspaceSkills: syncSkillsToWorkspaceMock,
}));

let sandboxFixtureRoot = "";
let sandboxFixtureCount = 0;

async function createSandboxFixtureDir(prefix: string): Promise<string> {
  // Shared fixture root avoids repeated temp-dir setup across sandbox context cases.
  const dir = path.join(sandboxFixtureRoot, `${prefix}-${sandboxFixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  // openclaw-temp-dir: allow canonical suite root is drained before removal
  sandboxFixtureRoot = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-sandbox-context-"),
  );
});

afterAll(async () => {
  await closeOpenClawAgentDatabasesAsync(sandboxFixtureRoot);
  await fs.rm(sandboxFixtureRoot, { recursive: true, force: true });
});

describe("MXC sandbox context composition", () => {
  it.runIf(process.platform === "win32").each(["released", "reassigned"])(
    "rejects retained effects after the admitted owner is %s",
    async (retirement) => {
      const root = await createSandboxFixtureDir("mxc-owner-" + retirement);
      const workspaceDir = path.join(root, "workspace");
      await fs.mkdir(workspaceDir);
      const config = sandboxConfig("mxc", { scope: "agent", workspaceAccess: "rw" });
      config.session = { store: path.join(root, "sessions.json") };
      const runId = "mxc-retained-owner-" + retirement;
      const prepare = () =>
        prepareAgentRunAdmission({
          cfg: config,
          facts: {
            runId,
            agentId: "analyst",
            ingress: { kind: "system", boundary: "test", state: "present" },
          },
          operationalRunInstance: createOperationalRunInstanceRef(runId),
        });
      const owner = prepare();
      const replacement = prepare();
      const restore = registerSandboxBackend(
        "mxc",
        createMxcSandboxBackendFactory(resolveConfig({ agents: { analyst: { network: "none" } } })),
      );
      try {
        const admitted = await owner.admit("embedded");
        const sandbox = await resolveSandboxContext({
          config,
          agentId: "analyst",
          sessionKey: "agent:analyst:owner-" + retirement,
          workspaceDir,
          assertCurrent: resolveAdmittedRunActiveAssertion(admitted),
          admittedRunContext: admitted,
        });
        const backend = sandbox!.backend!;
        const spec = await backend.buildExecSpec({
          command: "echo admitted",
          env: {},
          usePty: false,
        });
        try {
          if (retirement === "released") {
            owner.close();
          } else {
            await replacement.admit("embedded");
          }
          expect(() => spec.assertCurrent?.()).toThrow("no longer active");
          await expect(
            backend.buildExecSpec({ command: "echo stale", env: {}, usePty: false }),
          ).rejects.toThrow("no longer active");
          await expect(backend.runShellCommand({ script: "echo stale" })).rejects.toThrow(
            "no longer active",
          );
          await expect(
            sandbox!.fsBridge!.writeFile({ filePath: "retired.txt", data: "must not be written" }),
          ).rejects.toThrow("no longer active");
          await expect(fs.stat(path.join(workspaceDir, "retired.txt"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        } finally {
          await backend.finalizeExec?.({
            status: "failed",
            exitCode: null,
            timedOut: false,
            token: spec.finalizeToken,
          });
        }
      } finally {
        owner.close();
        replacement.close();
        restore();
      }
    },
  );

  it.each(["ro", "none"] as const)(
    "composes private skill selection with selected MXC policy for %s workspace callbacks",
    async (workspaceAccess) => {
      const root = await createSandboxFixtureDir(`mxc-private-${workspaceAccess}`);
      const workspaceDir = path.join(root, "workspace");
      await fs.mkdir(workspaceDir);
      const config = sandboxConfig("mxc", {
        scope: "shared",
        workspaceAccess,
        workspaceRoot: path.join(root, "sandboxes"),
      });
      config.session = { store: path.join(root, "sessions.json") };
      const mxcConfig = resolveConfig({
        network: "default",
        timeoutSeconds: 120,
        agents: { analyst: { network: "none", timeoutSeconds: 7, mxcPolicyPaths: [] } },
      });
      const factory = vi.fn(createMxcSandboxBackendFactory(mxcConfig));
      const resolveWorkdir = vi.fn((params: CreateSandboxBackendParams) => {
        expect(resolveMxcAgentConfig(mxcConfig, params.agentId, params.cfg.scope)).toMatchObject({
          network: "none",
          timeoutSeconds: 7,
          mxcPolicyPaths: [],
        });
        return params.workspaceDir;
      });
      const restore = registerSandboxBackend("mxc", { factory, resolveWorkdir });
      const snapshots: SkillSnapshot[] = ["a", "b", "a"].map((revision) => ({
        prompt: "private skill",
        skills: [{ name: "private-guide" }],
        librarySelections: [
          {
            skillId: "private-guide",
            name: "private-guide",
            revision: revision.repeat(64),
            ownerProfileId: "profile-analyst",
          },
        ],
      }));
      syncSkillsToWorkspaceMock.mockClear();
      try {
        const runtimeIds: Array<string | undefined> = [];
        for (const skillsSnapshot of snapshots) {
          const params = {
            config,
            agentId: "analyst",
            sessionKey: "opaque-private-task",
            workspaceDir,
            skillsSnapshot,
          };
          const sandbox = await resolveSandboxContext(params);
          expect(sandbox?.backendId).toBe("mxc");
          expect(sandbox?.workspaceAccess).toBe(workspaceAccess);
          expect(sandbox?.runtimeId).toEqual(expect.any(String));
          runtimeIds.push(sandbox?.runtimeId);
          const workspace = await ensureSandboxWorkspaceForSession(params);
          expect(workspace?.containerWorkdir).toBe(sandbox?.workspaceDir);
          expect(workspace?.workspaceAccess).toBe(workspaceAccess);
        }
        expect(factory).toHaveBeenCalledTimes(3);
        expect(resolveWorkdir).toHaveBeenCalledTimes(3);
        const factoryParams = factory.mock.calls.map(([params]) => params);
        const workdirParams = resolveWorkdir.mock.calls.map(([params]) => params);
        for (const params of [...factoryParams, ...workdirParams]) {
          expect(params).toMatchObject({
            agentId: "analyst",
            sessionKey: "opaque-private-task",
            cfg: { scope: "agent", workspaceAccess },
          });
          expect(params.scopeKey).toMatch(
            /^agent:analyst:required-session:[a-f0-9]{32}:workspace:[a-f0-9]{32}$/,
          );
        }
        const scopeKeys = factoryParams.map((params) => params.scopeKey);
        expect(workdirParams.map((params) => params.scopeKey)).toEqual(scopeKeys);
        expect(scopeKeys[0]).not.toBe(scopeKeys[1]);
        expect(scopeKeys[2]).toBe(scopeKeys[0]);
        expect(runtimeIds[0]).not.toBe(runtimeIds[1]);
        expect(runtimeIds[2]).toBe(runtimeIds[0]);
        expect(factoryParams[0]?.skillsWorkspaceDir).not.toBe(factoryParams[1]?.skillsWorkspaceDir);
        expect(syncSkillsToWorkspaceMock).toHaveBeenCalledTimes(6);
        for (const [params] of syncSkillsToWorkspaceMock.mock.calls) {
          expect(params.agentId).toBe("analyst");
          expect(params.skillsSnapshot?.librarySelections).toHaveLength(1);
        }
        expect(config.agents?.defaults?.sandbox?.scope).toBe("shared");
        expect(mxcConfig.agents?.analyst?.timeoutSeconds).toBe(7);
      } finally {
        restore();
      }
    },
    15_000,
  );

  describe.each([
    { name: "context", resolve: resolveSandboxContext },
    { name: "workspace", resolve: ensureSandboxWorkspaceForSession },
  ])("selected MXC managed-project $name", ({ resolve }) => {
    it("rejects before projection reuse, preparation, or backend callbacks", async () => {
      const root = await createSandboxFixtureDir("mxc-managed-rejection");
      const sessionKey = "agent:analyst:managed-task";
      const config = sandboxConfig("mxc", { scope: "shared" });
      config.session = { store: path.join(root, "sessions.json") };
      const owner: LocalWorkspaceOwner = {
        agentId: "analyst",
        sessionKey,
        sessionId: "managed-test-session",
        lifecycleRevision: null,
        assertCurrent: vi.fn(),
        worktree: {
          id: "managed-test-worktree",
          name: "guest",
          repoFingerprint: "test",
          repoRoot: path.join(root, "repo"),
          path: path.join(root, "checkout"),
          branch: "openclaw/guest",
          baseRef: "main",
          ownerKind: "session",
          ownerId: sessionKey,
          createdAt: 0,
          lastActiveAt: 0,
        },
      };
      // Mock only owner discovery. The real prepareLocalSandboxWorkspace fence must run.
      const resolveOwner = vi
        .spyOn(localWorkspaceProjection, "resolveLocalWorkspaceOwner")
        .mockReturnValue(owner);
      const project = vi
        .spyOn(localWorkspaceProjection, "withLocalWorkspaceProjection")
        .mockImplementation(async () => {
          throw new Error("unexpected projection access");
        });
      const factory = vi.fn(
        createMxcSandboxBackendFactory(
          resolveConfig({ agents: { analyst: { network: "none", timeoutSeconds: 7 } } }),
        ),
      );
      const resolveWorkdir = vi.fn(() => owner.worktree.path);
      const restore = registerSandboxBackend("mxc", { factory, resolveWorkdir });
      syncSkillsToWorkspaceMock.mockClear();
      try {
        await expect(
          resolve({
            config,
            agentId: "analyst",
            sessionKey,
            workspaceDir: owner.worktree.path,
          }),
        ).rejects.toThrow(/Managed guest projects require a local Docker or Podman sandbox/);
        expect(resolveOwner).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "analyst",
            sessionKey,
            sandbox: expect.objectContaining({ backend: "mxc" }),
          }),
        );
        expect(project).not.toHaveBeenCalled();
        expect(factory).not.toHaveBeenCalled();
        expect(resolveWorkdir).not.toHaveBeenCalled();
        expect(syncSkillsToWorkspaceMock).not.toHaveBeenCalled();
      } finally {
        restore();
        project.mockRestore();
        resolveOwner.mockRestore();
      }
    });
  });
});
