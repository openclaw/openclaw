// Regression coverage for OpenRouter onboarding route matching.
//
// The onboarding "API Keys -> OpenRouter API key" flow has no model picker, so
// it stages the provider default `openrouter/auto`. The default route resolves
// that stored ref to the canonical ModelRef { provider: "openrouter", model:
// "openrouter/auto" } — the model id itself carries the provider prefix.
//
// `resolveSystemAgentConfiguredRouteFromConfig` previously built `modelLabel`
// by raw concatenation (`${provider}/${modelId}`), yielding the double-prefixed
// `openrouter/openrouter/auto`. The staged candidate ref and the config primary
// (written via the canonical `modelKey`/`upsertCanonicalModelConfigEntry`) stay
// `openrouter/auto`, so `verifyAndActivateCandidate`'s
// `route.modelLabel !== staged.modelRef` guard rejected a valid credential with
// "The candidate route does not match the selected provider, model, and
// credential." Building `modelLabel` with the canonical `modelKey` fixes it.
//
// These tests pin the canonical label, confirm it round-trips for a plain
// (non-prefixed) provider so other providers do not regress, and confirm a
// genuinely different OpenRouter model still produces a distinct label.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { modelKey } from "../agents/model-selection.js";
import { detectInferenceBackends } from "../commands/onboard-inference.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";

// Mirrors OPENROUTER_DEFAULT_MODEL_REF from extensions/openrouter/onboard.ts.
// Kept as a literal so this core test does not pull a bundled extension into
// the core tsgo graph; the OpenRouter onboard suite guards the real constant.
const OPENROUTER_DEFAULT_MODEL_REF = "openrouter/auto";

let temp: TempHomeEnv;
let configPath: string;

const readSnapshot = () =>
  readConfigFileSnapshot({ observe: false, pluginValidation: "core-only" });

async function routeFor(primary: string, provider: string): Promise<string> {
  // Source config uses the input provider shape (apiKey only); the writer and
  // schema accept it. Cast past the materialized provider type for this literal.
  const config = {
    agents: { defaults: { model: { primary } } },
    models: { providers: { [provider]: { apiKey: `synthetic-${provider}-key` } } },
  } as OpenClawConfig;
  await fs.writeFile(configPath, JSON.stringify(config));
  const snapshot = await readSnapshot();
  expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
  const route = await resolveSystemAgentConfiguredRouteFromConfig(
    snapshot.runtimeConfig,
    undefined,
    {},
    snapshot,
  );
  expect(route).not.toBeNull();
  return route!.modelLabel;
}

beforeEach(async () => {
  temp = await createTempHomeEnv("openclaw-openrouter-onboarding-");
  configPath = path.join(temp.home, ".openclaw", "openclaw.json");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await temp?.restore();
});

it("resolves the OpenRouter default route label to the staged candidate ref", async () => {
  // The route label must equal the staged default ref so the activation guard
  // (route.modelLabel === staged.modelRef) accepts the saved OpenRouter key.
  // Before the fix this was "openrouter/openrouter/auto".
  const label = await routeFor(OPENROUTER_DEFAULT_MODEL_REF, "openrouter");
  expect(label).toBe("openrouter/auto");
  expect(label).toBe(OPENROUTER_DEFAULT_MODEL_REF);
  // The label is exactly the canonical key the config write path uses.
  expect(label).toBe(modelKey("openrouter", "openrouter/auto"));
});

it("keeps a distinct label for a non-default OpenRouter model", async () => {
  // The fix only collapses the duplicated self-prefix; a different model still
  // yields a different label, so the guard cannot be satisfied by the default.
  const label = await routeFor("openrouter/moonshotai/kimi-k2.6", "openrouter");
  expect(label).toBe("openrouter/moonshotai/kimi-k2.6");
  expect(label).not.toBe("openrouter/auto");
});

