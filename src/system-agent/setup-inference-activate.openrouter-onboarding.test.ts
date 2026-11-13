import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as cliCredentials from "../agents/cli-credentials.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import { detectInferenceBackends } from "../commands/onboard-inference.js";
import { readConfigFileSnapshot } from "../config/config.js";
import * as configIO from "../config/config.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import * as probes from "./probes.js";
import { activateSetupInference } from "./setup-inference-activate.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

// mock-isolation: Setup probes replace model I/O without loading the embedded runtime.
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: vi.fn() }));

let temp: TempHomeEnv;
let configPath: string;

const nativeReadSnapshot = readConfigFileSnapshot;
const readSnapshot = () => nativeReadSnapshot({ observe: false, pluginValidation: "core-only" });

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

it.each([
  ["openrouter/auto", "openrouter/auto", undefined],
  ["openrouter/auto@openrouter:default", "openrouter/auto", undefined],
  ["openrouter/openrouter/fusion", "openrouter/openrouter/fusion", undefined],
  ["OpenRouter", "openrouter/auto", { "openrouter/auto": { alias: "OpenRouter" } }],
  ["openrouter/Fast", "openrouter/auto", { "openrouter/auto": { alias: "Fast" } }],
] as const)(
  "activates the discovered Current model for %s without a changed-model rejection",
  async (primary, expected, models) => {
    // Discovery and activation must agree, including literal catalog namespaces.
    const config = {
      agents: {
        defaults: { model: { primary }, ...(models ? { models } : {}) },
        entries: { main: {} },
      },
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
      runtime: createSystemAgentTestRuntime().runtime,
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
