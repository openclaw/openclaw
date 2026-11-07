import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it as baseIt, vi } from "vitest";
import { isAgentDeletionBlocked } from "../agents/agent-lifecycle-registry.js";
import {
  readPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import * as localCronService from "../cron/local-service.js";
import { loadCronStore, resolveCronJobsStorePath, saveCronStore } from "../cron/store.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import { readExecApprovalsSnapshot } from "../infra/exec-approvals.js";
import { defaultRuntime } from "../runtime.js";
import { recordAgentProvenance } from "../state/agent-provenance.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  listOpenClawRegisteredAgentDatabases,
  registerOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { readAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { readAgentProvenance } from "../test-utils/agent-provenance.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { createTestConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const configMocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn<(params: { sourceConfig: OpenClawConfig }) => Promise<void>>(),
}));
const moveToTrash = vi.hoisted(() => vi.fn(async (target: string) => `${target}.trashed`));
const gatewayMocks = vi.hoisted(() => ({ callGateway: vi.fn() }));
const workspaceStateMocks = vi.hoisted(() => ({
  deleteWorkspaceState: vi.fn(),
  prepareWorkspaceStateDeletion: vi.fn((workspaceDir: string) => ({ workspaceDir })),
}));
const terminalMocks = vi.hoisted(() => ({ isTerminalInteractive: vi.fn(() => true) }));
const wizardMocks = vi.hoisted(() => ({ createClackPrompter: vi.fn() }));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
  readConfigFileSnapshotForWrite: async () => {
    const snapshot = await configMocks.readConfigFileSnapshot();
    return {
      snapshot: { ...snapshot, sourceConfig: snapshot.sourceConfig ?? snapshot.config },
      writeOptions: {},
    };
  },
  replaceConfigFile: configMocks.replaceConfigFile,
}));
vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: gatewayMocks.callGateway,
}));
vi.mock("../infra/fs-safe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/fs-safe.js")>()),
  movePathToTrash: moveToTrash,
}));
vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
}));
vi.mock("../agents/workspace-state-store.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/workspace-state-store.js")>(
    "../agents/workspace-state-store.js",
  )),
  deleteWorkspaceState: workspaceStateMocks.deleteWorkspaceState,
  prepareWorkspaceStateDeletion: workspaceStateMocks.prepareWorkspaceStateDeletion,
}));
vi.mock("../cli/terminal-interactivity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/terminal-interactivity.js")>()),
  isTerminalInteractive: terminalMocks.isTerminalInteractive,
}));
vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: wizardMocks.createClackPrompter,
}));

import { agentsDeleteCommand } from "./agents.commands.delete.js";
import {
  createAgentsDeleteFixture,
  gatewayTransportError,
  readAgentDeleteJsonLogs,
} from "./agents.delete.test-helpers.js";

const runtime = createTestRuntime();
type DeleteState = Parameters<Parameters<typeof withStateDirEnv>[1]>[0];
type DeleteSetup = Omit<Parameters<ReturnType<typeof createAgentsDeleteFixture>>[0], "stateDir">;
const it = baseIt.extend<{
  state: DeleteState & { setup: (options?: Partial<DeleteSetup>) => Promise<void> };
}>({
  state: async ({ task: _task }, use) =>
    withStateDirEnv("agents-delete-", async (state) => {
      await use({
        ...state,
        setup: (options = {}) =>
          arrange({
            stateDir: state.stateDir,
            cfg: config(state.stateDir),
            sessions: {},
            ...options,
          }),
      });
    }),
});
const sharedAuthStore = {
  version: 1,
  profiles: {
    "test-provider:shared": { type: "api_key", provider: "test-provider", key: "test-shared-key" },
  },
};
const arrange = createAgentsDeleteFixture((cfg) => {
  configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(cfg));
});
const readJson = () => readAgentDeleteJsonLogs(runtime.log.mock.calls)[0];
const removeAgent = (options: Partial<Parameters<typeof agentsDeleteCommand>[0]> = {}) =>
  agentsDeleteCommand({ id: "ops", force: true, ...options });