it("preserves a literal OpenRouter catalog namespace (Fusion)", async () => {
  // `openrouter/openrouter/fusion` is a documented OpenRouter selection whose
  // upstream model id is `openrouter/fusion`. The completion resolver strips the
  // self-provider prefix, so rebuilding the label from the resolved selection
  // would drop the literal namespace and reject the selection during activation.
  // The route label must stay `openrouter/openrouter/fusion` to match the
  // config-written primary and the staged candidate ref.
  const label = await routeFor("openrouter/openrouter/fusion", "openrouter");
  expect(label).toBe("openrouter/openrouter/fusion");
});

it("does not change labels for a non-prefixing provider", async () => {
  // Anthropic model ids are not provider-prefixed, so modelKey is a no-op here;
  // this confirms the change is scoped to self-prefixed ids and other providers
  // are unaffected.
  const label = await routeFor("anthropic/claude-sonnet-4-6", "anthropic");
  expect(label).toBe("anthropic/claude-sonnet-4-6");
});

it("resolves a bare alias primary to the canonical model label", async () => {
  // A bare alias primary (`OpenRouter`) is not a qualified provider/model ref,
  // so the label must come from the resolved selection, not the raw alias text.
  const config = {
    agents: {
      defaults: {
        model: { primary: "OpenRouter" },
        models: { "openrouter/auto": { alias: "OpenRouter" } },
      },
    },
    models: { providers: { openrouter: { apiKey: "synthetic-openrouter-key" } } },
  } as unknown as OpenClawConfig;
  await fs.writeFile(configPath, JSON.stringify(config));
  const snapshot = await readSnapshot();
  expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
  const route = await resolveSystemAgentConfiguredRouteFromConfig(
    snapshot.runtimeConfig,
    undefined,
    {},
    snapshot,
  );
  expect(route?.modelLabel).toBe("openrouter/auto");
});

it("resolves a provider-qualified alias before forming the route label", async () => {
  const config = {
    agents: {
      defaults: {
        model: { primary: "openai/Fast" },
        models: { "openai/gpt-5.4-mini": { alias: "Fast" } },
      },
    },
    models: { providers: { openai: { apiKey: "synthetic-openai-key" } } },
  } as unknown as OpenClawConfig;
  await fs.writeFile(configPath, JSON.stringify(config));
  const snapshot = await readSnapshot();
  expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
  const route = await resolveSystemAgentConfiguredRouteFromConfig(
    snapshot.runtimeConfig,
    undefined,
    {},
    snapshot,
  );
  expect(route?.modelLabel).toBe("openai/gpt-5.4-mini");
});

it("discovers the same Fusion identity that activation resolves", async () => {
  // End-to-end guard for the previously reported Fusion discovery regression:
  // the "Current model" candidate advertised by setup discovery must equal the
  // configured-route label that activation compares against. Before the fix,
  // discovery advertised `openrouter/fusion` while activation retained
  // `openrouter/openrouter/fusion`, so selecting Current model failed with
  // "The configured default model changed from openrouter/fusion to
  // openrouter/openrouter/fusion".
  const config = {
    agents: {
      defaults: { model: { primary: "openrouter/openrouter/fusion" } },
      entries: { main: {} },
    },
    models: { providers: { openrouter: { apiKey: "synthetic-openrouter-key" } } },
  } as unknown as OpenClawConfig;
  await fs.writeFile(configPath, JSON.stringify(config));
  const snapshot = await readSnapshot();
  expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);

  const candidates = await detectInferenceBackends({
    config: snapshot.runtimeConfig,
    agentId: "main",
    env: {},
    platform: "linux",
    deps: {
      probeLocalCommand: async (command) => ({ found: false, command }),
      readCodexCliCredentials: () => null,
    },
  });
  const discovered = candidates.find((candidate) => candidate.kind === "existing-model");
  expect(discovered?.modelRef).toBe("openrouter/openrouter/fusion");

  const route = await resolveSystemAgentConfiguredRouteFromConfig(
    snapshot.runtimeConfig,
    undefined,
    {},
    snapshot,
  );
  expect(route?.modelLabel).toBe(discovered?.modelRef);
});
