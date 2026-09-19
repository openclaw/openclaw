import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  runInitialConfigWriteHealth,
  runWriteConfigHealth,
} from "./doctor-health-contribution-runners.config.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Doctor config persistence after deferred migrations", () => {
  it.each([
    { deferred: false, include: false },
    { deferred: true, include: false },
    { deferred: false, include: true },
    { deferred: true, include: true },
  ])(
    "finishes retired inputs in the same Doctor without redundant writes (deferred: $deferred, include: $include)",
    async ({ deferred, include }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-14T00:00:00Z"));
      await withOpenClawTestState(
        {
          label: "doctor-deferred-config-write",
          env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
        },
        async (state) => {
          const authored = {
            gateway: { mode: "local" },
            agents: { defaults: { workspace: "${OPENCLAW_HOME}" } },
            plugins: {
              allow: ["codex", "fixture"],
              entries: {
                codex: { enabled: true, config: { codexDynamicToolsProfile: "legacy" } },
                fixture: { enabled: false },
              },
            },
          };
          if (include) {
            await state.writeJson("plugins.json", authored.plugins);
          }
          await state.writeConfig(
            include ? { ...authored, plugins: { $include: "./plugins.json" } } : authored,
          );
          const outputPath = include ? state.statePath("plugins.json") : state.configPath;
          const retiredPath = `${include ? "" : "plugins."}entries.codex.config.codexDynamicToolsProfile`;
          if (deferred) {
            recordDeferredPluginMigrations({
              env: state.env,
              pending: [
                {
                  pluginId: "codex",
                  reason: "The configured plugin is not available.",
                  command: "openclaw doctor --fix",
                  configPaths: [["plugins", "entries", "codex", "config"]],
                },
              ],
            });
          }
          const initial = await readConfigFileSnapshot({ observe: false });
          const cfg: OpenClawConfig = {
            ...initial.sourceConfig,
            plugins: {
              ...initial.sourceConfig.plugins,
              entries: {
                ...initial.sourceConfig.plugins?.entries,
                codex: { enabled: true, config: {} },
                fixture: { enabled: true },
              },
            },
          };
          const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          const options = { nonInteractive: true };
          const ctx: DoctorHealthFlowContext = {
            runtime,
            options,
            prompter: createDoctorPrompter({ runtime, options }),
            configResult: {
              cfg,
              shouldWriteConfig: true,
              skipWizardMetadataForIncludeWrite: include,
            },
            cfg,
            cfgForPersistence: structuredClone(cfg),
            sourceConfigValid: true,
            configPath: state.configPath,
            env: state.env,
          };

          await runInitialConfigWriteHealth(ctx);
          expect(ctx.configWriteRefusal).toBeUndefined();
          const firstRaw = await fs.readFile(outputPath, "utf8");
          if (deferred) {
            expect(JSON.parse(firstRaw)).toHaveProperty(retiredPath, "legacy");
          } else {
            expect(JSON.parse(firstRaw)).not.toHaveProperty(retiredPath);
          }
          expect(JSON.parse(firstRaw)).toHaveProperty(
            `${include ? "" : "plugins."}entries.fixture.enabled`,
            true,
          );
          expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toHaveProperty(
            "agents.defaults.workspace",
            "${OPENCLAW_HOME}",
          );
          const desired = structuredClone(ctx.cfg);
          if (deferred) {
            recordDeferredPluginMigrations({
              env: state.env,
              pending: [],
              resolvedPluginIds: ["codex"],
            });
            expect(readDeferredPluginMigrations({ env: state.env })).toEqual([]);
          }
          expect(ctx.cfg).toEqual(desired);

          vi.setSystemTime(new Date("2026-09-14T00:00:01Z"));
          await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });
          const finalRaw = await fs.readFile(outputPath, "utf8");
          expect(JSON.parse(finalRaw)).not.toHaveProperty(retiredPath);
          expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toHaveProperty(
            "agents.defaults.workspace",
            "${OPENCLAW_HOME}",
          );
          expect(ctx.cfg.agents?.defaults?.workspace).toBe(state.home);
          if (!deferred) {
            expect(finalRaw).toBe(firstRaw);
          }

          vi.setSystemTime(new Date("2026-09-14T00:00:02Z"));
          await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });
          expect(await fs.readFile(outputPath, "utf8")).toBe(finalRaw);
        },
      );
    },
  );
});
