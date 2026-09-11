import { afterEach, beforeEach, expect, it } from "vitest";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { ModelDefinitionConfig } from "../../../config/types.models.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import {
  createRetiredModelRefRepairResolver,
  repairRetiredConfigModelRefs,
  repairRetiredSessionModelRef,
} from "./retired-model-ref-repair.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "xai-auto-retirement" });
  clearPluginMetadataLifecycleCaches();
  await state.writeAuthProfiles({
    version: 1,
    profiles: {
      "xai:fixture": { type: "token", provider: "xai", token: "synthetic-subscription-token" },
    },
  });
});
afterEach(async () => {
  clearPluginMetadataLifecycleCaches();
  await state.cleanup();
});

function configForRoute(baseUrl: string, models: ModelDefinitionConfig[] = []): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        model: { primary: "xai/auto", fallbacks: ["xai/grok-4.3"] },
        models: { "xai/auto": { alias: "Grok", params: { temperature: 0.25 } } },
      },
      entries: { main: {} },
    },
    auth: { profiles: { "xai:fixture": { provider: "xai", mode: "token" } } },
    models: { providers: { xai: { baseUrl, api: "openai-responses", auth: "token", models } } },
    plugins: { allow: ["xai"], entries: { xai: { enabled: true } } },
  };
}

it("repairs the subscription selector while preserving fallbacks and model settings", async () => {
  const cfg = configForRoute("https://cli-chat-proxy.grok.com/v1");
  await state.writeConfig(cfg);
  const resolve = createRetiredModelRefRepairResolver({ cfg, env: state.env });
  const repaired = repairRetiredConfigModelRefs(cfg, resolve);

  expect(repaired.config.agents?.defaults?.model).toEqual({
    primary: "xai/grok-4.6",
    fallbacks: ["xai/grok-4.3"],
  });
  expect(repaired.config.agents?.defaults?.models?.["xai/grok-4.6"]?.params).toEqual({
    temperature: 0.25,
  });
  expect(cfg.agents?.defaults?.model).toEqual({ primary: "xai/auto", fallbacks: ["xai/grok-4.3"] });
  expect(
    repairRetiredConfigModelRefs(
      repaired.config,
      createRetiredModelRefRepairResolver({ cfg: repaired.config, env: state.env }),
    ).changes,
  ).toEqual([]);
});

it("repairs a session override without changing its selected profile", async () => {
  const cfg = configForRoute("https://cli-chat-proxy.grok.com/v1");
  await state.writeConfig(cfg);
  const entry: SessionEntry = {
    sessionId: "xai-upgrade-session",
    updatedAt: 1,
    providerOverride: "xai",
    modelOverride: "auto",
    authProfileOverride: "xai:fixture",
    authProfileOverrideSource: "user",
  };
  const resolve = createRetiredModelRefRepairResolver({ cfg, env: state.env });
  expect(repairRetiredSessionModelRef(entry, "main", resolve, "xai/grok-4.6", [])).toBe(true);
  expect(entry.modelOverride).toBe("grok-4.6");
  expect(entry.authProfileOverride).toBe("xai:fixture");
  expect(entry.authProfileOverrideSource).toBe("user");
});

it("preserves a custom endpoint's explicit auto model", async () => {
  const cfg = configForRoute("https://custom-models.example/v1", [
    {
      id: "auto",
      name: "Custom automatic model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1024,
      maxTokens: 256,
    },
  ]);
  await state.writeConfig(cfg);
  const resolve = createRetiredModelRefRepairResolver({ cfg, env: state.env });
  expect(resolve({ modelRef: "xai/auto", agentId: "main" })).toEqual({ kind: "unchanged" });
  expect(repairRetiredConfigModelRefs(cfg, resolve).config).toBe(cfg);
});

it("repairs an unpinned config on its declared subscription route without credentials", async () => {
  const cfg = configForRoute("https://cli-chat-proxy.grok.com/v1");
  await state.writeConfig(cfg);
  await state.writeAuthProfiles({ version: 1, profiles: {} });
  const warnings: string[] = [];
  const resolve = createRetiredModelRefRepairResolver({ cfg, env: state.env, warnings });
  expect(resolve({ modelRef: "xai/auto", agentId: "main" })).toEqual({
    kind: "replace",
    modelRef: "xai/grok-4.6",
    reason: "retirement",
    retirementScope: "route",
  });
  expect(warnings).toEqual([]);
});

it("retains a missing pinned account instead of substituting the available profile", async () => {
  const cfg = configForRoute("https://cli-chat-proxy.grok.com/v1");
  await state.writeConfig(cfg);
  const warnings: string[] = [];
  const resolve = createRetiredModelRefRepairResolver({ cfg, env: state.env, warnings });
  expect(
    resolve({
      modelRef: "xai/auto",
      agentId: "main",
      authProfileId: "xai:missing",
      authProfileSource: "user",
    }),
  ).toEqual({ kind: "unchanged" });
  expect(warnings).toEqual([expect.stringContaining("authentication route is unavailable")]);
});

it("keeps a pinned session when its successor is outside the allowed models", async () => {
  const original = configForRoute("https://cli-chat-proxy.grok.com/v1");
  const cfg: OpenClawConfig = {
    ...original,
    agents: {
      ...original.agents,
      defaults: { ...original.agents?.defaults, modelPolicy: { allow: ["xai/auto"] } },
    },
  };
  await state.writeConfig(cfg);
  const warnings: string[] = [];
  const entry: SessionEntry = {
    sessionId: "restricted-xai-session",
    updatedAt: 1,
    providerOverride: "xai",
    modelOverride: "auto",
    authProfileOverride: "xai:fixture",
    authProfileOverrideSource: "user",
  };
  const resolve = createRetiredModelRefRepairResolver({
    cfg,
    env: state.env,
    warnings,
    checkModelPolicy: true,
  });
  expect(repairRetiredSessionModelRef(entry, "main", resolve, "xai/grok-4.6", warnings)).toBe(
    false,
  );
  expect(entry.modelOverride).toBe("auto");
  expect(entry.authProfileOverride).toBe("xai:fixture");
  expect(warnings).toEqual([expect.stringContaining("not permitted")]);
});
