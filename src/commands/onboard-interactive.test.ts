// Interactive onboarding tests cover wizard cancellation, setup routing, and runtime output.
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import * as configModule from "../config/config.js";
import { createConfigFileSnapshot } from "../config/io.snapshot-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  getActivePluginRegistry,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import type { BoundVerifySetupInferenceResult } from "../system-agent/setup-inference.js";
import {
  createSystemAgentVerifiedInferenceTestFixture,
  createSystemAgentPluginMetadataTestSnapshot,
} from "../system-agent/system-agent.test-helpers.js";
import { resolveSystemAgentVerifiedInferenceRoute } from "../system-agent/verified-inference.js";
import { createTempHomeEnv } from "../test-utils/temp-home.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import {
  runConversationalOnboarding as runConversationalOnboardingImpl,
  runInteractiveSetup,
} from "./onboard-interactive.js";
import { runSystemAgentWithInference as runSystemAgentWithInferenceImpl } from "./system-agent-with-inference.js";
import { createTestRuntime as makeRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  createClackPrompter: vi.fn(() => ({ id: "prompter" })),
  runSetupWizard: vi.fn(async () => {}),
  restoreTerminalState: vi.fn(),
  verifySetupInference: vi.fn<() => Promise<BoundVerifySetupInferenceResult>>(),
  loadAgentRuntimePluginRegistryHandle:
    vi.fn<typeof import("../agents/runtime-plugins.js").loadAgentRuntimePluginRegistryHandle>(),
  runSystemAgent: vi.fn<typeof import("../system-agent/system-agent.js").runSystemAgent>(),
  readConfigFileSnapshot: vi.fn<typeof import("../config/config.js").readConfigFileSnapshot>(),
}));

vi.mock("../cli/terminal-interactivity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/terminal-interactivity.js")>()),
  isTerminalInteractive: () => true,
}));
vi.mock("../system-agent/setup-inference.js", () => ({
  verifySetupInference: mocks.verifySetupInference,
  completeSetupInference: vi.fn(),
}));
vi.mock("../agents/runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: mocks.loadAgentRuntimePluginRegistryHandle,
}));
vi.mock("../system-agent/system-agent.js", () => ({ runSystemAgent: mocks.runSystemAgent }));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("../wizard/setup.js", () => ({
  runSetupWizard: mocks.runSetupWizard,
}));

vi.mock("../../packages/terminal-core/src/restore.js", () => ({
  restoreTerminalState: mocks.restoreTerminalState,
}));