const registeredAgentIds = () =>
  listOpenClawRegisteredAgentDatabases().map((entry) => entry.agentId);
const credentialsError = () =>
  Object.assign(new Error("Gateway credentials required"), {
    name: "GatewayCredentialsRequiredError",
    method: "agents.delete",
    configPath: "/test/openclaw.json",
  });
const session = (sessionId: string, updatedAt = 1) => ({ sessionId, updatedAt });
const agentConfig = (agents: NonNullable<OpenClawConfig["agents"]>): OpenClawConfig => ({ agents });
async function seedCron(...jobs: Parameters<typeof makeCronJob>[0][]) {
  const store = resolveCronJobsStorePath();
  await saveCronStore(store, { version: 1, jobs: jobs.map(makeCronJob) });
  return async () => (await loadCronStore(store)).jobs.map((job) => job.id);
}
function expectJsonFailure(message: unknown) {
  expect(readJson()).toMatchObject({ ok: false, error: { message } });
  expect(runtime.exit).toHaveBeenCalledWith(1, { resetStream: process.stderr });
}
function expectSharedWorkspace(workspace: string) {
  expect(readJson()).toMatchObject({
    workspaceRetained: true,
    workspaceRetainedReason: "shared",
    workspaceSharedWith: ["main"],
  });
  expect(moveToTrash.mock.calls.map(([target]) => target)).not.toContain(workspace);
  expect(workspaceStateMocks.deleteWorkspaceState).not.toHaveBeenCalled();
}
function config(
  stateDir: string,
  defaults: NonNullable<OpenClawConfig["agents"]>["defaults"] = {
    systemAgent: { agentId: "main" },
    sessionStore: { agentId: "main" },
  },
): OpenClawConfig {
  return agentConfig({
    ownership: "explicit",
    defaults,
    entries: {
      main: { workspace: path.join(stateDir, "workspace-main") },
      ops: { workspace: path.join(stateDir, "workspace-ops") },
    },
  });
}
function expectNoLocalMutation() {
  expect(configMocks.replaceConfigFile).not.toHaveBeenCalled();
  expect(moveToTrash).not.toHaveBeenCalled();
  expect(workspaceStateMocks.deleteWorkspaceState).not.toHaveBeenCalled();
}
function expectSessionStore(
  cfg: OpenClawConfig,
  sessions: Record<string, { sessionId: string; updatedAt: number }>,
) {
  const rows = Object.keys(cfg.agents?.entries ?? {}).flatMap((id) =>
    listSessionEntriesReadOnly({
      agentId: id,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: id }),
    }).map(({ entry, sessionKey }) => [sessionKey, entry]),
  );
  const expected = Object.entries(sessions).map(([key, entry]) => [
    key,
    { ...entry, delivery: { kind: "none" } },
  ]);
  expect(Object.fromEntries(rows)).toEqual(Object.fromEntries(expected));
}

