// Minimal-gateway boot smoke: guards the startup path the Control UI e2e suites
// depend on. Bundled plugins stay enabled on purpose — disabling them (as other
// gateway boot tests do) hides startup work that materializes plugin runtime,
// which is exactly how a startup stall shipped green while hanging every
// ui-e2e suite that boots a minimal test gateway.
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import { readLoggingConfig } from "../logging/config.js";
import { resetLogger } from "../logging/logger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  getSkillsSnapshotVersion,
  resetSkillsRefreshStateForTest,
} from "../skills/runtime/refresh-state.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";

// Local boot completes in ~10s; the budget only buys headroom for loaded CI
// runners. A stall exhausts it and fails in the gateway lane instead of first
// surfacing on unrelated UI PRs.
const BOOT_BUDGET_MS = 90_000;

afterEach(() => {
  resetLogger();
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
  clearPluginMetadataLifecycleCaches();
  resetSkillsRefreshStateForTest();
});

describe("gateway minimal boot smoke", () => {
  it("suppresses ambient channel triggers and awaits subagent recovery", async ({ signal }) => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-bootstrap-ambient-default",
      layout: "home",
      env: {
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    const token = "gateway-bootstrap-test-token";
    await state.writeConfig({
      gateway: { auth: { mode: "token", token } },
      logging: { level: "debug" },
      plugins: {},
    });
    state.applyEnv();

    try {
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
      const pendingBootstrap = prepareGatewayServerBootstrap({
        port,
        opts: {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        },
        log,
        logSecrets: log,
        loadWorkerEnvironmentStartupModule: async () =>
          await import("./server-worker-environment-startup.js"),
        formatRuntimeGatewayAuthTokenWarning: () => "unused",
      });
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            enteredRecovery.promise,
            pendingBootstrap,
            "Gateway bootstrap did not prepare subagent recovery",
          ),
          signal,
        );
        expect(publish).not.toHaveBeenCalled();
        releaseRecovery.resolve();
        const bootstrap = await withinTest(pendingBootstrap, signal);
        expect(publish).toHaveBeenCalled();
        expect(bootstrap.ambientEnvTriggers).toBe("suppress");
        vi.stubEnv(
          "OPENCLAW_CONFIG_PATH",
          `/tmp/openclaw-bootstrap-missing-${process.pid}-${Date.now()}.json`,
        );
        expect(readLoggingConfig()).toMatchObject({ level: "debug" });
      } finally {
        releaseRecovery.resolve();
        await pendingBootstrap.catch(() => {});
        init.mockRestore();
        publish.mockRestore();
      }
    } finally {
      await state.cleanup();
    }
  });

  it(
    "boots and refreshes skill snapshots on each start",
    { timeout: BOOT_BUDGET_MS * 2 },
    async () => {
      const port = await getFreePort();
      const state = await createOpenClawTestState({
        label: "gateway-minimal-boot-smoke",
        layout: "home",
        env: {
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          VITEST: "1",
        },
      });
      const token = "gateway-minimal-boot-smoke-token";
      const timelinePath = state.path("gateway-startup.jsonl");
      state.envVars.OPENCLAW_DIAGNOSTICS = "1";
      state.envVars.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = timelinePath;
      await state.writeConfig({
        gateway: {
          auth: { mode: "token", token },
          controlUi: { enabled: false },
          port,
        },
      });
      state.applyEnv();
      try {
        const { startGatewayServer } = await import("./server.js");
        let snapshotVersion = getSkillsSnapshotVersion();
        for (const startup of [1, 2]) {
          await fs.writeFile(timelinePath, "");
          const server = await startGatewayServer(port, {
            auth: { mode: "token", token },
            bind: "loopback",
            controlUiEnabled: false,
            sidecarStartup: "defer",
          });
          try {
            const nextVersion = getSkillsSnapshotVersion();
            expect(
              nextVersion,
              `startup ${startup} must invalidate restored skills`,
            ).toBeGreaterThan(snapshotVersion);
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
      } finally {
        await state.cleanup();
      }
    },
  );
});
