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
  createRetiredModelRefRepairResolver as createResolver,
  repairRetiredConfigModelRefs as repairConfig,
} from "./retired-model-ref-repair.js";
import { repairRetiredSessionModelRef as repairSession } from "./retired-session-model-repair.js";

let state: OpenClawTestState;
let cfg: OpenClawConfig;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "xai-auto-retirement" });
  clearPluginMetadataLifecycleCaches();
  await state.writeAuthProfiles({
    version: 1,
    profiles: {
      "xai:fixture": { type: "token", provider: "xai", token: "synthetic-subscription-token" },
    },
  });
  cfg = configForRoute("https://cli-chat-proxy.grok.com/v1");
  await state.writeConfig(cfg);
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

function resolver(options: Omit<Parameters<typeof createResolver>[0], "cfg" | "env"> = {}) {
  return createResolver({ cfg, env: state.env, ...options });
}

function session(sessionId: string): SessionEntry {
  return {
    sessionId,
    updatedAt: 1,
    providerOverride: "xai",
    modelOverride: "auto",
    authProfileOverride: "xai:fixture",
    authProfileOverrideSource: "user",
  };
}

it("repairs the subscription selector while preserving fallbacks and model settings", () => {
  const repaired = repairConfig(cfg, resolver());
  expect(repaired.config.agents?.defaults?.model).toEqual({
    primary: "xai/grok-4.7",
    fallbacks: ["xai/grok-4.3"],
  });
  const defaults = repaired.config.agents?.defaults;
  expect(defaults?.models?.["xai/grok-4.7"]?.params).toEqual({ temperature: 0.25 });
  expect(cfg.agents?.defaults?.model).toEqual({ primary: "xai/auto", fallbacks: ["xai/grok-4.3"] });
  const nextResolver = createResolver({ cfg: repaired.config, env: state.env });
  expect(repairConfig(repaired.config, nextResolver).changes).toEqual([]);
});

it("repairs a session override without changing its selected profile", () => {
  const entry = session("xai-upgrade-session");
  expect(repairSession(entry, "main", resolver(), "xai/grok-4.7", [])).toBe(true);
  expect(entry).toMatchObject({
    modelOverride: "grok-4.7",
    authProfileOverride: "xai:fixture",
    authProfileOverrideSource: "user",
  });
});

it("preserves a custom endpoint's explicit auto model", async () => {
  cfg = configForRoute("https://custom-models.example/v1", [
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
  const resolve = resolver();
  expect(resolve({ modelRef: "xai/auto", agentId: "main" })).toEqual({ kind: "unchanged" });
  expect(repairConfig(cfg, resolve).config).toBe(cfg);
});

it("repairs an unpinned config for its declared owner without credentials", async () => {
  await state.writeAuthProfiles({ version: 1, profiles: {} });
  const warnings: string[] = [];
  const resolve = resolver({ warnings });
  expect(resolve({ modelRef: "xai/auto", agentId: "main" })).toEqual({
    kind: "replace",
    modelRef: "xai/grok-4.7",
    reason: "retirement",
    retirementScope: "owner",
  });
  expect(warnings).toEqual([]);
});

it("retains a missing pinned account instead of substituting the available profile", () => {
  const warnings: string[] = [];
  const resolve = resolver({ warnings });
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
  cfg.agents!.defaults!.modelPolicy = { allow: ["xai/auto"] };
  await state.writeConfig(cfg);
  const warnings: string[] = [];
  const entry = session("restricted-xai-session");
  const resolve = resolver({ warnings, checkModelPolicy: true });
  expect(repairSession(entry, "main", resolve, "xai/grok-4.7", warnings)).toBe(false);
  expect(entry).toMatchObject({ modelOverride: "auto", authProfileOverride: "xai:fixture" });
  expect(warnings).toEqual([expect.stringContaining("not permitted")]);
});