describe("agents delete command", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "log").mockImplementation(runtime.log);
    vi.spyOn(defaultRuntime, "error").mockImplementation(runtime.error);
    vi.spyOn(defaultRuntime, "exit").mockImplementation(runtime.exit);
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) =>
      runtime.log(JSON.stringify(value, null, 2)),
    );
    vi.stubEnv("OPENCLAW_GATEWAY_URL", undefined);
    configMocks.readConfigFileSnapshot.mockReset();
    configMocks.replaceConfigFile.mockReset().mockResolvedValue(undefined);
    moveToTrash.mockReset().mockImplementation(async (target) => `${target}.trashed`);
    workspaceStateMocks.deleteWorkspaceState.mockReset();
    gatewayMocks.callGateway.mockReset().mockRejectedValue(gatewayTransportError("closed"));
    terminalMocks.isTerminalInteractive.mockReset().mockReturnValue(true);
    wizardMocks.createClackPrompter.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("requires --force without an interactive terminal", async ({ state }) => {
    await state.setup();
    terminalMocks.isTerminalInteractive.mockReturnValue(false);
    await agentsDeleteCommand({ id: "ops" });
    expect(runtime.error).toHaveBeenCalledWith("Non-interactive session. Re-run with --force.");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(wizardMocks.createClackPrompter).not.toHaveBeenCalled();
    expectNoLocalMutation();
  });

  it.for(["invalid id", "sole agent", "inherited-auth owner"] as const)(
    "rejects deletion of %s before mutation",
    async (kind, { state }) => {
      const invalid = kind === "invalid id";
      const sole = kind === "sole agent";
      const cfg = invalid
        ? config(state.stateDir)
        : agentConfig(
            sole
              ? { entries: { ops: {} } }
              : {
                  ownership: "explicit",
                  defaults: { authInheritance: { agentId: "ops" } },
                  entries: { ops: {}, research: {} },
                },
          );
      const owner = invalid ? "main" : "ops";
      const sessions = { [`agent:${owner}:main`]: session(owner) };
      if (invalid) {
        writeConfigMachineState("auth.sharedStore", { location: "state-db" });
      }
      await state.setup({ cfg, sessions, deletedAgentId: owner });
      await removeAgent({ id: invalid ? "агент✨" : "ops", json: sole });
      if (sole) {
        expectJsonFailure('Agent "ops" is the only configured agent and cannot be deleted.');
      } else {
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining(
            invalid ? 'Agent "агент✨" not found' : 'Agent "ops" owns inherited credentials',
          ),
        );
        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
      }
      expectNoLocalMutation();
      expectSessionStore(cfg, sessions);
    },
  );
  it("refuses deleting the legacy auth owner despite another default", async ({ state }) => {
    const cfg = createCanonicalAgentConfigFixture({
      agents: { entries: { main: {}, ops: { default: true } } },
    }).config;
    const sessions = { "agent:main:main": session("main") };
    await state.setup({ cfg, deletedAgentId: "main", sessions });
    writePersistedAuthProfileStoreRaw(
      sharedAuthStore,
      path.join(state.stateDir, "agents/main/agent"),
    );
    await removeAgent({ id: "main", json: true });
    expectJsonFailure(expect.stringContaining("owns the legacy shared auth store"));
    expect(readJson()).toHaveProperty("error.type", "cli_error");
    expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
    expectNoLocalMutation();
    expectSessionStore(cfg, sessions);
    expect(readPersistedAuthProfileStoreRaw()).toEqual(sharedAuthStore);
  });

  it("refuses deleting a shared session database owner before any mutation", async ({ state }) => {
    const storePath = path.join(state.stateDir, "shared.sqlite");
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { alpha: {}, ops: {} } },
      session: { store: storePath },
    };
    openOpenClawAgentDatabase({ agentId: "alpha", path: storePath });
    const sessions = {
      "agent:alpha:main": session("alpha"),
      "agent:ops:main": session("ops", 2),
    };
    await state.setup({ cfg, deletedAgentId: "alpha", sessions });
    saveExecApprovals({ version: 1, agents: { alpha: { security: "deny" } } });
    const approvals = readExecApprovalsSnapshot();
    await removeAgent({ id: "alpha", json: true });
    expect(readJson()).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('still used by agent "ops"') },
    });
    expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
    expectNoLocalMutation();
    expect(readAgentDeletionJournal("alpha")).toBeUndefined();
    expect(readExecApprovalsSnapshot()).toEqual(approvals);
    expectSessionStore(cfg, sessions);
  });

  it.for(["remote target", "established WebSocket"] as const)(
    "never replays deletion locally after a failed %s",
    async (kind, { state }) => {
      const remote = kind === "remote target";
      const cfg = config(state.stateDir);
      if (remote) {
        cfg.gateway = { mode: "remote", remote: { url: "ws://127.0.0.1:18789" } };
      }
      const sessions = { "agent:ops:main": session("ops") };
      await state.setup({ cfg, sessions });
      const error = gatewayTransportError("closed", remote ? undefined : 1006);
      gatewayMocks.callGateway.mockRejectedValue(error);
      if (remote) {
        await runCommandWithRuntime(runtime, () => removeAgent());
        expect(readAgentDeletionJournal("ops")).toBeUndefined();
        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringMatching(/restore.*connection.*Gateway host/i),
        );
        expect(gatewayMocks.callGateway).toHaveBeenCalledOnce();
      } else {
        await expect(removeAgent()).rejects.toBe(error);
      }
      expectNoLocalMutation();
      expectSessionStore(cfg, sessions);
    },
  );

  it.for(["gateway", "remote JSON", "local"] as const)(
    "reports %s cleanup failure without undoing the committed deletion",
    async (mode, { state }) => {
      const json = mode === "remote JSON";
      const local = mode === "local";
      const workspace = path.join(state.stateDir, "workspace-ops");
      const url = "ws://127.0.0.1:18789";
      const cfg = config(state.stateDir);
      if (json) {
        cfg.gateway = { mode: "remote", remote: { url } };
      }
      await state.setup({ cfg });
      if (local) {
        moveToTrash.mockRejectedValueOnce(new Error("trash unavailable"));
      } else {
        gatewayMocks.callGateway.mockResolvedValue({
          removedBindings: 0,
          removed: [],
          failed: json ? [] : [{ path: workspace, reason: "trash unavailable" }],
          purgeFailed: true,
        });
      }
      await removeAgent({ json });
      if (json) {
        expect(readJson()).toMatchObject({ purgeFailed: true, transport: "gateway" });
        expect(gatewayMocks.callGateway).toHaveBeenCalledWith(
          expect.objectContaining({
            config: expect.objectContaining({ gateway: cfg.gateway }),
            expectUrl: url,
          }),
        );
      } else {
        expect(runtime.log).toHaveBeenCalledWith("Deleted agent: ops");
        expect(runtime.error).toHaveBeenCalledWith(
          `Warning: path could not be moved to Trash: trash unavailable; remove it manually at ${workspace}`,
        );
        if (local) {
          expect(workspaceStateMocks.deleteWorkspaceState).not.toHaveBeenCalled();
          expect(readAgentDeletionJournal("ops")?.cleanupCompleted).toBe(false);
        } else {
          expect(runtime.error).toHaveBeenCalledWith(
            expect.stringContaining('session-store purge failed for deleted agent "ops"'),
          );
        }
      }
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );

  it("keeps cron/shared workspace on credential fallback and clears owner refs", async ({
    state,
  }) => {
    const workspace = path.join(state.stateDir, "workspace-shared");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { main: { workspace }, ops: { workspace } },
      },
      talk: { agentId: "ops", provider: "test-provider" },
    };
    await state.setup({ cfg });
    const cronIds = await seedCron({ id: "keep", agentId: "ops" });
    gatewayMocks.callGateway.mockRejectedValue(credentialsError());
    await removeAgent({ json: true });
    expect(readJson()).toMatchObject({
      agentId: "ops",
      workspaceRetained: true,
      workspaceRetainedReason: "shared",
      cronCleanupSkipped: true,
      clearedOwnerRefs: ["agents.defaults.systemAgent.agentId", "talk.agentId"],
    });
    expect(readJson()).not.toHaveProperty("purgeFailed");
    expect(readJson()).not.toHaveProperty("transport");
    expect(await cronIds()).toEqual(["keep"]);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining('cron cleanup was skipped for deleted agent "ops"'),
    );
    const written = configMocks.replaceConfigFile.mock.calls[0]?.[0].sourceConfig;
    expect(written?.agents?.defaults).not.toHaveProperty("heartbeat");
    expect(written?.agents?.defaults?.systemAgent).toBeUndefined();
    expect(written?.talk).toEqual({ provider: "test-provider" });
    expect(workspaceStateMocks.deleteWorkspaceState).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("deletes main offline after auth relocation, preserving survivors", async ({ state }) => {
    const sharedDatabasePath = path.join(state.tempRoot, "shared.sqlite");
    const cfg = config(state.stateDir, {
      systemAgent: { agentId: "ops" },
      authInheritance: { agentId: "ops" },
    });
    writeConfigMachineState("auth.sharedStore", { location: "state-db" });
    writePersistedAuthProfileStoreRaw(sharedAuthStore);
    const survivorSessions = { "agent:ops:main": session("ops") };
    await state.setup({
      cfg,
      deletedAgentId: "main",
      sessions: {
        ...survivorSessions,
        "agent:main:main": session("main", 2),
        "agent:main:quietchat:direct:u1": session("main-direct", 3),
      },
    });
    saveExecApprovals({
      version: 1,
      agents: {
        "*": { security: "deny" },
        main: { security: "allowlist", allowlist: [{ pattern: "/usr/bin/old" }] },
        ops: { security: "allowlist", allowlist: [{ pattern: "/usr/bin/keep" }] },
      },
    });
    const cronIds = await seedCron(
      { id: "remove", agentId: "main" },
      { id: "keep", agentId: "ops", declarationKey: "heartbeat:ops" },
      { id: "dreaming", declarationKey: "memory-core:memory-dreaming-promotion" },
    );
    const mainAgentDir = path.join(state.stateDir, "agents/main/agent");
    const external = path.join(state.tempRoot, "external.sqlite");
    const externalFiles = [external, `${external}-wal`, `${external}-shm`, `${external}-journal`];
    await Promise.all([...externalFiles, sharedDatabasePath].map((file) => fs.writeFile(file, "")));
    const mainDatabase = path.join(mainAgentDir, "openclaw-agent.sqlite");
    for (const file of [mainDatabase, external, sharedDatabasePath]) {
      registerOpenClawAgentDatabase({ agentId: "main", path: file });
    }
    registerOpenClawAgentDatabase({ agentId: "ops", path: sharedDatabasePath });
    await recordAgentProvenance("main", { createdVia: "operator" });
    await recordAgentProvenance("child", { createdVia: "agent", creatorAgentId: "main" });
    moveToTrash.mockImplementation(async (target) => {
      await fs.rename(target, `${target}.trashed`);
      return `${target}.trashed`;
    });
    await removeAgent({ id: "main", json: true });
    expect(runtime.exit).not.toHaveBeenCalled();
    const written = configMocks.replaceConfigFile.mock.calls[0]?.[0].sourceConfig;
    expect(Object.keys(written?.agents?.entries ?? {})).toEqual(["ops"]);
    expectSessionStore(cfg, survivorSessions);
    expect(readPersistedAuthProfileStoreRaw()).toEqual(sharedAuthStore);
    expect(readExecApprovalsSnapshot().file.agents).toEqual({
      "*": { security: "deny" },
      ops: {
        security: "allowlist",
        allowlist: [expect.objectContaining({ pattern: "/usr/bin/keep" })],
      },
    });
    expect(await cronIds()).toEqual(["keep", "dreaming"]);
    for (const file of [mainAgentDir, ...externalFiles]) {
      await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect((await fs.stat(sharedDatabasePath)).isFile()).toBe(true);
    expect(readJson()).toMatchObject({
      removed: expect.arrayContaining(
        externalFiles.map((file) => ({ path: file, method: "trash" })),
      ),
    });
    expect(readJson()).not.toHaveProperty("purgeFailed");
    expect(registeredAgentIds()).not.toContain("main");
    expect(listOpenClawRegisteredAgentDatabases()).toContainEqual(
      expect.objectContaining({ agentId: "ops", path: sharedDatabasePath }),
    );
    expect(readAgentProvenance("main")).toBeUndefined();
    expect(readAgentProvenance("child")).toMatchObject({ creatorAgentId: "main" });
    expect(readAgentDeletionJournal("main")?.cleanupCompleted).toBe(true);
  });

  it("finishes directory cleanup after a state error and resumes deletion", async ({ state }) => {
    await state.setup();
    const agentDir = path.join(state.stateDir, "agents/ops/agent");
    registerOpenClawAgentDatabase({
      agentId: "ops",
      path: path.join(agentDir, "openclaw-agent.sqlite"),
    });
    workspaceStateMocks.deleteWorkspaceState.mockImplementationOnce(() => {
      throw new Error("state database unavailable");
    });
    await expect(removeAgent({ json: true })).rejects.toThrow("state database unavailable");
    expect(moveToTrash).toHaveBeenCalledWith(
      path.join(await fs.realpath(path.dirname(agentDir)), "agent"),
      expect.anything(),
    );
    expect(moveToTrash.mock.invocationCallOrder[0]).toBeLessThan(
      workspaceStateMocks.deleteWorkspaceState.mock.invocationCallOrder[0] ?? 0,
    );
    expect(readAgentDeletionJournal("ops")?.cleanupCompleted).toBe(false);
    expect(registeredAgentIds()).toContain("ops");
    const next = configMocks.replaceConfigFile.mock.calls[0]?.[0].sourceConfig;
    if (!next) {
      throw new Error("expected committed deletion config");
    }
    configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(next));
    await removeAgent({ json: true });
    expect(registeredAgentIds()).not.toContain("ops");
    expect(readAgentDeletionJournal("ops")?.cleanupCompleted).toBe(true);
  });

  it.for([false, true])(
    "retains deletion authority only after the roster committed when cron cleanup fails (committed=%s)",
    async (committed, { state }) => {
      let saved = config(state.stateDir);
      await state.setup({ cfg: saved });
      configMocks.replaceConfigFile.mockImplementationOnce(async ({ sourceConfig }) => {
        saved = sourceConfig;
        configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(saved));
      });
      const failure = new Error(committed ? "cron scratch cleanup failed" : "cron removal failed");
      vi.spyOn(localCronService, "withLocalAgentCronJobsRemoved").mockImplementationOnce(
        async (_agentId, _getConfig, commitRoster) => {
          if (committed) {
            await commitRoster();
          }
          throw failure;
        },
      );
      await expect(removeAgent()).rejects.toBe(failure);
      expect(configMocks.replaceConfigFile).toHaveBeenCalledTimes(committed ? 1 : 0);
      expect(Object.hasOwn(saved.agents?.entries ?? {}, "ops")).toBe(!committed);
      expect(isAgentDeletionBlocked("ops")).toBe(committed);
      if (committed) {
        expect(readAgentDeletionJournal("ops")?.cleanupCompleted).toBe(false);
      } else {
        expect(readAgentDeletionJournal("ops")).toBeUndefined();
      }
      expect(moveToTrash).not.toHaveBeenCalled();
    },
  );

  it.for([
    ["parent", "main-child", ""],
    ["child", "", "ops-child"],
  ] as const)(
    "retains a %s workspace overlapping a survivor",
    async ([_kind, mainPath, opsPath], { state }) => {
      const shared = path.join(state.stateDir, "workspace-shared");
      const mainWorkspace = path.join(shared, mainPath);
      const opsWorkspace = path.join(shared, opsPath);
      await fs.mkdir(mainWorkspace, { recursive: true });
      await fs.mkdir(opsWorkspace, { recursive: true });
      const cfg = agentConfig({
        entries: { main: { workspace: mainWorkspace }, ops: { workspace: opsWorkspace } },
      });
      await state.setup({ cfg });
      await removeAgent({ json: true });
      expect((await fs.stat(opsWorkspace)).isDirectory()).toBe(true);
      expectSharedWorkspace(opsWorkspace);
    },
  );
});
