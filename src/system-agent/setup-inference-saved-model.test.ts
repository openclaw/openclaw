import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { clearConfigCache, readConfigFileSnapshot as readSnapshot } from "../config/config.js";
import { resolveAgentModelPrimaryValue as primaryModel } from "../config/model-input.js";
import { buildCatalogModel } from "../plugin-sdk/provider-catalog.test-support.js";
import { credential, fixture, modelRef } from "./setup-inference-activate.test-support.js";
import { saveSetupCredential } from "./setup-inference-credentials.js";
import "./setup-inference-activate-cleanup.test-support.js";

describe("saved-auth model selection", () => {
  it("does not promote a utility-only model during ordinary saved-auth activation", async () => {
    const setup = await fixture({ authMethod: "api_key" });
    const starterModelRef = "openai/starter-model";
    const configured = structuredClone(setup.config);
    assert(configured.agents?.defaults);
    assert(configured.models?.providers?.openai?.models);
    delete configured.agents.defaults.model;
    configured.agents.defaults.utilityModel = modelRef;
    configured.models.providers.openai.models.push(
      buildCatalogModel("starter-model", { name: "Starter model" }),
    );
    await fs.writeFile(setup.configPath, JSON.stringify(configured));
    clearConfigCache();
    const saved = await saveSetupCredential({
      profile: { profileId: "openai:saved", credential },
      config: configured,
      baseConfig: configured,
      agentDir: setup.agentDir,
      modelRef: starterModelRef,
      authChoice: "fixture-login",
      pluginId: "openai",
    });
    const profileId = saved.profile.profileId;

    const detection = await setup.detect();
    const candidate = detection.candidates.find(
      ({ kind }) => kind === `saved-auth:${encodeURIComponent(profileId)}`,
    );
    assert.ok(candidate, "Setup did not discover the saved sign-in");
    expect(candidate.modelRef).toBe(starterModelRef);

    const result = await setup.activate(candidate.kind, true, { modelRef: candidate.modelRef });

    expect(result, result.ok ? undefined : result.error).toMatchObject({
      ok: true,
      modelRef: starterModelRef,
    });
    expect(setup.run.mock.calls[0]?.[0]).toMatchObject({
      authProfileId: profileId,
      model: "starter-model",
    });
    const persisted = (await readSnapshot()).sourceConfig;
    expect(primaryModel(persisted.agents?.defaults?.model)).toBe(`${starterModelRef}@${profileId}`);
    expect(persisted.agents?.defaults?.utilityModel).toBe(modelRef);
  });
});
