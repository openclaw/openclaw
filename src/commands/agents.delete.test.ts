import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { parseAgentSessionKey } from "../routing/session-key.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { readAgentProvenance, recordAgentProvenance } from "../state/agent-provenance.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  listOpenClawRegisteredAgentDatabases,
  registerOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
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
const credentialsError = () =>
  Object.assign(new Error("Gateway credentials required"), {
    name: "GatewayCredentialsRequiredError",
    method: "agents.delete",
    configPath: "/test/openclaw.json",
  });
function config(stateDir: string): OpenClawConfig {
  const entries = {
    main: { workspace: path.join(stateDir, "workspace-main") },
    ops: { workspace: path.join(stateDir, "workspace-ops") },
  };
  return {
    agents: {
      ownership: "explicit",
      defaults: {
        systemAgent: { agentId: "main" },
        sessionStore: { agentId: "main" },
      },
      entries,
    },
  };
}
function expectNoLocalMutation() {
  expect(configMocks.replaceConfigFile).not.toHaveBeenCalled();
  expect(moveToTrash).not.toHaveBeenCalled();
  expect(workspaceStateMocks.deleteWorkspaceState).not.toHaveBeenCalled();
}
function expectSessionStore(
  cfg: OpenClawConfig,
  sessions: Record<string, { sessionId: string; updatedAt: number }>,
  agentId = "ops",
) {
  const agentIds = new Set([
    agentId,
    ...Object.keys(sessions).flatMap((key) => {
      const id = parseAgentSessionKey(key)?.agentId;
      return id ? [id] : [];
    }),
  ]);
  const rows = [...agentIds].flatMap((id) =>
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
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("requires --force without an interactive terminal", async () => {
    await withStateDirEnv("agents-delete-", async ({ stateDir }) => {
      await arrange({ stateDir, cfg: config(stateDir), sessions: {} });
      terminalMocks.isTerminalInteractive.mockReturnValue(false);
      await agentsDeleteCommand({ id: "ops" }, runtime);
      expect(runtime.error).toHaveBeenCalledWith("Non-interactive session. Re-run with --force.");
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(wizardMocks.createClackPrompter).not.toHaveBeenCalled();
      expectNoLocalMutation();
    });
  });

  it("rejects an unrepresentable id before targeting the default agent", async () => {
    await withStateDirEnv("agents-delete-", async ({ stateDir }) => {
      const cfg = config(stateDir);
      const sessions = { "agent:main:main": { sessionId: "main", updatedAt: 1 } };
      writeConfigMachineState("auth.sharedStore", { location: "state-db" });
      await arrange({ stateDir, cfg, sessions, deletedAgentId: "main" });
      await agentsDeleteCommand({ id: "агент✨", force: true }, runtime);
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining('Agent "агент✨" not found'),
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
      expectNoLocalMutation();
      expectSessionStore(cfg, sessions, "main");
    });
  });

  it("refuses deleting the legacy shared-auth owner even when another agent is default", async () => {
    await withStateDirEnv("agents-delete-", async ({ stateDir }) => {
      const cfg = createCanonicalAgentConfigFixture({
        agents: { entries: { main: {}, ops: { default: true } } },
      }).config;
      const sessions = { "agent:main:main": { sessionId: "main", updatedAt: 1 } };
      await arrange({ stateDir, cfg, deletedAgentId: "main", sessions });
      writePersistedAuthProfileStoreRaw(sharedAuthStore, path.join(stateDir, "agents/main/agent"));
      await agentsDeleteCommand({ id: "main", force: true, json: true }, runtime);
      expect(readJson()).toMatchObject({
        ok: false,
        error: {
          type: "cli_error",
          message: expect.stringContaining("owns the legacy shared auth store"),
        },
      });
      expect(runtime.exit).toHaveBeenCalledWith(1, { resetStream: process.stderr });
      expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
      expectNoLocalMutation();
      expectSessionStore(cfg, sessions, "main");
      expect(readPersistedAuthProfileStoreRaw()).toEqual(sharedAuthStore);
    });
  });

  it("refuses deleting the sole configured agent", async () => {
    await withStateDirEnv("agents-delete-", async ({ stateDir }) => {
      const cfg: OpenClawConfig = { agents: { entries: { ops: {} } } };
      const sessions = { "agent:ops:main": { sessionId: "ops", updatedAt: 1 } };
      await arrange({ stateDir, cfg, sessions });
      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);
      expect(readJson()).toMatchObject({
        ok: false,
        error: { message: 'Agent "ops" is the only configured agent and cannot be deleted.' },
      });
      expect(runtime.exit).toHaveBeenCalledWith(1, { resetStream: process.stderr });
      expectNoLocalMutation();
      expectSessionStore(cfg, sessions);
    });
  });

  it("refuses deleting the inherited-auth owner", async () => {
    await withStateDirEnv("agents-delete-", async () => {
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { authInheritance: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
      };
      configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(cfg));
      await agentsDeleteCommand({ id: "ops", force: true }, runtime);
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining('Agent "ops" owns inherited credentials'),
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
      expectNoLocalMutation();
    });
  });

  it("refuses deleting a shared session database owner before any mutation", async () => {
    await withStateDirEnv("agents-delete-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "shared.sqlite");
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { alpha: {}, ops: {} } },
        session: { store: storePath },
      };
      openOpenClawAgentDatabase({ agentId: "alpha", path: storePath });
      const sessions = {
        "agent:alpha:main": { sessionId: "alpha", updatedAt: 1 },
        "agent:ops:main": { sessionId: "ops", updatedAt: 2 },
      };
      await arrange({ stateDir, cfg, deletedAgentId: "alpha", sessions });
      saveExecApprovals({ version: 1, agents: { alpha: { security: "deny" } } });
      const approvals = readExecApprovalsSnapshot();
      await agentsDeleteCommand({ id: "alpha", force: true, json: true }, runtime);
      expect(readJson()).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('still used by agent "ops"') },
      });
      expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
      expectNoLocalMutation();
      expect(readAgentDeletionJournal("alpha")).toBeUndefined();
      expect(readExecApprovalsSnapshot()).toEqual(approvals);
      expectSessionStore(cfg, sessions, "alpha");
    });
  });

  it.each(["remote config", "environment override"])(
    "never falls back locally for a failed %s target",
    async (source) => {
      await withStateDirEnv("agents-delete-", async ({ stateDir }) => {
        const url = "ws://127.0.0.1:18789";
        const cfg = config(stateDir);
        if (source === "remote config") {
          cfg.gateway = { mode: "remote", remote: { url } };
        } else {
          vi.stubEnv("OPENCLAW_GATEWAY_URL", url);
        }
        const sessions = { "agent:ops:main": { sessionId: "ops", updatedAt: 1 } };
        await arrange({ stateDir, cfg, sessions });
        gatewayMocks.callGateway.mockRejectedValue(
          source === "remote config" ? gatewayTransportError("closed") : credentialsError(),
        );
        await runCommandWithRuntime(runtime, () =>
          agentsDeleteCommand({ id: "ops", force: true }, runtime),
        );
        expectNoLocalMutation();
        expect(readAgentDeletionJournal("ops")).toBeUndefined();
        expectSessionStore(cfg, sessions);
        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringMatching(/restore.*connection.*Gateway host/i),
        );
        expect(gatewayMocks.callGateway).toHaveBeenCalledOnce();
      });
    },
  );

  it("does not replay deletion locally after an established WebSocket closes", async () => {
    await withStateDirEnv("agents-delete-", async ({ stateDir }) => {
      const cfg = config(stateDir);
      const sessions = { "agent:ops:main": { sessionId: "ops", updatedAt: 1 } };
      await arrange({ stateDir, cfg, sessions });
      const error = gatewayTransportError("closed", 1006);
      gatewayMocks.callGateway.mockRejectedValue(error);
      await expect(agentsDeleteCommand({ id: "ops", force: true }, runtime)).rejects.toBe(error);
      expectNoLocalMutation();
      expectSessionStore(cfg, sessions);
    });
  });

  it("warns about Gateway cleanup failures without failing committed deletion", async () => {
    await withStateDirEnv("agents-delete-", async ({ stateDir }) => {
      const workspace = path.join(stateDir, "workspace-ops");
      await arrange({ stateDir, cfg: config(stateDir), sessions: {} });
      gatewayMocks.callGateway.mockResolvedValue({
        ok: true,
        agentId: "ops",
        removedBindings: 0,
        removed: [],
        failed: [{ path: workspace, reason: "trash unavailable" }],
        purgeFailed: true,
      });
      await agentsDeleteCommand({ id: "ops", force: true }, runtime);
      expect(runtime.log).toHaveBeenCalledWith("Deleted agent: ops");
      expect(runtime.error).toHaveBeenCalledWith(
        `Warning: path could not be moved to Trash: trash unavailable; remove it manually at ${workspace}`,
      );
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining('session-store purge failed for deleted agent "ops"'),
      );
      expect(runtime.exit).not.toHaveBeenCalled();
    });
  });

  it("reports remote Gateway purge failure as JSON", async () => {
    await withStateDirEnv("agents-delete-", async ({ stateDir }) => {
      const url = "ws://127.0.0.1:18789";
      const cfg = {
        ...config(stateDir),
        gateway: { mode: "remote", remote: { url } },
      } satisfies OpenClawConfig;
      await arrange({ stateDir, cfg, sessions: {} });
      gatewayMocks.callGateway.mockResolvedValue({
        ok: true,
        agentId: "ops",
        removedBindings: 0,
        removed: [],
        failed: [],
        purgeFailed: true,
      });
      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);
      expect(readJson()).toMatchObject({ purgeFailed: true, transport: "gateway" });
      expect(gatewayMocks.callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ gateway: cfg.gateway }),
          expectUrl: url,
        }),
      );
    });
  });

  it("keeps cron and shared workspace on credential fallback while clearing owner references", async () => {
    await withStateDirEnv("agents-delete-", async ({ stateDir }) => {
      const workspace = path.join(stateDir, "workspace-shared");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { heartbeat: { agentId: "ops" }, systemAgent: { agentId: "ops" } },
          entries: { main: { workspace }, ops: { workspace } },
        },
        talk: { agentId: "ops", provider: "test-provider" },
      };
      await arrange({ stateDir, cfg, sessions: {} });
      const storePath = resolveCronJobsStorePath();
      await saveCronStore(storePath, {
        version: 1,
        jobs: [makeCronJob({ id: "keep", agentId: "ops" })],
      });
      gatewayMocks.callGateway.mockRejectedValue(credentialsError());
      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);
      expect(readJson()).toMatchObject({
        agentId: "ops",
        workspaceRetained: true,
        workspaceRetainedReason: "shared",
        cronCleanupSkipped: true,
        clearedOwnerRefs: [
          "agents.defaults.heartbeat.agentId",
          "agents.defaults.systemAgent.agentId",
          "talk.agentId",
        ],
      });
      expect(readJson()).not.toHaveProperty("purgeFailed");
      expect(readJson()).not.toHaveProperty("transport");
      expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual(["keep"]);
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining('cron cleanup was skipped for deleted agent "ops"'),
      );
      const written = configMocks.replaceConfigFile.mock.calls[0]?.[0].sourceConfig;
      expect(written?.agents?.defaults?.heartbeat).toBeUndefined();
      expect(written?.agents?.defaults?.systemAgent).toBeUndefined();
      expect(written?.talk).toEqual({ provider: "test-provider" });
      expect(workspaceStateMocks.deleteWorkspaceState).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    });
  });

  it("preserves canonical main-agent sessions when deleting another shared-store agent", async () => {
    await withStateDirEnv("agents-delete-", async ({ stateDir }) => {
      const cfg = { ...config(stateDir), session: { store: path.join(stateDir, "shared.sqlite") } };
      const survivors = {
        "agent:main:main": { sessionId: "main", updatedAt: 1 },
        "agent:main:quietchat:direct:u1": { sessionId: "main-direct", updatedAt: 2 },
      };
      await arrange({
        stateDir,
        cfg,
        sessions: {
          ...survivors,
          "agent:ops:main": { sessionId: "ops", updatedAt: 3 },
          "agent:ops:quietchat:direct:u2": { sessionId: "ops-direct", updatedAt: 4 },
        },
      });
      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);
      expect(runtime.exit).not.toHaveBeenCalled();
      expectSessionStore(cfg, survivors);
    });
  });

  it("deletes main's owned state offline after auth relocation while preserving every survivor", async () => {
    await withStateDirEnv("agents-delete-", async ({ stateDir, tempRoot }) => {
      const opsAgentDir = path.join(tempRoot, "ops-agent");
      const sharedDatabasePath = path.join(tempRoot, "shared.sqlite");
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: {
            systemAgent: { agentId: "ops" },
            authInheritance: { agentId: "ops" },
          },
          entries: {
            main: { workspace: path.join(stateDir, "workspace-main") },
            ops: {
              agentDir: opsAgentDir,
              workspace: path.join(stateDir, "workspace-ops"),
            },
          },
        },
      };
      writeConfigMachineState("auth.sharedStore", { location: "state-db" });
      writePersistedAuthProfileStoreRaw(sharedAuthStore);
      const survivorSessions = { "agent:ops:main": { sessionId: "ops", updatedAt: 1 } };
      await arrange({
        stateDir,
        cfg,
        deletedAgentId: "main",
        sessions: {
          ...survivorSessions,
          "agent:main:main": { sessionId: "main", updatedAt: 2 },
          "agent:main:quietchat:direct:u1": { sessionId: "main-direct", updatedAt: 3 },
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
      const cronPath = resolveCronJobsStorePath();
      await saveCronStore(cronPath, {
        version: 1,
        jobs: [
          makeCronJob({ id: "remove", agentId: "main" }),
          makeCronJob({ id: "keep", agentId: "ops" }),
          makeCronJob({
            id: "heartbeat",
            agentId: "ops",
            declarationKey: "heartbeat:ops",
            payload: { kind: "heartbeat" },
          }),
          makeCronJob({ id: "dreaming", declarationKey: "memory-core:memory-dreaming-promotion" }),
        ],
      });
      const mainAgentDir = path.join(stateDir, "agents/main/agent");
      const retainedDir = path.join(stateDir, "agents/main/sessions");
      const foreign = openOpenClawAgentDatabase({
        agentId: "ops",
        path: path.join(retainedDir, "kept.sqlite"),
      });
      closeOpenClawAgentDatabaseByPath(foreign.path);
      await fs.mkdir(opsAgentDir, { recursive: true });
      const survivorOwned = path.join(opsAgentDir, "main.sqlite");
      const external = path.join(tempRoot, "external.sqlite");
      const externalFiles = [external, `${external}-wal`, `${external}-shm`, `${external}-journal`];
      await Promise.all(
        [...externalFiles, survivorOwned, sharedDatabasePath].map((file) => fs.writeFile(file, "")),
      );
      for (const file of [
        path.join(mainAgentDir, "openclaw-agent.sqlite"),
        external,
        sharedDatabasePath,
        survivorOwned,
      ]) {
        registerOpenClawAgentDatabase({ agentId: "main", path: file });
      }
      registerOpenClawAgentDatabase({ agentId: "ops", path: sharedDatabasePath });
      recordAgentProvenance("main", { createdVia: "operator" });
      recordAgentProvenance("child", { createdVia: "agent", creatorAgentId: "main" });
      moveToTrash.mockImplementation(async (target) => {
        await fs.rename(target, `${target}.trashed`);
        return `${target}.trashed`;
      });
      await agentsDeleteCommand({ id: "main", force: true, json: true }, runtime);
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(configMocks.replaceConfigFile).toHaveBeenCalledOnce();
      expect(
        Object.keys(
          configMocks.replaceConfigFile.mock.calls[0]?.[0].sourceConfig.agents?.entries ?? {},
        ),
      ).toEqual(["ops"]);
      expectSessionStore(cfg, survivorSessions, "main");
      expect(readPersistedAuthProfileStoreRaw()).toEqual(sharedAuthStore);
      expect(readExecApprovalsSnapshot().file.agents).toEqual({
        "*": { security: "deny" },
        ops: {
          security: "allowlist",
          allowlist: [expect.objectContaining({ pattern: "/usr/bin/keep" })],
        },
      });
      expect((await loadCronStore(cronPath)).jobs.map((job) => job.id)).toEqual([
        "keep",
        "heartbeat",
        "dreaming",
      ]);
      for (const file of [mainAgentDir, ...externalFiles]) {
        await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
      }
      for (const file of [sharedDatabasePath, survivorOwned, foreign.path]) {
        expect((await fs.stat(file)).isFile()).toBe(true);
      }
      expect(moveToTrash).not.toHaveBeenCalledWith(retainedDir, expect.anything());
      expect(readJson()).toMatchObject({
        removed: expect.arrayContaining(
          externalFiles.map((file) => ({ path: file, method: "trash" })),
        ),
      });
      expect(readJson()).not.toHaveProperty("purgeFailed");
      expect(listOpenClawRegisteredAgentDatabases().map((entry) => entry.agentId)).not.toContain(
        "main",
      );
      expect(listOpenClawRegisteredAgentDatabases()).toContainEqual(
        expect.objectContaining({ agentId: "ops", path: sharedDatabasePath }),
      );
      expect(readAgentProvenance("main")).toBeUndefined();
      expect(readAgentProvenance("child")).toMatchObject({ creatorAgentId: "main" });
      expect(readAgentDeletionJournal("main")?.cleanupCompleted).toBe(true);
    });
  });

  it("finishes directory cleanup after a state error and resumes the interrupted deletion", async () => {
    await withStateDirEnv("agents-delete-", async ({ stateDir }) => {
      await arrange({ stateDir, cfg: config(stateDir), sessions: {} });
      const agentDir = path.join(stateDir, "agents/ops/agent");
      registerOpenClawAgentDatabase({
        agentId: "ops",
        path: path.join(agentDir, "openclaw-agent.sqlite"),
      });
      workspaceStateMocks.deleteWorkspaceState.mockImplementationOnce(() => {
        throw new Error("state database unavailable");
      });
      await expect(
        agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime),
      ).rejects.toThrow("state database unavailable");
      expect(moveToTrash).toHaveBeenCalledWith(
        path.join(await fs.realpath(path.dirname(agentDir)), "agent"),
        expect.anything(),
      );
      expect(moveToTrash.mock.invocationCallOrder[0]).toBeLessThan(
        workspaceStateMocks.deleteWorkspaceState.mock.invocationCallOrder[0] ?? 0,
      );
      expect(readAgentDeletionJournal("ops")?.cleanupCompleted).toBe(false);
      expect(listOpenClawRegisteredAgentDatabases().map((entry) => entry.agentId)).toContain("ops");
      const next = configMocks.replaceConfigFile.mock.calls[0]?.[0].sourceConfig;
      if (!next) {
        throw new Error("expected committed deletion config");
      }
      configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(next));
      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);
      expect(listOpenClawRegisteredAgentDatabases().map((entry) => entry.agentId)).not.toContain(
        "ops",
      );
      expect(readAgentDeletionJournal("ops")?.cleanupCompleted).toBe(true);
    });
  });

  it.each([false, true])(
    "retains deletion authority only after the roster committed when cron cleanup fails (committed=%s)",
    async (committed) => {
      await withStateDirEnv("agents-delete-cron-cleanup-", async ({ stateDir }) => {
        let saved = config(stateDir);
        await arrange({ stateDir, cfg: saved, sessions: {} });
        configMocks.replaceConfigFile.mockImplementationOnce(async ({ sourceConfig }) => {
          saved = sourceConfig;
          configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(saved));
        });
        const failure = new Error(
          committed ? "cron scratch cleanup failed" : "cron removal failed",
        );
        const removeCron = vi
          .spyOn(localCronService, "withLocalAgentCronJobsRemoved")
          .mockImplementationOnce(async (_agentId, _getConfig, commitRoster) => {
            if (committed) {
              await commitRoster();
            }
            throw failure;
          });
        try {
          await expect(agentsDeleteCommand({ id: "ops", force: true }, runtime)).rejects.toBe(
            failure,
          );
          expect(configMocks.replaceConfigFile).toHaveBeenCalledTimes(committed ? 1 : 0);
          expect(Object.hasOwn(saved.agents?.entries ?? {}, "ops")).toBe(!committed);
          expect(isAgentDeletionBlocked("ops")).toBe(committed);
          if (committed) {
            expect(readAgentDeletionJournal("ops")?.cleanupCompleted).toBe(false);
          } else {
            expect(readAgentDeletionJournal("ops")).toBeUndefined();
          }
          expect(moveToTrash).not.toHaveBeenCalled();
        } finally {
          removeCron.mockRestore();
        }
      });
    },
  );

  it("reports local Trash failures and retains workspace state for retry", async () => {
    await withStateDirEnv("agents-delete-", async ({ stateDir }) => {
      const workspace = path.join(stateDir, "workspace-ops");
      await arrange({ stateDir, cfg: config(stateDir), sessions: {} });
      moveToTrash.mockRejectedValueOnce(new Error("trash unavailable"));
      await agentsDeleteCommand({ id: "ops", force: true }, runtime);
      expect(runtime.log).toHaveBeenCalledWith("Deleted agent: ops");
      expect(runtime.error).toHaveBeenCalledWith(
        `Warning: path could not be moved to Trash: trash unavailable; remove it manually at ${workspace}`,
      );
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(workspaceStateMocks.deleteWorkspaceState).not.toHaveBeenCalled();
      expect(readAgentDeletionJournal("ops")?.cleanupCompleted).toBe(false);
    });
  });

  it.each([
    ["parent", "main-child", ""],
    ["child", "", "ops-child"],
  ])("retains a %s workspace overlapping a survivor", async (_kind, mainPath, opsPath) => {
    await withStateDirEnv("agents-delete-", async ({ stateDir }) => {
      const shared = path.join(stateDir, "workspace-shared");
      const mainWorkspace = path.join(shared, mainPath);
      const opsWorkspace = path.join(shared, opsPath);
      await fs.mkdir(mainWorkspace, { recursive: true });
      await fs.mkdir(opsWorkspace, { recursive: true });
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: { workspace: mainWorkspace }, ops: { workspace: opsWorkspace } },
        },
      };
      await arrange({ stateDir, cfg, sessions: {} });
      await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);
      expect((await fs.stat(opsWorkspace)).isDirectory()).toBe(true);
      expect(readJson()).toMatchObject({
        workspaceRetained: true,
        workspaceRetainedReason: "shared",
        workspaceSharedWith: ["main"],
      });
      expect(moveToTrash.mock.calls.map(([target]) => target)).not.toContain(opsWorkspace);
      expect(workspaceStateMocks.deleteWorkspaceState).not.toHaveBeenCalled();
    });
  });

  it.runIf(process.platform !== "win32")(
    "retains a workspace shared through a symlink",
    async () => {
      await withStateDirEnv("agents-delete-", async ({ stateDir }) => {
        const workspace = path.join(stateDir, "workspace-real");
        const alias = path.join(stateDir, "workspace-alias");
        await fs.mkdir(workspace);
        await fs.symlink(workspace, alias, "dir");
        await arrange({
          stateDir,
          cfg: { agents: { entries: { main: { workspace }, ops: { workspace: alias } } } },
          sessions: {},
        });
        await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);
        expect(readJson()).toMatchObject({
          workspaceRetained: true,
          workspaceSharedWith: ["main"],
        });
        expect(moveToTrash.mock.calls.map(([target]) => target)).not.toContain(alias);
      });
    },
  );
});
