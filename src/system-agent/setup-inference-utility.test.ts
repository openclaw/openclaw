import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfiguredPrimaryModelForAgent } from "../agents/utility-model.js";
import { migrateLegacyConfig } from "../commands/doctor/shared/legacy-config-migrate.js";
import { clearConfigCache, readConfigFileSnapshot } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { fixture, modelRef, tempDirs } from "./setup-inference-activate.test-support.js";

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
  clearConfigCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("configured utility detection and activation", () => {
  it.each([
    { priorModel: modelRef, addProviderDuringLogin: false },
    { priorModel: "legacy/working", addProviderDuringLogin: true },
    { priorModel: undefined, addProviderDuringLogin: true },
  ])(
    "preserves the pre-setup implicit primary $priorModel when utility login adds a provider: $addProviderDuringLogin",
    async ({ priorModel, addProviderDuringLogin }) => {
      const setup = await fixture({
        modelTarget: "utility",
        addProviderDuringLogin,
        fresh: priorModel === undefined,
      });
      delete setup.config.meta;
      const defaults = setup.config.agents?.defaults;
      assert(defaults);
      if (priorModel) {
        defaults.utilityModel = priorModel;
      }
      if (priorModel === "legacy/working") {
        setup.config.models = {
          providers: {
            legacy: {
              api: "openai-completions",
              baseUrl: "https://legacy.example/v1",
              models: [
                {
                  id: "working",
                  name: "Legacy fixture",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        };
      }
      await fs.writeFile(setup.configPath, `${JSON.stringify(setup.config, null, 2)}\n`);
      clearConfigCache();

      if (priorModel) {
        const before = await fs.readFile(setup.configPath, "utf8");
        await expect(setup.activate()).rejects.toThrow(/doctor --fix|explicit primary/i);
        expect(setup.login).not.toHaveBeenCalled();
        expect(setup.run).not.toHaveBeenCalled();
        expect(await fs.readFile(setup.configPath, "utf8")).toBe(before);
        const migrated = migrateLegacyConfig(setup.config, {
          sourceConfigBeforeMigrations: setup.config,
        });
        assert(migrated.config);
        expect(migrated.partiallyValid).toBeUndefined();
        await fs.writeFile(setup.configPath, `${JSON.stringify(migrated.config, null, 2)}\n`);
        clearConfigCache();
      }

      vi.mocked(setup.prompter.confirm).mockResolvedValue(true);
      const result = await setup.activate();

      expect(result, result.ok ? undefined : result.error).toMatchObject({
        ok: true,
        modelRef,
        modelTarget: "utility",
      });
      expect(setup.login).toHaveBeenCalledOnce();
      expect(setup.run).toHaveBeenCalledOnce();
      const candidate = setup.run.mock.calls[0]?.[0].config;
      assert(candidate);
      expect(resolveConfiguredPrimaryModelForAgent({ cfg: candidate, agentId: "main" })).toBe(
        priorModel,
      );
      const saved = await readConfigFileSnapshot();
      const profile = setup.readProfile();
      assert(profile);
      expect(saved.valid).toBe(true);
      expect(saved.sourceConfig.meta?.migrations?.utilityModelSeparation).toBe(true);
      expect(resolveAgentModelPrimaryValue(saved.sourceConfig.agents?.defaults?.model)).toBe(
        priorModel,
      );
      expect(saved.sourceConfig.agents?.defaults?.utilityModel).toBe(`${modelRef}@${profile[0]}`);
      expect(saved.sourceConfig.models?.providers?.openai?.models[0]?.id).toBe("gpt-5.4-mini");
      if (priorModel === "legacy/working") {
        expect(saved.sourceConfig.models?.providers?.legacy).toEqual(
          setup.config.models?.providers?.legacy,
        );
      }
      if (!priorModel) {
        const detected = await setup.detect();
        expect(detected).toMatchObject({
          utilityModel: modelRef,
          setupModel: modelRef,
          setupComplete: false,
        });
        expect(detected.configuredModel).toBeUndefined();
      }
    },
  );

  it.each(["helper", modelRef])(
    "rechecks the advertised canonical identity while preserving authored %s and its profile",
    async (authoredModel) => {
      const setup = await fixture({ modelTarget: "utility" });
      const activated = await setup.activate();
      expect(activated).toMatchObject({ ok: true });
      const profile = setup.readProfile();
      assert(profile);
      const config = (await readConfigFileSnapshot()).sourceConfig;
      const defaults = config.agents?.defaults;
      assert(defaults?.models?.[modelRef]);
      defaults.models[modelRef].alias = "helper";
      defaults.utilityModel = `${authoredModel}@${profile[0]}`;
      const authoredConfig = `${JSON.stringify(config, null, 2)}\n`;
      await fs.writeFile(setup.configPath, authoredConfig);
      clearConfigCache();

      const detected = await setup.detect();
      expect(detected).toMatchObject({
        utilityModel: modelRef,
        setupModel: modelRef,
        setupComplete: false,
      });
      expect(detected.configuredModel).toBeUndefined();
      const candidate = detected.candidates.find(
        (entry) => entry.kind === "existing-model" && entry.modelTarget === "utility",
      );
      assert(candidate);
      expect(candidate.modelRef).toBe(modelRef);
      setup.run.mockClear();
      const verified = await setup.activate("existing-model", undefined, {
        modelRef: candidate.modelRef,
        modelTarget: candidate.modelTarget,
      });
      expect(verified).toMatchObject({
        ok: true,
        modelRef,
        modelTarget: "utility",
      });
      expect(setup.run).toHaveBeenCalledOnce();
      expect(setup.run.mock.calls[0]?.[0].authProfileId).toBe(profile[0]);
      expect(await fs.readFile(setup.configPath, "utf8")).toBe(authoredConfig);
    },
  );
});
