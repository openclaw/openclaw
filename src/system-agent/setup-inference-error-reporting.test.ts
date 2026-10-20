import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as embeddedAgent from "../agents/embedded-agent.js";
import { runSystemAgentWithInference } from "../commands/system-agent-with-inference.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as loggingConfig from "../logging/config.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { redactSetupInferenceError } from "./setup-inference-core.js";
import { verifySetupInferenceConfig } from "./setup-inference-turn.js";
import {
  createSystemAgentPluginMetadataTestSnapshot,
  createSystemAgentVerifiedInferenceTestFixture,
} from "./system-agent.test-helpers.js";
import * as verifiedInference from "./verified-inference.js";

// mock-isolation: Setup probes replace model I/O without loading the embedded runtime.
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: vi.fn() }));

const inferenceMocks = vi.hoisted(() => ({
  verifySetupInference: vi.fn(),
  runSystemAgent: vi.fn(),
  runGuidedOnboarding: vi.fn(),
}));
vi.mock("./setup-inference.js", () => ({
  verifySetupInference: inferenceMocks.verifySetupInference,
}));
vi.mock("./system-agent.js", () => ({
  runSystemAgent: inferenceMocks.runSystemAgent,
}));
vi.mock("../commands/onboard-guided.js", () => ({
  runGuidedOnboarding: inferenceMocks.runGuidedOnboarding,
}));

const runtimeLoader = vi.hoisted(() => vi.fn());
vi.mock("../agents/runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: runtimeLoader,
}));

afterEach(() => vi.restoreAllMocks());

type FailurePhase = "capture" | "revalidate" | "callback";
type Scenario = FailurePhase | "success" | "drift";
const syntheticToken = "sk-140392syntheticfixturetoken123456789";
const syntheticStructuredValue = "140392-structured-placeholder";
const syntheticCustomValue = "PR140392_PRIVATE_SAMPLE";
const guidance = "Run `openclaw onboard` to connect and live-test AI first.";

