import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  checkInitialConfigWriteHealthPending,
  checkWriteConfigHealthPending,
} from "./doctor-health-contribution-runners.config-plan.js";
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
        const plugins = {
          allow: ["codex", "fixture"],
          entries: {
            codex: { enabled: true, config: { codexDynamicToolsProfile: "legacy" } },
            fixture: { enabled: false },
          },
        };
        if (include) {
          await state.writeJson("plugins.json", plugins);
        }
        await state.writeConfig({
          gateway: { mode: "local" },
          agents: { defaults: { workspace: "${OPENCLAW_HOME}" } },
          plugins: include ? { $include: "./plugins.json" } : plugins,
        });
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
        const cfg = structuredClone(initial.sourceConfig);
        cfg.plugins!.entries!.codex = { enabled: true, config: {} };
        cfg.plugins!.entries!.fixture = { enabled: true };
        const ctx = createDoctorHealthFlowContext({
          options: { nonInteractive: true },
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
        ctx.prompter = createDoctorPrompter({ runtime: ctx.runtime, options: ctx.options });

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
        const deferRepairs = { runPostWriteRepairs: false };
        await expect(checkInitialConfigWriteHealthPending(ctx)).resolves.toBe("work");
        expect(await read()).toBe(beforeFirstWrite);
        await runInitialConfigWriteHealth(ctx);
        expect(ctx.configWriteRefusal).toBeUndefined();
        const firstRaw = await read();
        await assertPersisted(beforeFirstWrite);
        const first = JSON.parse(firstRaw);
        if (deferred) {
          expect(first).toHaveProperty(retiredPath, "legacy");
        } else {
          expect(first).not.toHaveProperty(retiredPath);
        }
        expect(include ? first.entries : first.plugins.entries).toMatchObject({
          fixture: { enabled: true },
        });
        if (deferred) {
          await recordDeferredPluginMigrations({
            env: state.env,
            pending: [],
            resolvedPluginIds: ["codex"],
          });
          expect(readDeferredPluginMigrations({ env: state.env })).toEqual([]);
        }

        // Only a retained deferred input leaves a second write for the final pass.
        await expect(checkWriteConfigHealthPending(ctx, deferRepairs)).resolves.toBe(
          deferred ? "work" : "none",
        );
        const identity = async () => {
          const { ino, mtimeMs } = await fs.stat(outputPath);
          return { ino, mtimeMs };
        };
        const firstIdentity = await identity();
        vi.setSystemTime(startedAt + 1_000);
        await runWriteConfigHealth(ctx, deferRepairs);
        const finalRaw = await read();
        if (!deferred) {
          expect(await identity()).toEqual(firstIdentity);
        }
        await assertPersisted(deferred ? firstRaw : beforeFirstWrite);
        expect(JSON.parse(finalRaw)).not.toHaveProperty(retiredPath);
        expect(ctx.cfg.agents?.defaults?.workspace).toBe(state.home);
        if (!deferred) {
          expect(finalRaw).toBe(firstRaw);
        }

        await expect(checkWriteConfigHealthPending(ctx, deferRepairs)).resolves.toBe("none");
        const finalIdentity = await identity();
        vi.setSystemTime(startedAt + 2_000);
        await runWriteConfigHealth(ctx, deferRepairs);
        expect(await read()).toBe(finalRaw);
        expect(await identity()).toEqual(finalIdentity);
      },
    );
  },
);
