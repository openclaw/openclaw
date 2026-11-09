// Real Doctor CLI, native repair loader, and cross-process persisted observations.
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { runManagedCommand } from "../scripts/lib/managed-child-process.mts";
import { getCliProcessTestTimeout } from "../src/cli/cli-process-child.test-helpers.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { recordDeferredPluginMigrations } from "../src/infra/deferred-plugin-migrations.js";
import { buildUpdateRehearsalPathEnv } from "../src/infra/update-rehearsal-paths.js";
import { seedInstalledPluginIndex } from "../src/plugins/test-helpers/installed-plugin-index.js";
import { withEnvAsync } from "../src/test-utils/env.js";
import { cleanupSessionStateForTest } from "../src/test-utils/session-state-cleanup.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

it(
  "promotes legacy heartbeat in fresh update Doctor processes without losing retained inputs",
  { timeout: getCliProcessTestTimeout(120_000, 120_000, 30_000, 30_000, 30_000) },
  async () => {
    const instance = await createOpenClawTestInstance({ name: "rh209-guidance" });
    try {
      const pluginId = "rh209-guidance-fixture";
      const pluginRoot = path.join(instance.stateDir, "fixture-plugin");
      await fs.mkdir(pluginRoot, { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, "package.json"),
        JSON.stringify({
          name: "@example/rh209-guidance-fixture",
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      await fs.writeFile(path.join(pluginRoot, "index.cjs"), "module.exports = {};\n");
      await fs.writeFile(
        path.join(pluginRoot, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          configSchema: {
            type: "object",
            properties: { region: { type: "string" } },
            additionalProperties: false,
          },
        }),
      );
      const config = {
        gateway: { mode: "local" },
        plugins: {
          allow: [pluginId],
          load: { paths: [pluginRoot] },
          entries: { [pluginId]: { enabled: true, config: { region: "us-en" } } },
        },
        agents: {
          defaults: { heartbeat: { agentId: "main", every: "30m" } },
          // Two agents force the full native binding-repair loader, not its one-agent fast path.
          entries: {
            main: { workspace: path.join(instance.stateDir, "workspace") },
            worker: { workspace: path.join(instance.stateDir, "worker-workspace") },
          },
        },
      } satisfies OpenClawConfig;
      await fs.writeFile(
        instance.configPath,
        JSON.stringify({
          ...config,
          agents: {
            ...config.agents,
            defaults: { heartbeat: { ...config.agents.defaults.heartbeat, skipWhenBusy: true } },
          },
        }),
      );
      Object.assign(instance.env, buildUpdateRehearsalPathEnv(instance.stateDir), {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
      });
      for (const key of [
        "VITEST",
        "VITEST_POOL_ID",
        "VITEST_WORKER_ID",
        "NODE_ENV",
        "OPENCLAW_TEST_FAST",
        "OPENCLAW_TEST_MINIMAL_GATEWAY",
        "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE",
        "OPENCLAW_COMPATIBILITY_HOST_VERSION",
      ]) {
        delete instance.env[key];
      }
      await withEnvAsync(instance.env, async () => {
        await recordDeferredPluginMigrations({
          pending: [
            {
              pluginId,
              reason:
                "Package convergence must wait until the updating parent releases its install records.",
              command: "openclaw update repair",
              requiresStateMigration: true,
              configPaths: [["plugins", "entries", pluginId, "config"]],
            },
          ],
        });
        // Seeding metadata is not a product-loader replacement; Doctor receives no mocks.
        await seedInstalledPluginIndex(
          { [pluginId]: { source: "path", sourcePath: pluginRoot, installPath: pluginRoot } },
          { config },
        );
        await cleanupSessionStateForTest({
          stateDir: instance.stateDir,
          rootPath: instance.state.root,
        });
      });
      const observe = async (phase: "before" | "after") => {
        let output = "";
        const code = await runManagedCommand({
          bin: process.execPath,
          args: [path.resolve("test/fixtures/rh209-observer.mjs"), instance.stateDir, phase],
          cwd: process.cwd(),
          env: instance.env,
          timeoutMs: 30_000,
          stdio: ["ignore", "pipe", "inherit"],
          onReady: (child) =>
            child.stdout?.on("data", (chunk) => {
              output += String(chunk);
            }),
        });
        expect(code, output).toBe(0);
        const observation: unknown = JSON.parse(output);
        if (!isRecord(observation) || typeof observation.pid !== "number") {
          throw new Error("Invalid fresh observer receipt: " + output);
        }
        expect(observation.pid).not.toBe(process.pid);
        return observation;
      };
      await observe("before");
      const args = ["doctor", "--fix", "--non-interactive", "--yes", "--no-workspace-suggestions"];
      // The normal E2E wrapper, not this fixture, prepares the current source build.
      expect(await instance.entrypoint()).toEqual([
        expect.stringMatching(/^dist\/index\.[cm]?js$/u),
      ]);
      const first = await instance.cli(args, { timeoutMs: 120_000 });
      expect(first.code, first.stdout + first.stderr).toBe(0);
      const after = await observe("after");
      const second = await instance.cli(args, { timeoutMs: 120_000 });
      expect(second.code, second.stdout + second.stderr).toBe(0);
      const reopened = await observe("after");
      expect(reopened.pid).not.toBe(after.pid);
      expect(reopened.heartbeat).toEqual(after.heartbeat);
      expect(reopened.pending).toEqual(after.pending);
    } finally {
      await instance.cleanup();
    }
  },
);