async function observeScenario(scenario: Scenario, json: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-error-reporting-140392-"));
  const phases: string[] = [];
  const tempDirs: string[] = [];
  const marker = `dependency-${scenario}-reason-140392`;
  const cause = `${marker}; OPENAI_API_KEY=${syntheticToken}; {"access_token":"${syntheticStructuredValue}"}; ${syntheticCustomValue}`;
  const fault = json ? new Error(cause) : cause;
  const enter = (phase: FailurePhase) => {
    phases.push(phase === "revalidate" ? "runtime-load" : phase);
    if (scenario === phase) {
      // oxlint-disable-next-line typescript/only-throw-error -- Exercise non-Error failures at the verifier boundary.
      throw fault;
    }
  };
  const output = {
    log: vi.fn<RuntimeEnv["log"]>(),
    error: vi.fn<RuntimeEnv["error"]>(),
    exit: vi.fn<RuntimeEnv["exit"]>(),
  };
  const policy = { redactSensitive: "off", redactPatterns: ["PR140392_PRIVATE_[A-Z]+"] };
  vi.spyOn(loggingConfig, "readLoggingConfig").mockReturnValue(policy);
  try {
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "missing-config.json"),
      },
      async () => {
        const config: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            entries: {
              main: { workspace: root, agentDir: path.join(root, "main-agent") },
            },
            defaults: {
              model: "openai/gpt-5.5@openai:proof",
              models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
            },
          },
          auth: { profiles: { "openai:proof": { provider: "openai", mode: "api_key" } } },
        };
        const metadata = createSystemAgentPluginMetadataTestSnapshot(config);
        await metadata.run(async () => {
          const fixture = await createSystemAgentVerifiedInferenceTestFixture(config);
          let changedArtifact = false;
          fixture.fingerprintPluginRuntimeArtifact.mockImplementation(
            (input) => `${input.pluginId}-test-runtime-v1${changedArtifact ? "-changed" : ""}`,
          );
          runtimeLoader.mockReset().mockImplementation(() => {
            enter("revalidate");
            return createEmptyPluginRegistry();
          });
          vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshotAsync").mockImplementation(
            async (params) => metadata.bind(params),
          );
          vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(async (params) => {
            tempDirs.push(params.workspaceDir);
            phases.push("probe");
            expect(params).toMatchObject({
              agentHarnessRuntimeOverride: "openclaw",
              authProfileId: "openai:proof",
            });
            params.onSuccessfulAuthBinding?.(fixture.binding.auth);
            if (scenario === "drift") {
              changedArtifact = true;
            }
            return {
              meta: {
                durationMs: 0,
                finalAssistantVisibleText: "OK",
                executionTrace: { winnerProvider: "openai", winnerModel: "gpt-5.5" },
              },
            };
          });
          const captureOwnerArtifacts = verifiedInference.captureSystemAgentOwnerPluginArtifacts;
          vi.spyOn(verifiedInference, "captureSystemAgentOwnerPluginArtifacts").mockImplementation(
            (input) => {
              enter("capture");
              return captureOwnerArtifacts(input);
            },
          );
          inferenceMocks.verifySetupInference.mockImplementation(
            async ({ runtime }: { runtime: RuntimeEnv }) => {
              let binding: typeof fixture.binding | undefined;
              const result = await verifySetupInferenceConfig({
                config,
                agentId: "main",
                runtime,
                requireExecutionOwner: true,
                onVerifiedExecution: (verified) => {
                  enter("callback");
                  binding = verified;
                },
              });
              if (!result.ok) {
                return result;
              }
              if (!binding) {
                throw new Error("successful verification lacked a binding");
              }
              return { ...result, binding };
            },
          );
          inferenceMocks.runSystemAgent.mockReset().mockResolvedValue(undefined);
          inferenceMocks.runGuidedOnboarding.mockReset().mockResolvedValue(undefined);
          await runSystemAgentWithInference(
            json ? { json: true } : { message: "status", interactive: false },
            output,
          );
        });
      },
    );
    const stdout = output.log.mock.calls.map((args) => args.map(String).join(" "));
    const stderr = output.error.mock.calls.map((args) => args.map(String).join(" "));
    expect(inferenceMocks.runGuidedOnboarding).not.toHaveBeenCalled();
    expect(tempDirs).toHaveLength(scenario === "capture" ? 0 : 1);
    for (const dir of tempDirs) {
      await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const success = scenario === "success";
    expect(inferenceMocks.runSystemAgent).toHaveBeenCalledTimes(success ? 1 : 0);
    expect(output.exit.mock.calls.map(([code]) => code)).toEqual(success ? [] : [1]);
    const phaseCount = scenario === "capture" ? 1 : success || scenario === "callback" ? 4 : 3;
    expect(phases).toEqual(["capture", "probe", "runtime-load", "callback"].slice(0, phaseCount));
    if (scenario === "success") {
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([]);
      return;
    }
    let message: string;
    if (json) {
      expect(stdout).toHaveLength(1);
      expect(stderr).toEqual([]);
      const payload = JSON.parse(expectDefined(stdout[0], "JSON output"));
      expect(payload).toMatchObject({
        ok: false,
        status: scenario === "capture" ? "unavailable" : "auth",
        guidance,
      });
      expect(payload).not.toHaveProperty("binding");
      message = payload.error;
    } else {
      expect(stdout).toEqual([]);
      expect(stderr).toHaveLength(1);
      const text = expectDefined(stderr[0], "text error");
      expect(text.endsWith(`\n${guidance}`)).toBe(true);
      message = text.slice(0, -guidance.length - 1);
    }
    expect(message.startsWith("OpenClaw requires working inference: ")).toBe(true);
    expect(message).not.toContain(syntheticToken);
    expect(message).not.toContain(syntheticStructuredValue);
    expect(message).not.toContain(syntheticCustomValue);
    if (scenario === "drift") {
      expect(message).toContain("verified inference owner changed");
      return;
    }
    if (scenario === "capture") {
      expect(message).toContain("Refresh or reinstall the plugin and retry.");
    }
    expect(message.includes(marker), "PR140392_CAUSE_LOST").toBe(true);
    expect(message.split(marker)).toHaveLength(2);
    expect(message).toContain("OPENAI_API_KEY=");
    expect(message).toContain("access_token");
    expect(message).toContain("***");
  } finally {
    runtimeLoader.mockReset();
    await fs.rm(root, { recursive: true, force: true });
    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
}

describe("setup inference failure reporting", () => {
  it.each([
    ["capture", true],
    ["capture", false],
    ["revalidate", true],
    ["revalidate", false],
    ["callback", true],
    ["callback", false],
  ] as const)("preserves %s cause in JSON=%s", observeScenario);

  it("preserves a successful synthetic verification", async () => {
    await observeScenario("success", true);
  });
  it("keeps a real synthetic artifact mismatch rejected", async () => {
    await observeScenario("drift", true);
  });
  it("fully masks explicitly supplied known values", async () => {
    const known = "opaque-140392-placeholder";
    expect(await redactSetupInferenceError(`before ${known} after`, known)).toBe(
      "before [redacted] after",
    );
  });
});
