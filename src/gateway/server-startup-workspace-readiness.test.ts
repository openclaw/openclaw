import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveSandboxWorkspaceLayoutPaths } from "../agents/sandbox/shared.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { getRuntimeConfig, writeConfigFile, type OpenClawConfig } from "../config/config.js";
import { readConfigFileSnapshotWithPluginMetadata } from "../config/io.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "../infra/state-migrations.workspace-setup.js";
import { resetLogger } from "../logging/logger.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { gatewayKernelLogs } from "./server-kernel.js";
// Exercise the lifecycle owner; the minimal boot smoke owns lazy-entrypoint import timing.
import { startGatewayServerCore as startGatewayServer } from "./server-start.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";

type Agents = NonNullable<OpenClawConfig["agents"]>;
type ConfigSnapshot = Awaited<ReturnType<typeof readConfigFileSnapshotWithPluginMetadata>>;
const gateway = { mode: "local", bind: "loopback", auth: { mode: "none" } } as const;
const config = (entries: Agents["entries"], defaults?: Agents["defaults"]) => ({
  gateway,
  agents: { ownership: "explicit" as const, entries, defaults },
});
const legacyBytes = JSON.stringify({ version: 1, setupCompletedAt: "2026-07-15T00:00:00.000Z" });
const currentWorkspace = () => resolveAgentWorkspaceDir(getRuntimeConfig(), "main");
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
const requestRecoveryRestart = vi.fn(() => {
  throw new Error("workspace readiness must not request a recovery restart");
});
beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "ws-readiness",
    env: {
      ...KERNEL_TEST_ENV,
      VITEST: process.env.VITEST,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
});
async function close() {
  await client?.stopAndWait();
  client = undefined;
  await server?.close();
  server = undefined;
}

async function writeLegacyWorkspace(dir: string, bytes = legacyBytes) {
  await fs.mkdir(dir, { recursive: true });
  const sourcePath = path.join(dir, "openclaw-workspace-state.json");
  await fs.writeFile(sourcePath, bytes);
  return sourcePath;
}

async function migrate(cfg: OpenClawConfig, homedir?: () => string) {
  const stateDir = state.stateDir;
  const detected = await detectLegacyWorkspaceState({
    cfg,
    stateDir,
    homedir,
    doctorOnlyStateMigrations: true,
  });
  expect((await migrateLegacyWorkspaceState({ stateDir, detected })).warnings).toEqual([]);
}

afterEach(async () => {
  await close();
  await state.cleanup();
  resetLogger();
  clearPluginMetadataLifecycleCaches();
  vi.restoreAllMocks();
  expect(requestRecoveryRestart).not.toHaveBeenCalled();
});

const start = async (port: number, startupConfigSnapshotRead?: ConfigSnapshot) => {
  server = await startGatewayServer(port, {
    auth: { mode: "none" },
    bind: "loopback",
    controlUiEnabled: false,
    hotReloadRecovery: requestRecoveryRestart,
    startupConfigSnapshotRead,
  });
  return server;
};

it("refuses every owned session workspace without reading its store on the main thread", async () => {
  const storePath = state.statePath("shared.sqlite");
  const sandbox = {
    mode: "all",
    scope: "session",
    workspaceAccess: "ro",
    workspaceRoot: state.path("sandboxes-main"),
  } as const;
  const agents = {
    main: { workspace: state.workspaceDir, sandbox },
    secondary: {
      workspace: state.path("workspace-secondary"),
      sandbox: { ...sandbox, workspaceRoot: state.path("sandboxes-secondary") },
    },
  };
  await state.writeConfig({
    ...config(agents),
    session: { store: storePath },
  } satisfies OpenClawConfig);
  const addLegacyWorkspace = async (agentId: keyof typeof agents, sessionKey: string) => {
    const agent = agents[agentId];
    const { sandboxWorkspaceDir } = resolveSandboxWorkspaceLayoutPaths({
      cfg: agent.sandbox,
      agentId,
      rawSessionKey: sessionKey,
      workspaceDir: agent.workspace,
    });
    await writeLegacyWorkspace(sandboxWorkspaceDir, JSON.stringify({ version: 1 }));
    return sandboxWorkspaceDir;
  };
  const workspaces: string[] = [];
  for (const agentId of ["main", "secondary"] as const) {
    for (const suffix of ["first", "second"]) {
      const sessionKey = `agent:${agentId}:${suffix}`;
      replaceSessionEntrySync(
        { agentId, sessionKey, storePath, env: state.env },
        { sessionId: sessionKey, updatedAt: 1 },
      );
      workspaces.push(await addLegacyWorkspace(agentId, sessionKey));
    }
  }
  replaceSessionEntrySync(
    { agentId: "outsider", sessionKey: "agent:outsider:first", storePath, env: state.env },
    { sessionId: "outsider-session", updatedAt: 1 },
  );
  const unrelatedWorkspaces = await Promise.all([
    addLegacyWorkspace("main", "agent:main:absent"),
    addLegacyWorkspace("main", "agent:outsider:first"),
    addLegacyWorkspace("main", "agent:secondary:first"),
    addLegacyWorkspace("secondary", "agent:main:first"),
  ]);
  closeOpenClawAgentDatabasesForTest();
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");

  const port = await getFreePort();
  const attempt = start(port);
  await expect(attempt).rejects.toThrow("Legacy workspace setup state requires migration");
  for (const workspace of workspaces) {
    await expect(attempt).rejects.toThrow(workspace);
  }
  for (const workspace of unrelatedWorkspaces) {
    await expect(attempt).rejects.not.toThrow(workspace);
  }
  await expect(fetch(`http://127.0.0.1:${port}/readyz`)).rejects.toThrow();

  expect(prepare.mock.calls.filter(([sql]) => sql.includes('"retained_window"'))).toEqual([]);
});

