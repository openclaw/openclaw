// Keep bundled plugins enabled: disabling them hid a startup stall from UI e2e proof.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import { resolveConfigDir } from "../infra/config-dir.js";
import { writeGatewayRestartHandoff } from "../infra/restart-handoff.js";
import { readLoggingConfig } from "../logging/config.js";
import { resetLogger } from "../logging/logger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  getSkillsSnapshotVersion,
  resetSkillsRefreshStateForTest,
} from "../skills/runtime/refresh-state.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
import { getFreePort } from "../test-utils/ports.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { createStartupTestState, gatewayStartupOptions } from "./server-startup.test-support.js";

// Allow loaded CI headroom while catching stalls here instead of in UI e2e.
const BOOT_BUDGET_MS = 90_000;
const bootOptions = gatewayStartupOptions("gateway-minimal-boot-smoke-token");
const { auth } = bootOptions;

afterEach(() => {
  resetLogger();
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
  clearPluginMetadataLifecycleCaches();
  resetSkillsRefreshStateForTest();
});

it.for(["default", "split", "profile"] as const)(
  "suppresses ambient triggers and preserves config selection (%s)",
  async (selection, { signal }) => {
    const port = await getFreePort();
    await using state = await createStartupTestState("gateway-bootstrap-ambient-default", {
      OPENCLAW_GATEWAY_RESTART_TRACE: "0",
    });
    await state.writeConfig({
      gateway: { auth },
      logging: { level: "debug" },
      plugins: {},
    });
    state.applyEnv();
    vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
    if (selection !== "default") {
      const configPath =
        selection === "split"
          ? state.path("custom-config", "openclaw.json")
          : path.join(state.home, ".openclaw-work", "openclaw.json");
      if (selection === "profile") {
        vi.stubEnv("OPENCLAW_PROFILE", "work");
      }
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.rename(state.configPath, configPath);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    }
    const configDir = resolveConfigDir();

    await expect(
      writeGatewayRestartHandoff({
        env: state.env,
        reason: "gateway.restart",
        restartKind: "full-process",
        supervisorMode: "launchd",
      }),
    ).resolves.toMatchObject({ source: "operator-restart", supervisorMode: "launchd" });
    const [{ prepareGatewayServerBootstrap }, subagents, pluginContext] = await Promise.all([
      import("./server-startup-bootstrap.js"),
      import("../agents/subagents/registry/subagent-registry.js"),
      import("../plugins/runtime/load-context.js"),
    ]);
    const enteredRecovery = createDeferred();
    const releaseRecovery = createDeferred();
    let recoveryComplete = false;
    const init = vi.spyOn(subagents, "initSubagentRegistry").mockImplementation(() => {
      enteredRecovery.resolve();
      return releaseRecovery.promise.then(() => {
        recoveryComplete = true;
      });
    });
    const publishPluginContext = pluginContext.setPluginRuntimeLoadContext;
    const publish = vi
      .spyOn(pluginContext, "setPluginRuntimeLoadContext")
      .mockImplementation((...args) => {
        expect(recoveryComplete).toBe(true);
        return publishPluginContext(...args);
      });
    const log = createSubsystemLogger("gateway/bootstrap-test");
    const sql = observeHostDataSql();
    const pendingBootstrap = prepareGatewayServerBootstrap({
      port,
      opts: bootOptions,
      log,
      logSecrets: log,
      loadWorkerEnvironmentStartupModule: async () =>
        await import("./server-worker-environment-startup.js"),
      formatRuntimeGatewayAuthTokenWarning: () => "unused",
    });
    const waitingBootstrap = withinTest(pendingBootstrap, signal);
    try {
      await awaitGateBeforeSettlement(
        enteredRecovery.promise,
        waitingBootstrap,
        "Gateway bootstrap did not prepare subagent recovery",
      );
      expect(publish).not.toHaveBeenCalled();
      releaseRecovery.resolve();
      const bootstrap = await waitingBootstrap;
      expect(publish).toHaveBeenCalled();
      expect(bootstrap.ambientEnvTriggers).toBe("suppress");
      expect(resolveConfigDir()).toBe(configDir);
      if (selection !== "default") {
        expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
      }
      {
        using resolve = vi.spyOn(path, "resolve");
        using join = vi.spyOn(path, "join");
        for (let index = 0; index < 10; index++) {
          expect(readAgentDatabaseAdmissionRefusal("main")).toBeUndefined();
        }
        if (selection === "default") {
          if (process.platform !== "win32") {
            expect(resolve).not.toHaveBeenCalled();
          }
          expect(join).not.toHaveBeenCalled();
        }
      }
      expect(
        sql.queries.filter((query) => /\bfrom\s+"?gateway_restart_handoff\b/iu.test(query)),
      ).toEqual([]);
      vi.stubEnv(
        "OPENCLAW_CONFIG_PATH",
        `/tmp/openclaw-bootstrap-missing-${process.pid}-${Date.now()}.json`,
      );
      expect(readLoggingConfig()).toMatchObject({ level: "debug" });
    } finally {
      releaseRecovery.resolve();
      await pendingBootstrap.catch(() => {});
      sql.restore();
      init.mockRestore();
      publish.mockRestore();
      if (selection === "profile") {
        await cleanupSessionStateForTest({
          stateDir: path.join(state.home, ".openclaw-work"),
        });
      }
    }
  },
);

it(
  "boots and refreshes skill snapshots on each start",
  { timeout: BOOT_BUDGET_MS * 2 },
  async () => {
    const port = await getFreePort();
    await using state = await createStartupTestState("gateway-minimal-boot-smoke", {
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
    });
    const timelinePath = state.path("gateway-startup.jsonl");
    state.envVars.OPENCLAW_DIAGNOSTICS = "1";
    state.envVars.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = timelinePath;
    await state.writeConfig({
      gateway: { auth, controlUi: { enabled: false }, port },
    });
    state.applyEnv();
    const { startGatewayServer } = await import("./server.js");
    let snapshotVersion = getSkillsSnapshotVersion();
    for (const startup of [1, 2]) {
      await fs.writeFile(timelinePath, "");
      const server = await startGatewayServer(port, bootOptions);
      try {
        const nextVersion = getSkillsSnapshotVersion();
        expect(nextVersion, `startup ${startup} must invalidate restored skills`).toBeGreaterThan(
          snapshotVersion,
        );
        snapshotVersion = nextVersion;
        const startupMeasures = (await fs.readFile(timelinePath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((event) => event.type === "span.start" && event.phase === "startup")
          .map((event) => {
            const attributes = event.attributes as { traceName?: string } | undefined;
            return attributes?.traceName ?? event.name;
          });
        expect(startupMeasures.indexOf("http.listen")).toBeGreaterThan(-1);
        expect(startupMeasures.indexOf("runtime.early")).toBeGreaterThan(
          startupMeasures.indexOf("http.listen"),
        );
      } finally {
        await server.close({ reason: "minimal boot smoke complete" });
      }
    }
  },
);
