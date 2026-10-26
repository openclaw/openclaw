import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import * as embeddedAgent from "../agents/embedded-agent.js";
import { runSystemAgentWithInference } from "../commands/system-agent-with-inference.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as loggingConfig from "../logging/config.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { RuntimeEnv } from "../runtime.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { verifySetupInferenceConfig } from "./setup-inference-turn.js";
import {
  createSystemAgentPluginMetadataTestSnapshot,
  createSystemAgentVerifiedInferenceTestFixture,
} from "./system-agent.test-helpers.js";
import * as verifiedInference from "./verified-inference.js";

// mock-isolation: Setup probes replace model I/O without loading the embedded runtime.
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: vi.fn() }));

const { verifySetupInference, runSystemAgent, runGuidedOnboarding } = vi.hoisted(() => ({
  verifySetupInference: vi.fn(),
  runSystemAgent: vi.fn(),
  runGuidedOnboarding: vi.fn(),
}));
// mock-isolation: Route verification through the controlled probe fixture, not operator config.
vi.mock("./setup-inference.js", () => ({ verifySetupInference }));
// mock-isolation: Observe execution admission without starting a real system-agent session.
vi.mock("./system-agent.js", () => ({ runSystemAgent }));
// mock-isolation: Error reporting must not launch interactive onboarding.
vi.mock("../commands/onboard-guided.js", () => ({ runGuidedOnboarding }));

const runtimeLoader = vi.hoisted(() => vi.fn());
vi.mock("../agents/runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: runtimeLoader,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  runtimeLoader.mockReset();
});

type FailurePhase = "capture" | "revalidate" | "callback";
const syntheticToken = "sk-140392syntheticfixturetoken123456789";
const syntheticStructuredValue = "140392-structured-placeholder";
const syntheticCustomValue = "PR140392_PRIVATE_SAMPLE";

async function observeScenario(scenario: FailurePhase, json: boolean) {
  await withTestDir({ prefix: "openclaw-error-reporting-140392-" }, async (root) => {
    const phases: string[] = [];
    const tempDirs: string[] = [];
    const marker = `dependency-${scenario}-reason-140392`;
    const cause = `${marker}; OPENAI_API_KEY=${syntheticToken}; {"access_token":"${syntheticStructuredValue}"}; ${syntheticCustomValue}`;
    const enter = (phase: FailurePhase) => {
      phases.push(phase === "revalidate" ? "runtime-load" : phase);
      if (scenario === phase) {
        // oxlint-disable-next-line typescript/only-throw-error -- Exercise non-Error failures at the verifier boundary.
        throw json ? new Error(cause) : cause;
      }
    };
    const output = {
      log: vi.fn<RuntimeEnv["log"]>(),
      error: vi.fn<RuntimeEnv["error"]>(),
      exit: vi.fn<RuntimeEnv["exit"]>(),
    };
    const policy = { redactSensitive: "off", redactPatterns: ["PR140392_PRIVATE_[A-Z]+"] };
    vi.spyOn(loggingConfig, "readLoggingConfig").mockReturnValue(policy);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "missing-config.json"));
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { main: { workspace: root, agentDir: path.join(root, "main-agent") } },
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
        return {
          meta: {
            durationMs: 0,
            finalAssistantVisibleText: "OK",
            executionTrace: { winnerProvider: "openai", winnerModel: "gpt-5.5" },
          },
        };
      });
      const capture = verifiedInference.captureSystemAgentOwnerPluginArtifacts;
      vi.spyOn(verifiedInference, "captureSystemAgentOwnerPluginArtifacts").mockImplementation(
        (input) => {
          enter("capture");
          return capture(input);
        },
      );
      verifySetupInference.mockImplementation(({ runtime }: { runtime: RuntimeEnv }) =>
        verifySetupInferenceConfig({
          config,
          agentId: "main",
          runtime,
          requireExecutionOwner: true,
          onVerifiedExecution: () => enter("callback"),
        }),
      );
      runSystemAgent.mockReset().mockResolvedValue(undefined);
      runGuidedOnboarding.mockReset().mockResolvedValue(undefined);
      await runSystemAgentWithInference(
        json ? { json: true } : { message: "status", interactive: false },
        output,
      );
    });
    const lines = (mock: typeof output.log) =>
      mock.mock.calls.map((args) => args.map(String).join(" "));
    expect(runGuidedOnboarding).not.toHaveBeenCalled();
    expect(tempDirs).toHaveLength(scenario === "capture" ? 0 : 1);
    for (const dir of tempDirs) {
      await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(runSystemAgent).not.toHaveBeenCalled();
    expect(output.exit.mock.calls).toEqual([[1]]);
    const phaseCount = scenario === "capture" ? 1 : scenario === "callback" ? 4 : 3;
    expect(phases).toEqual(["capture", "probe", "runtime-load", "callback"].slice(0, phaseCount));
    expect(lines(json ? output.error : output.log)).toEqual([]);
    const messages = lines(json ? output.log : output.error);
    expect(messages).toHaveLength(1);
    const text = expectDefined(messages[0], "error output");
    let message: string;
    if (json) {
      const payload = JSON.parse(text);
      expect(payload).toMatchObject({
        ok: false,
        status: scenario === "capture" ? "unavailable" : "auth",
      });
      expect(payload).not.toHaveProperty("binding");
      message = payload.error;
    } else {
      message = text;
    }
    expect(message.startsWith("OpenClaw requires working inference: ")).toBe(true);
    for (const secret of [syntheticToken, syntheticStructuredValue, syntheticCustomValue]) {
      expect(message).not.toContain(secret);
    }
    expect(message, "PR140392_CAUSE_LOST").toContain(marker);
    expect(message.split(marker)).toHaveLength(2);
    for (const redaction of ["OPENAI_API_KEY=", "access_token", "***"]) {
      expect(message).toContain(redaction);
    }
  });
}

it.each([
  ["capture", true],
  ["capture", false],
  ["revalidate", true],
  ["revalidate", false],
  ["callback", true],
  ["callback", false],
] as const)("preserves %s cause in JSON=%s", observeScenario);