it.each(["disk", "supplied snapshot"])(
  "refuses a secondary workspace from %s until Doctor migrates it",
  async (source) => {
    const workspaceDir = state.statePath("workspace-secondary");
    const cfg = config({
      main: { workspace: state.statePath("workspace-main") },
      secondary: { workspace: workspaceDir },
    });
    await writeConfigFile(cfg);
    const sourcePath = await writeLegacyWorkspace(workspaceDir);
    const initialSnapshotRead =
      source === "supplied snapshot"
        ? await readConfigFileSnapshotWithPluginMetadata({ observe: false })
        : undefined;
    if (initialSnapshotRead) {
      await writeConfigFile(
        config({
          ...cfg.agents.entries,
          secondary: { workspace: state.statePath("workspace-clean") },
        }),
      );
    }
    const port = await getFreePort();
    const attempt = start(port, initialSnapshotRead);
    await expect(attempt).rejects.toThrow("Legacy workspace setup state requires migration");
    await expect(fetch(`http://127.0.0.1:${port}/readyz`)).rejects.toThrow();
    await expect(fs.stat(sourcePath)).resolves.toBeDefined();

    await migrate(cfg, os.homedir);
    server = await start(port, initialSnapshotRead);
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(ready.status).toBe(200);
    await expect(fs.stat(sourcePath)).rejects.toHaveProperty("code", "ENOENT");
  },
);

it.for(["managed write", "file watcher"])(
  "rejects an unmigrated workspace switch before publication via %s",
  async (ingress, { signal }) => {
    // The live candidate boundary needs the real managed reloader, not the minimal stub.
    state.envVars.OPENCLAW_TEST_MINIMAL_GATEWAY = undefined;
    state.applyEnv();
    const oldWorkspace = state.workspaceDir;
    // A long path must not crowd repair guidance out of the RPC error preview.
    const nextWorkspace = state.path("retained", "workspace-".repeat(10));
    const reloadError = vi.spyOn(gatewayKernelLogs.logReload, "error");
    const cfg: OpenClawConfig = {
      ...config({ main: { workspace: oldWorkspace } }, { workspace: nextWorkspace }),
      logging: { level: "silent", consoleLevel: "silent" },
    };
    await state.writeConfig(cfg);
    const sourcePath = await writeLegacyWorkspace(nextWorkspace);
    const personaPath = path.join(nextWorkspace, "SOUL.md");
    const persona = "Retained workspace persona.\n";
    await fs.writeFile(personaPath, persona);
    const port = await getFreePort();
    const startReady = async () => {
      // Startup settles before recovery; observe the owner's readiness event.
      const ready = createDeferred();
      const info = gatewayKernelLogs.log.info.bind(gatewayKernelLogs.log);
      using readyLog = vi.spyOn(gatewayKernelLogs.log, "info");
      readyLog.mockImplementation((message, meta) => {
        info(message, meta);
        if (message === "gateway ready") {
          ready.resolve();
        }
      });
      const started = await start(port);
      await withinTest(started.startupSettled, signal);
      await withinTest(ready.promise, signal);
      return started;
    };
    server = await startReady();
    client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      scopes: ["operator.admin"],
    });
    const nextConfig: OpenClawConfig = {
      ...cfg,
      agents: { ...cfg.agents, entries: { main: { workspace: nextWorkspace } } },
    };
    const originalBytes = await fs.readFile(state.configPath, "utf8");

    if (ingress === "managed write") {
      const snapshot = await client.request<{ hash: string }>("config.get", {});
      await expect(
        client.request("config.set", {
          raw: JSON.stringify(nextConfig),
          baseHash: snapshot.hash,
        }),
      ).rejects.toThrow("openclaw doctor --fix");
      await expect(writeConfigFile(nextConfig)).rejects.toThrow("openclaw doctor --fix");
      expect(await fs.readFile(state.configPath, "utf8")).toBe(originalBytes);
    } else {
      await state.writeConfig(nextConfig);
      await expect
        .poll(() => reloadError.mock.calls.length > 0 || currentWorkspace() === nextWorkspace, {
          timeout: 5_000,
        })
        .toBe(true);
      expect(reloadError).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
      expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(nextConfig);
    }
    expect(currentWorkspace()).toBe(oldWorkspace);
    await expect(ensureAgentWorkspace({ dir: currentWorkspace() })).resolves.toMatchObject({
      dir: oldWorkspace,
    });
    await expect(client.request("health", {})).resolves.toEqual(expect.any(Object));
    expect(await fs.readFile(sourcePath, "utf8")).toBe(legacyBytes);

    await close();
    await migrate(nextConfig);
    await expect(fs.stat(sourcePath)).rejects.toHaveProperty("code", "ENOENT");
    // Restart with last-good config, then retry the same live change after Doctor.
    await state.writeConfig(cfg);
    server = await startReady();
    reloadError.mockClear();
    const application = createRuntimeConfigWriteApplication();
    await writeConfigFile(nextConfig, attachRuntimeConfigWriteApplication({}, application));
    expect(application.claimed).toBe(true);
    expect(await application.result, JSON.stringify(reloadError.mock.calls)).toBe("applied");
    expect(currentWorkspace()).toBe(nextWorkspace);
    await expect(ensureAgentWorkspace({ dir: nextWorkspace })).resolves.toMatchObject({
      dir: nextWorkspace,
    });
    expect(await fs.readFile(personaPath, "utf8")).toBe(persona);
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
  },
);
