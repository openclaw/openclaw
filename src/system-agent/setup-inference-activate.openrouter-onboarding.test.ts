import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as embeddedAgent from "../agents/embedded-agent.js";
import { detectInferenceBackends } from "../commands/onboard-inference.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import { activateSetupInference } from "./setup-inference-activate.js";

// mock-isolation: Setup probes replace model I/O without loading the embedded runtime.
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: vi.fn() }));

// Mirrors OPENROUTER_DEFAULT_MODEL_REF from extensions/openrouter/onboard.ts.
// Kept as a literal so this core test does not pull a bundled extension into
// the core tsgo graph; the OpenRouter onboard suite guards the real constant.
const OPENROUTER_DEFAULT_MODEL_REF = "openrouter/auto";

let temp: TempHomeEnv;
let configPath: string;

const readSnapshot = () =>
  readConfigFileSnapshot({ observe: false, pluginValidation: "core-only" });

async function routeFor(primary: string, provider: string): Promise<string> {
  const config = {
    agents: { defaults: { model: { primary } } },
    models: { providers: { [provider]: { apiKey: `synthetic-${provider}-key` } } },
  };
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await temp?.restore();
});

it("resolves the OpenRouter default route label to the staged candidate ref", async () => {
  // The route label must equal the staged default ref so the activation guard
  // (route.modelLabel === staged.modelRef) accepts the saved OpenRouter key.
  // Before the fix this was "openrouter/openrouter/auto".
  const label = await routeFor(OPENROUTER_DEFAULT_MODEL_REF, "openrouter");
  expect(label).toBe("openrouter/auto");
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
  };
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
  };
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

it.each([
  {
    name: "a saved openrouter/auto primary",
    primary: "openrouter/auto",
    expected: "openrouter/auto",
  },
  {
    name: "a saved primary with its auth-profile suffix",
    primary: "openrouter/auto@openrouter:default",
    expected: "openrouter/auto",
  },
  {
    name: "a literal Fusion catalog namespace",
    primary: "openrouter/openrouter/fusion",
    expected: "openrouter/openrouter/fusion",
  },
])(
  "activates the discovered Current model for $name without a changed-model rejection",
  async ({ primary, expected }) => {
    // Discovery and activation must agree on the saved model's identity:
    // Model Setup advertises the discovered "Current model" ref, and the
    // existing-model activation compares it with the configured route label
    // before verifying inference. A mismatch is rejected as "The configured
    // default model changed" before any model turn runs.
    const config = {
      agents: { defaults: { model: { primary } }, entries: { main: {} } },
      models: { providers: { openrouter: { apiKey: "synthetic-openrouter-key" } } },
    };
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
        hasCodexCliAuthFile: () => false,
      },
    });
    const discovered = candidates.find((candidate) => candidate.kind === "existing-model");
    expect(discovered?.modelRef).toBe(expected);
    const route = await resolveSystemAgentConfiguredRouteFromConfig(
      snapshot.runtimeConfig,
      undefined,
      {},
      snapshot,
    );
    expect(route?.modelLabel).toBe(discovered?.modelRef);

    const runEmbeddedAgent = vi.fn<typeof embeddedAgent.runEmbeddedAgent>(async () => ({
      meta: {
        durationMs: 1,
        finalAssistantVisibleText: "OK",
        executionTrace: { winnerProvider: "openrouter", winnerModel: expected },
      },
    }));
    vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(runEmbeddedAgent);
    const result = await activateSetupInference({
      kind: "existing-model",
      modelRef: discovered?.modelRef,
      surface: "gateway",
      runtime: {
        log() {},
        error() {},
        exit() {
          throw new Error("Unexpected exit");
        },
      },
      deps: {
        readConfigFileSnapshot: readSnapshot,
      },
    });
    if (!result.ok) {
      expect(result.error).not.toContain("configured default model changed");
    }
    if (primary.includes("@")) {
      // The identity check passed; this fixture stores no credential for the
      // named saved sign-in, so activation stops at the credential lookup.
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.error).toContain("No credentials found");
    } else {
      // The discovered candidate passed the identity check and reached live
      // inference verification.
      expect(runEmbeddedAgent).toHaveBeenCalled();
    }
  },
);
