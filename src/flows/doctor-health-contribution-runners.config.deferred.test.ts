import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
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
import { createDoctorHealthFlowContext } from "./doctor-health-contributions.test-support.js";

afterEach(() => vi.useRealTimers());

it.each([
  { deferred: false, include: false },
  { deferred: true, include: false },
  { deferred: false, include: true },
  { deferred: true, include: true },
])(
  "persists Doctor repairs once (deferred: $deferred, include: $include)",
  async ({ deferred, include }) => {
    // The lease worker uses real time; keep the controlled config clock nearby.
    const startedAt = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(startedAt);
    await withOpenClawTestState(
      { env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
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
          await recordDeferredPluginMigrations({
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
        const ctx = createDoctorHealthFlowContext({
          runtime,
          options,
          prompter: createDoctorPrompter({ runtime, options }),
          configResult: {
            confirmedConfigSource: {
              path: initial.path,
              hash: initial.hash ?? hashConfigRaw(initial.raw),
            },
            shouldWriteConfig: true,
            skipWizardMetadataForIncludeWrite: include,
          },
          cfg,
          cfgForPersistence: structuredClone(cfg),
          configPath: state.configPath,
          env: state.env,
        });

        const read = (file = outputPath) => fs.readFile(file, "utf8");
        const beforeFirstWrite = await read();
        const rootBefore = await read(state.configPath);
        const assertPersisted = async (backup: string) => {
          expect(await read(outputPath + ".bak")).toBe(backup);
          if (include) {
            expect(await read(state.configPath)).toBe(rootBefore);
          }
          expect(ctx.configResult.confirmedConfigSource).toEqual({
            path: state.configPath,
            hash: (await readConfigFileSnapshot({ observe: false })).hash,
          });
          expect(JSON.parse(await read(state.configPath))).toHaveProperty(
            "agents.defaults.workspace",
            "${OPENCLAW_HOME}",
          );
        };
        await runInitialConfigWriteHealth(ctx);
        expect(ctx.configWriteRefusal).toBeUndefined();
        const firstRaw = await read();
        await assertPersisted(beforeFirstWrite);
        const firstReceipt = structuredClone(ctx.configResult.confirmedConfigSource);
        if (deferred) {
          expect(JSON.parse(firstRaw)).toHaveProperty(retiredPath, "legacy");
        } else {
          expect(JSON.parse(firstRaw)).not.toHaveProperty(retiredPath);
        }
        expect(JSON.parse(firstRaw)).toHaveProperty(
          `${include ? "" : "plugins."}entries.fixture.enabled`,
          true,
        );
        const desired = structuredClone(ctx.cfg);
        if (deferred) {
          await recordDeferredPluginMigrations({
            env: state.env,
            pending: [],
            resolvedPluginIds: ["codex"],
          });
          expect(readDeferredPluginMigrations({ env: state.env })).toEqual([]);
        }
        expect(ctx.cfg).toEqual(desired);

        vi.setSystemTime(startedAt + 1_000);
        await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });
        if (deferred) {
          expect(ctx.configResult.confirmedConfigSource?.hash).not.toBe(firstReceipt?.hash);
        }
        const finalRaw = await read();
        await assertPersisted(deferred ? firstRaw : beforeFirstWrite);
        expect(JSON.parse(finalRaw)).not.toHaveProperty(retiredPath);
        expect(ctx.cfg.agents?.defaults?.workspace).toBe(state.home);
        if (!deferred) {
          expect(finalRaw).toBe(firstRaw);
        }

        vi.setSystemTime(startedAt + 2_000);
        await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });
        expect(await read()).toBe(finalRaw);
      },
    );
  },
);
