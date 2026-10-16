import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { AgentHarness } from "../agents/harness/types.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { WizardSession } from "../wizard/session.js";
import type * as SetupShared from "../wizard/setup.shared.js";
import type * as SetupInferenceTurn from "./setup-inference-turn.js";
import { setupNativeRuntime } from "./setup-native-runtime.js";
import { createSystemAgentPluginMetadataTestSnapshot } from "./system-agent.test-helpers.js";

const io = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), load: vi.fn() }));
vi.mock("../wizard/setup.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SetupShared>()),
  readSetupConfigFileSnapshot: io.read,
  writeWizardConfigFile: io.write,
}));
vi.mock("./setup-inference-turn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SetupInferenceTurn>()),
  loadSetupInferencePluginGeneration: io.load,
}));

const configPatch: Record<string, unknown> = {
  plugins: { entries: { fixture: { config: { enabled: true } } } },
};

function fixture() {
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { main: {}, research: { model: "stable/model" } },
      defaults: { model: "stable/default" },
    },
    plugins: { entries: { fixture: { config: { enabled: false } } } },
  };
  const registry = createEmptyPluginRegistry();
  const harness: AgentHarness = {
    id: "fixture-runtime",
    label: "Fixture Native",
    executionEnvironment: "host-only",
    supports: () => ({ supported: true }),
    runAttempt: async () => {
      throw new Error("Runtime enablement must not invoke inference");
    },
  };
  registry.agentHarnesses.push({ pluginId: "fixture", source: "runtime", harness });
  io.read.mockResolvedValue({
    exists: true,
    valid: true,
    sourceConfig: config,
  } satisfies Partial<ConfigFileSnapshot>);
  io.load.mockResolvedValue({
    pluginRegistry: registry,
    metadataSnapshot: createSystemAgentPluginMetadataTestSnapshot(config).bindForConfig(config),
  });
  io.write.mockImplementation(async (_next, options) => {
    options.writeOptions.assertCurrent();
    options.writeOptions.beforeCommit();
  });
  const params = {
    agentId: "research",
    runtimeId: harness.id,
    configPatch,
    prompter: createWizardPrompter(undefined, { defaultSelect: "continue" }),
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
    onCommitStarted: vi.fn(),
  };
  return { config, registry, harness, params };
}

it("uses the runtime declaration, not the client label, for direct-runtime consent", async () => {
  const { harness, params } = fixture();
  delete harness.executionEnvironment;
  await setupNativeRuntime(params);
  expect(params.prompter.select).not.toHaveBeenCalled();
  expect(io.write.mock.calls[0]?.[0].agents.entries.research.nativeRuntimeConsent).toBeUndefined();
});

it("rejects a patch that also changes model defaults", async () => {
  const { params } = fixture();
  params.configPatch = { ...configPatch, agents: { defaults: { model: "unrequested/model" } } };
  await expect(setupNativeRuntime(params)).rejects.toThrow("one plugin configuration patch");
  expect(io.write).not.toHaveBeenCalled();
});

beforeEach(() => vi.resetAllMocks());

describe("installed runtime setup", () => {
  it("cancels the shared consent wizard without enabling or remembering consent", async () => {
    const { config, params } = fixture();
    const session = new WizardSession((prompter, signal, owner) =>
      setupNativeRuntime({
        ...params,
        prompter,
        signal,
        onCommitStarted: () => owner.lockCancellation(),
      }),
    );
    const prompt = await session.next();
    expect(prompt.step).toMatchObject({
      type: "select",
      options: [{ value: "continue", label: "Continue" }],
    });
    expect(prompt.step?.message).toContain("Fixture Native’s native permissions");
    expect(session.cancel()).toBe(true);
    await session.whenSettled();
    expect(await session.next()).toMatchObject({ done: true, status: "cancelled" });
    expect(io.write).not.toHaveBeenCalled();
    expect(config.plugins?.entries?.fixture?.config).toEqual({ enabled: false });
    expect(config.agents?.entries?.research?.nativeRuntimeConsent).toBeUndefined();
  });

  it("commits enablement and only the selected agent's consent together without changing models", async () => {
    const { config, params } = fixture();
    await setupNativeRuntime(params);
    expect(io.write).toHaveBeenCalledOnce();
    const [committed, options] = io.write.mock.calls[0]!;
    expect(committed).toEqual({
      ...config,
      agents: {
        ...config.agents,
        entries: {
          main: {},
          research: { model: "stable/model", nativeRuntimeConsent: ["fixture-runtime"] },
        },
      },
      plugins: configPatch.plugins,
    });
    expect(options.baseSnapshot.sourceConfig).toBe(config);
    expect(params.onCommitStarted).toHaveBeenCalledOnce();
    expect(config.plugins?.entries?.fixture?.config).toEqual({ enabled: false });
  });

  it("reuses remembered consent when enabling again", async () => {
    const { config, params } = fixture();
    config.agents!.entries!.research!.nativeRuntimeConsent = ["fixture-runtime"];
    await setupNativeRuntime(params);
    expect(params.prompter.select).not.toHaveBeenCalled();
    expect(io.write.mock.calls[0]?.[0].agents.entries.research.nativeRuntimeConsent).toEqual([
      "fixture-runtime",
    ]);
  });

  it.each(["cancel", "owner", "authority"])(
    "does not commit after %s changes at consent",
    async (change) => {
      const { registry, params } = fixture();
      let current = true;
      params.assertCurrent.mockImplementation(() => {
        if (!current) {
          throw new Error("authority revoked");
        }
      });
      vi.mocked(params.prompter.select).mockImplementation(async (selection) => {
        if (change === "cancel") {
          throw new WizardCancelledError();
        }
        if (change === "owner") {
          registry.agentHarnesses.length = 0;
        }
        if (change === "authority") {
          current = false;
        }
        return selection.options[0]!.value;
      });
      await expect(setupNativeRuntime(params)).rejects.toThrow();
      expect(io.write).not.toHaveBeenCalled();
    },
  );

  it("rejects an unknown target agent before presenting consent or enabling the runtime", async () => {
    const { params } = fixture();
    params.agentId = "missing";
    await expect(setupNativeRuntime(params)).rejects.toThrow('Unknown agent id "missing"');
    expect(io.load).not.toHaveBeenCalled();
    expect(params.prompter.select).not.toHaveBeenCalled();
    expect(io.write).not.toHaveBeenCalled();
  });

  it.each(["unknown", "wrong-owner"])(
    "rejects a %s runtime instead of trusting client identity",
    async (kind) => {
      const { params } = fixture();
      if (kind === "unknown") {
        params.runtimeId = "unknown";
      } else {
        params.configPatch = { plugins: { entries: { other: { config: { enabled: true } } } } };
      }
      await expect(setupNativeRuntime(params)).rejects.toThrow("does not own");
      expect(params.prompter.select).not.toHaveBeenCalled();
      expect(io.write).not.toHaveBeenCalled();
    },
  );
});