describe("runConversationalOnboarding", () => {
  let home: Awaited<ReturnType<typeof createTempHomeEnv>>;
  let metadata: ReturnType<typeof createSystemAgentPluginMetadataTestSnapshot> | undefined;
  const runConversationalOnboarding: typeof runConversationalOnboardingImpl = (...args) =>
    metadata!.run(() => runConversationalOnboardingImpl(...args));
  const runSystemAgentWithInference: typeof runSystemAgentWithInferenceImpl = (...args) =>
    metadata!.run(() => runSystemAgentWithInferenceImpl(...args));
  let previousRegistry: ReturnType<typeof captureActivePluginRegistrySnapshot>;
  let rootRegistry: ReturnType<typeof createEmptyPluginRegistry>;
  let terminal: PassThrough & { isTTY: boolean };

  beforeEach(async () => {
    vi.clearAllMocks();
    home = await createTempHomeEnv("openclaw-conversational-handoff-");
    previousRegistry = captureActivePluginRegistrySnapshot();
    rootRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(rootRegistry);
    terminal = Object.assign(new PassThrough(), { isTTY: true });
  });

  afterEach(async () => {
    terminal.destroy();

    metadata = undefined;
    restoreActivePluginRegistrySnapshot(previousRegistry);
    vi.restoreAllMocks();
    await home.restore();
  });

  async function prepareConversation() {
    let config: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: path.join(home.home, "workspace"),
          model: "openai/gpt-5.6-sol",
          models: {
            "openai/gpt-5.6-sol": {
              agentRuntime: { id: "codex" },
            },
            "fixture/model": { agentRuntime: { id: "fixture-runtime" } },
          },
        },
        entries: { main: {} },
      },
      plugins: { entries: { codex: { enabled: true }, "fixture-runtime": { enabled: true } } },
    };
    metadata = createSystemAgentPluginMetadataTestSnapshot(config);
    const fixture = await metadata.run(() => createSystemAgentVerifiedInferenceTestFixture(config));
    // The handoff must use the actual registered harness and artifact validator.
    fixture.harnessMock.mockRestore();
    mocks.readConfigFileSnapshot.mockImplementation(async () =>
      createConfigFileSnapshot({
        path: path.join(home.home, "openclaw.json"),
        exists: true,
        valid: true,
        raw: null,
        parsed: config,
        sourceConfig: config,
        runtimeConfig: config,
        issues: [],
        warnings: [],
        legacyIssues: [],
      }),
    );
    const fingerprintPluginRuntimeArtifact = fixture.fingerprintPluginRuntimeArtifact;
    vi.spyOn(configModule, "readConfigFileSnapshot").mockImplementation(
      mocks.readConfigFileSnapshot,
    );
    let artifactCurrent = true;
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: "codex",
      source: "fixture",
      harness: {
        id: "codex",
        label: "Fixture harness",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("No model turn expected in the handoff test.");
        },
        runtimeArtifact: {
          validate: async (artifact) =>
            artifactCurrent &&
            artifact.id === fixture.binding.auth.runtimeArtifactId &&
            artifact.fingerprint === fixture.binding.auth.runtimeArtifactFingerprint,
        },
      },
    });
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
    mocks.verifySetupInference.mockResolvedValue({
      ok: true,
      modelRef: fixture.binding.execution.modelLabel,
      latencyMs: 1,
      binding: fixture.binding,
    });
    const launchConversation = vi.fn(async () => {});
    vi.spyOn(
      await import("../system-agent/tui-backend.js"),
      "runSystemAgentTui",
    ).mockImplementation(launchConversation);
    const { runSystemAgent } = await vi.importActual<
      typeof import("../system-agent/system-agent.js")
    >("../system-agent/system-agent.js");
    mocks.runSystemAgent.mockImplementation((opts, runtime) =>
      runSystemAgent({ ...opts, input: terminal, output: terminal }, runtime),
    );
    return {
      binding: fixture.binding,
      registry,
      launchConversation,
      currentConfig: () => config,
      resolveCurrentRoute: () => resolveSystemAgentVerifiedInferenceRoute(fixture.binding),
      invalidate: (
        kind:
          | "configured route"
          | "runtime artifact"
          | "plugin disable"
          | "plugin upgrade"
          | "unrelated plugin disable",
      ) => {
        if (kind === "runtime artifact") {
          artifactCurrent = false;
        } else if (kind === "plugin upgrade") {
          fingerprintPluginRuntimeArtifact.mockReturnValue("replaced-plugin-artifact");
        } else if (kind === "plugin disable" || kind === "unrelated plugin disable") {
          const pluginId = kind === "plugin disable" ? "codex" : "fixture-runtime";
          config = {
            ...config,
            plugins: { entries: { ...config.plugins?.entries, [pluginId]: { enabled: false } } },
          };
        } else {
          config = {
            ...config,
            agents: {
              ...config.agents,
              defaults: { ...config.agents?.defaults, model: "openai/gpt-5.6-luna" },
            },
          };
        }
      },
    };
  }

  it("acquires a cold verified harness from verified setup without replacing the root registry", async () => {
    const { currentConfig, launchConversation } = await prepareConversation();
    expect(getRegisteredAgentHarness("codex")).toBeUndefined();
    launchConversation.mockImplementation(async () => {
      expect(getRegisteredAgentHarness("codex")).toBeDefined();
      expect(getActivePluginRegistry()).toBe(rootRegistry);
    });

    await runSystemAgentWithInference({ input: terminal, output: terminal }, makeRuntime());

    expect(launchConversation).toHaveBeenCalledOnce();
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledWith({
      basePluginIds: [],
      config: currentConfig(),
      workspaceDir: path.join(home.home, "workspace"),
      selections: [
        { provider: "openai", modelId: "gpt-5.6-sol", runtime: "codex", agentId: "main" },
      ],
    });
    expect(getRegisteredAgentHarness("codex")).toBeUndefined();
    expect(getActivePluginRegistry()).toBe(rootRegistry);
  });

  it("loads current policy after an unrelated configured runtime is revoked", async () => {
    const { currentConfig, invalidate, launchConversation } = await prepareConversation();
    invalidate("unrelated plugin disable");

    await runConversationalOnboarding({}, makeRuntime());

    expect(launchConversation).toHaveBeenCalledOnce();
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledWith(
      expect.objectContaining({ config: currentConfig() }),
    );
    expect(getActivePluginRegistry()).toBe(rootRegistry);
  });

  it.each(["plugin disable", "plugin upgrade", "missing harness"] as const)(
    "rejects %s before starting the verified conversation",
    async (kind) => {
      const { invalidate, launchConversation, registry } = await prepareConversation();
      if (kind === "missing harness") {
        rootRegistry.agentHarnesses.push(...registry.agentHarnesses);
        mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValueOnce(createEmptyPluginRegistry());
      } else {
        invalidate(kind);
      }

      await expect(runConversationalOnboarding({}, makeRuntime())).rejects.toMatchObject({
        code: "SYSTEM_AGENT_INFERENCE_UNAVAILABLE",
      });

      expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(
        kind === "missing harness" ? 1 : 0,
      );
      expect(launchConversation).not.toHaveBeenCalled();
      expect(getActivePluginRegistry()).toBe(rootRegistry);
    },
  );

  it.each(["configured route", "runtime artifact"] as const)(
    "keeps %s revalidation live inside the conversation scope",
    async (kind) => {
      const { invalidate, launchConversation, resolveCurrentRoute } = await prepareConversation();
      launchConversation.mockImplementation(async () => {
        expect(await resolveCurrentRoute()).not.toBeNull();
        invalidate(kind);
        expect(await resolveCurrentRoute()).toBeNull();
      });

      await runConversationalOnboarding({}, makeRuntime());

      expect(launchConversation).toHaveBeenCalledOnce();
      expect(getRegisteredAgentHarness("codex")).toBeUndefined();
      expect(getActivePluginRegistry()).toBe(rootRegistry);
    },
  );
});

describe("runInteractiveSetup", () => {
  afterEach(() => {
    expect(mocks.restoreTerminalState).toHaveBeenCalledWith("setup finish", {
      resumeStdinIfPaused: false,
    });
    vi.clearAllMocks();
  });

  it.each([undefined, new WizardCancelledError("cancelled"), new Error("boom")])(
    "restores terminal state without resuming stdin (wizard result: %s)",
    async (error) => {
      const runtime = makeRuntime();
      const cancelled = error instanceof WizardCancelledError;
      const exitError = new Error("exit");
      if (cancelled) {
        runtime.exit.mockImplementation(() => {
          throw exitError;
        });
      }
      if (error) {
        mocks.runSetupWizard.mockRejectedValueOnce(error);
        await expect(runInteractiveSetup({}, runtime)).rejects.toBe(cancelled ? exitError : error);
      } else {
        await runInteractiveSetup({}, runtime);
      }
      expect(mocks.runSetupWizard).toHaveBeenCalledOnce();
      if (cancelled) {
        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(mocks.restoreTerminalState).toHaveBeenCalledBefore(runtime.exit);
      } else {
        expect(runtime.exit).not.toHaveBeenCalled();
      }
    },
  );
});
