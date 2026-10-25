import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as cliCredentials from "../agents/cli-credentials.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import { detectInferenceBackends } from "../commands/onboard-inference.js";
import { readConfigFileSnapshot } from "../config/config.js";
import * as configIO from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import * as probes from "./probes.js";
import { activateSetupInference } from "./setup-inference-activate.js";

// mock-isolation: Setup probes replace model I/O without loading the embedded runtime.
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: vi.fn() }));

let temp: TempHomeEnv;
let configPath: string;

const nativeReadSnapshot = readConfigFileSnapshot;
const readSnapshot = () => nativeReadSnapshot({ observe: false, pluginValidation: "core-only" });

async function routeFor(
  primary: string,
  provider: string,
  models?: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"],
) {
  const config = {
    agents: { defaults: { model: { primary }, ...(models ? { models } : {}) } },
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

// Preserve raw catalog namespaces, but resolve bare and qualified aliases.
it.each([
  ["openrouter/moonshotai/kimi-k2.6", "openrouter", "openrouter/moonshotai/kimi-k2.6", undefined],
  ["anthropic/claude-sonnet-4-6", "anthropic", "anthropic/claude-sonnet-4-6", undefined],
  ["OpenRouter", "openrouter", "openrouter/auto", { "openrouter/auto": { alias: "OpenRouter" } }],
  ["openai/Fast", "openai", "openai/gpt-5.4-mini", { "openai/gpt-5.4-mini": { alias: "Fast" } }],
] as const)(
  "resolves %s to its canonical route label",
  async (primary, provider, expected, models) => {
    expect(await routeFor(primary, provider, models)).toBe(expected);
  },
);

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
    // Discovery and activation must agree, including literal catalog namespaces.
    const config = {
      agents: { defaults: { model: { primary } }, entries: { main: {} } },
      models: { providers: { openrouter: { apiKey: "synthetic-openrouter-key" } } },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    const snapshot = await readSnapshot();
    expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);

    vi.spyOn(probes, "probeLocalCommand").mockImplementation(async (command) => ({
      found: false,
      command,
    }));
    vi.spyOn(cliCredentials, "hasCodexCliAuthFile").mockReturnValue(false);
    const candidates = await detectInferenceBackends({
      config: snapshot.runtimeConfig,
      agentId: "main",
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
    expect(route?.modelLabel).toBe(expected);

    const runEmbeddedAgent = vi.fn<typeof embeddedAgent.runEmbeddedAgent>(async () => ({
      meta: {
        durationMs: 1,
        finalAssistantVisibleText: "OK",
        executionTrace: { winnerProvider: "openrouter", winnerModel: expected },
      },
    }));
    vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(runEmbeddedAgent);
    vi.spyOn(configIO, "readConfigFileSnapshot").mockImplementation(readSnapshot);
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
