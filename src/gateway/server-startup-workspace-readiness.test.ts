import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveSandboxWorkspaceLayoutPaths } from "../agents/sandbox/shared.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { getRuntimeConfig, writeConfigFile, type OpenClawConfig } from "../config/config.js";
import { readConfigFileSnapshotWithPluginMetadata } from "../config/io.js";
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
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

describe("Gateway workspace migration readiness", () => {
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
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
  });
  afterEach(async () => {
    if (client) {
      await disconnectGatewayClient(client);
      client = undefined;
    }
    await server?.close();
    server = undefined;
    await state.cleanup();
    resetLogger();
    clearPluginMetadataLifecycleCaches();
    vi.restoreAllMocks();
    expect(requestRecoveryRestart).not.toHaveBeenCalled();
  });

  const start = (
    port: number,
    startupConfigSnapshotRead?: Awaited<
      ReturnType<typeof readConfigFileSnapshotWithPluginMetadata>
    >,
  ) =>
    startGatewayServer(port, {
      auth: { mode: "none" },
      bind: "loopback",
      controlUiEnabled: false,
      hotReloadRecovery: requestRecoveryRestart,
      startupConfigSnapshotRead,
    });

  it("scans a cold shared store once before refusing every owned session workspace", async () => {
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
      gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
      session: { store: storePath },
      agents: { ownership: "explicit", entries: agents },
    } satisfies OpenClawConfig);
    const addLegacyWorkspace = async (agentId: keyof typeof agents, sessionKey: string) => {
      const agent = agents[agentId];
      const { sandboxWorkspaceDir } = resolveSandboxWorkspaceLayoutPaths({
        cfg: agent.sandbox,
        agentId,
        rawSessionKey: sessionKey,
        workspaceDir: agent.workspace,
      });
      await fs.mkdir(sandboxWorkspaceDir, { recursive: true });
      await fs.writeFile(
        path.join(sandboxWorkspaceDir, "openclaw-workspace-state.json"),
        JSON.stringify({ version: 1 }),
      );
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
    const iterate = vi.spyOn(StatementSync.prototype, "iterate");

    const port = await getFreePort();
    const attempt = start(port).then((started) => {
      server = started;
      return started;
    });
    await expect(attempt).rejects.toThrow("Legacy workspace setup state requires migration");
    for (const workspace of workspaces) {
      await expect(attempt).rejects.toThrow(workspace);
    }
    for (const workspace of unrelatedWorkspaces) {
      await expect(attempt).rejects.not.toThrow(workspace);
    }
    await expect(fetch(`http://127.0.0.1:${port}/readyz`)).rejects.toThrow();

    // The refusal ends the first workspace admission before later startup passes.
    const canonicalScans = prepare.mock.calls.reduce((count, [sql], index) => {
      if (!sql.includes('"retained_window"')) {
        return count;
      }
      const result = prepare.mock.results[index];
      return (
        count +
        iterate.mock.contexts.filter(
          (statement) => result?.type === "return" && statement === result.value,
        ).length
      );
    }, 0);
    expect(canonicalScans).toBe(1);
  });

  it.each(["disk", "supplied snapshot"])(
    "refuses a secondary workspace from %s until Doctor migrates it",
    async (source) => {
      const stateDir = state.stateDir;
      const workspaceDir = path.join(stateDir, "workspace-secondary");
      const cfg: OpenClawConfig = {
        gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
        agents: {
          ownership: "explicit",
          entries: {
            main: { workspace: path.join(stateDir, "workspace-main") },
            secondary: { workspace: workspaceDir },
          },
        },
      };
      await writeConfigFile(cfg);
      await fs.mkdir(workspaceDir, { recursive: true });
      const sourcePath = path.join(workspaceDir, "openclaw-workspace-state.json");
      await fs.writeFile(
        sourcePath,
        JSON.stringify({ version: 1, setupCompletedAt: "2026-07-15T00:00:00.000Z" }),
      );
      const initialSnapshotRead =
        source === "supplied snapshot"
          ? await readConfigFileSnapshotWithPluginMetadata({ observe: false })
          : undefined;
      if (initialSnapshotRead) {
        await writeConfigFile({
          ...cfg,
          agents: {
            ...cfg.agents,
            entries: {
              ...cfg.agents?.entries,
              secondary: { workspace: path.join(stateDir, "workspace-clean") },
            },
          },
        });
      }
      const port = await getFreePort();
      const attempt = start(port, initialSnapshotRead).then((started) => {
        server = started;
        return started;
      });
      await expect(attempt).rejects.toThrow("Legacy workspace setup state requires migration");
      await expect(fetch(`http://127.0.0.1:${port}/readyz`)).rejects.toThrow();
      await expect(fs.stat(sourcePath)).resolves.toBeDefined();

      const migration = await migrateLegacyWorkspaceState({
        stateDir,
        detected: await detectLegacyWorkspaceState({
          cfg,
          stateDir,
          homedir: os.homedir,
          doctorOnlyStateMigrations: true,
        }),
      });
      expect(migration.warnings).toEqual([]);
      server = await start(port, initialSnapshotRead);
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(ready.status).toBe(200);
      await expect(fs.stat(sourcePath)).rejects.toHaveProperty("code", "ENOENT");
    },
  );

  it.each(["managed write", "file watcher"])(
    "rejects an unmigrated workspace switch before publication via %s",
    async (ingress) => {
      // The live candidate boundary needs the real managed reloader, not the minimal stub.
      state.envVars.OPENCLAW_TEST_MINIMAL_GATEWAY = undefined;
      state.applyEnv();
      const oldWorkspace = state.workspaceDir;
      const nextWorkspace = state.path("retained");
      const reloadError = vi.spyOn(gatewayKernelLogs.logReload, "error");
      const cfg: OpenClawConfig = {
        gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
        logging: { level: "silent", consoleLevel: "silent" },
        agents: {
          ownership: "explicit",
          defaults: { workspace: nextWorkspace },
          entries: { main: { workspace: oldWorkspace } },
        },
      };
      await state.writeConfig(cfg);
      await fs.mkdir(nextWorkspace, { recursive: true });
      const personaPath = path.join(nextWorkspace, "SOUL.md");
      const persona = "Retained workspace persona.\n";
      await fs.writeFile(personaPath, persona);
      const sourcePath = path.join(nextWorkspace, "openclaw-workspace-state.json");
      const legacyBytes = JSON.stringify({
        version: 1,
        setupCompletedAt: "2026-07-15T00:00:00.000Z",
      });
      await fs.writeFile(sourcePath, legacyBytes);
      const port = await getFreePort();
      server = await start(port);
      await server.startupSettled;
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
          .poll(
            () =>
              reloadError.mock.calls.length > 0 ||
              resolveAgentWorkspaceDir(getRuntimeConfig(), "main") === nextWorkspace,
            { timeout: 5_000 },
          )
          .toBe(true);
        expect(reloadError).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
        expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(nextConfig);
      }
      expect(resolveAgentWorkspaceDir(getRuntimeConfig(), "main")).toBe(oldWorkspace);
      await expect(
        ensureAgentWorkspace({ dir: resolveAgentWorkspaceDir(getRuntimeConfig(), "main") }),
      ).resolves.toMatchObject({ dir: oldWorkspace });
      await expect(client.request("health", {})).resolves.toEqual(expect.any(Object));
      expect(await fs.readFile(sourcePath, "utf8")).toBe(legacyBytes);

      await disconnectGatewayClient(client);
      client = undefined;
      await server.close();
      server = undefined;
      const migration = await migrateLegacyWorkspaceState({
        stateDir: state.stateDir,
        detected: await detectLegacyWorkspaceState({
          cfg: nextConfig,
          stateDir: state.stateDir,
          doctorOnlyStateMigrations: true,
        }),
      });
      expect(migration.warnings).toEqual([]);
      await expect(fs.stat(sourcePath)).rejects.toHaveProperty("code", "ENOENT");
      // Restart with last-good config, then retry the same live change after Doctor.
      await state.writeConfig(cfg);
      server = await start(port);
      await server.startupSettled;
      await writeConfigFile(nextConfig);
      await expect
        .poll(() => resolveAgentWorkspaceDir(getRuntimeConfig(), "main"))
        .toBe(nextWorkspace);
      await expect(ensureAgentWorkspace({ dir: nextWorkspace })).resolves.toMatchObject({
        dir: nextWorkspace,
      });
      expect(await fs.readFile(personaPath, "utf8")).toBe(persona);
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
    },
  );
});
