import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { resolveConfiguredPrimaryModelForAgent } from "../agents/utility-model.js";
import { migrateLegacyConfig } from "../commands/doctor/shared/legacy-config-migrate.js";
import { clearConfigCache, readConfigFileSnapshot } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { buildCatalogModel } from "../plugin-sdk/provider-catalog.test-support.js";
import { fixture, modelRef } from "./setup-inference-activate.test-support.js";
import { resetSetupInferenceState } from "./setup-inference-state.test-support.js";

afterEach(resetSetupInferenceState);

const utilityResult = { ok: true, modelRef, modelTarget: "utility" };
const utilityDetection = { utilityModel: modelRef, setupModel: modelRef, setupComplete: false };
async function writeConfig(configPath: string, config: unknown) {
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  clearConfigCache();
}
it.each([modelRef, "legacy/working", undefined])(
  "preserves implicit primary %s across utility login",
  async (priorModel) => {
    const setup = await fixture({
      modelTarget: "utility",
      addProviderDuringLogin: priorModel !== modelRef,
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
            models: [buildCatalogModel("working", { name: "Legacy fixture", maxTokens: 4096 })],
          },
        },
      };
    }
    await writeConfig(setup.configPath, setup.config);

    if (priorModel) {
      const before = await fs.readFile(setup.configPath, "utf8");
      await expect(setup.activate()).rejects.toThrow(/doctor --fix|explicit primary/i);
      expect([setup.login.mock.calls, setup.run.mock.calls]).toEqual([[], []]);
      expect(await fs.readFile(setup.configPath, "utf8")).toBe(before);
      const migrated = migrateLegacyConfig(setup.config, {
        sourceConfigBeforeMigrations: setup.config,
      });
      assert(migrated.config);
      expect(migrated.partiallyValid).toBeUndefined();
      await writeConfig(setup.configPath, migrated.config);
    }

    vi.mocked(setup.prompter.confirm).mockResolvedValue(true);
    const result = await setup.activate();

    expect(result, result.ok ? undefined : result.error).toMatchObject(utilityResult);
    expect(setup.login).toHaveBeenCalledOnce();
    expect(setup.run).toHaveBeenCalledOnce();
    const candidate = setup.run.mock.calls[0]?.[0].config;
    assert(candidate);
    expect(resolveConfiguredPrimaryModelForAgent({ cfg: candidate, agentId: "main" })).toBe(
      priorModel,
    );
    const { valid, sourceConfig: source } = await readConfigFileSnapshot();
    const profile = setup.readProfile();
    assert(profile);
    expect(valid).toBe(true);
    expect(source.meta?.migrations?.utilityModelSeparation).toBe(true);
    expect(resolveAgentModelPrimaryValue(source.agents?.defaults?.model)).toBe(priorModel);
    expect(source.agents?.defaults?.utilityModel).toBe(`${modelRef}@${profile[0]}`);
    expect(source.models?.providers?.openai?.models[0]?.id).toBe("gpt-5.4-mini");
    if (priorModel === "legacy/working") {
      expect(source.models?.providers?.legacy).toEqual(setup.config.models?.providers?.legacy);
    }
    if (!priorModel) {
      const detected = await setup.detect();
      expect(detected).toMatchObject(utilityDetection);
      expect(detected.configuredModel).toBeUndefined();
    }
  },
);

it.each(["helper", modelRef])(
  "rechecks canonical identity while preserving authored %s and its profile",
  async (authoredModel) => {
    const setup = await fixture({ modelTarget: "utility" });
    expect(await setup.activate()).toMatchObject({ ok: true });
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
    expect(detected).toMatchObject(utilityDetection);
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
    expect(verified).toMatchObject(utilityResult);
    expect(setup.run).toHaveBeenCalledOnce();
    expect(setup.run.mock.calls[0]?.[0].authProfileId).toBe(profile[0]);
    expect(await fs.readFile(setup.configPath, "utf8")).toBe(authoredConfig);
  },
);
