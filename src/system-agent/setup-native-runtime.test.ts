import { beforeEach, expect, it, vi, type Mock } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { AgentHarness } from "../agents/harness/types.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { WizardSession } from "../wizard/session.js";
import { setupNativeRuntime } from "./setup-native-runtime.js";
import { createSystemAgentPluginMetadataTestSnapshot } from "./system-agent.test-helpers.js";

const io = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), load: vi.fn() }));
vi.mock(import("../wizard/setup.shared.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readSetupConfigFileSnapshot: io.read,
  writeWizardConfigFile: io.write,
}));
vi.mock(import("./setup-inference-turn.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  loadSetupInferencePluginGeneration: io.load,
}));

const pluginPatch = (id = "fixture", enabled = true) => ({
  plugins: { entries: { [id]: { config: { enabled } } } },
});
let config: OpenClawConfig;
let registry: ReturnType<typeof createEmptyPluginRegistry>;
let harness: AgentHarness;
let params: Parameters<typeof setupNativeRuntime>[0] & {
  assertCurrent: Mock<() => void>;
  onCommitStarted: Mock<() => void>;
};
beforeEach(() => {
  vi.resetAllMocks();
  config = {
    agents: {
      ownership: "explicit",
      entries: { main: {}, research: { model: "stable/model" } },
      defaults: { model: "stable/default" },
    },
    ...pluginPatch("fixture", false),
  };
  registry = createEmptyPluginRegistry();
  harness = {
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
  params = {
    agentId: "research",
    runtimeId: harness.id,
    configPatch: pluginPatch(),
    prompter: createWizardPrompter(undefined, { defaultSelect: "continue" }),
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
    onCommitStarted: vi.fn(),
  };
});

it.each(["runtime declaration", "remembered consent"])("skips prompting for %s", async (reason) => {
  const consent = reason === "remembered consent" ? [harness.id] : undefined;
  if (consent) {
    config.agents!.entries!.research!.nativeRuntimeConsent = consent;
  } else {
    delete harness.executionEnvironment;
  }
  await setupNativeRuntime(params);
  expect(params.prompter.select).not.toHaveBeenCalled();
  expect(io.write.mock.calls[0]?.[0].agents.entries.research.nativeRuntimeConsent).toEqual(consent);
});

it("cancels consent without enabling or remembering it", async () => {
  const session = new WizardSession((prompter, signal, owner) =>
    setupNativeRuntime({
      ...params,
      prompter,
      signal,
      onCommitStarted: () => owner.lockCancellation(),
    }),
  );
  const { step } = await session.next();
  expect(step).toMatchObject({
    type: "select",
    options: [{ value: "continue", label: "Continue" }],
    message: expect.stringContaining("Fixture Native’s native permissions"),
  });
  expect(session.cancel()).toBe(true);
  await session.whenSettled();
  expect(await session.next()).toMatchObject({ done: true, status: "cancelled" });
  expect(io.write).not.toHaveBeenCalled();
  expect(config.plugins?.entries?.fixture?.config).toEqual({ enabled: false });
  expect(config.agents?.entries?.research?.nativeRuntimeConsent).toBeUndefined();
});

it("commits enablement and only the selected agent's consent without changing models", async () => {
  await setupNativeRuntime(params);
  expect(io.write).toHaveBeenCalledOnce();
  const [committed, options] = io.write.mock.calls[0]!;
  expect(committed).toEqual({
    ...config,
    agents: {
      ...config.agents,
      entries: {
        main: {},
        research: { model: "stable/model", nativeRuntimeConsent: [harness.id] },
      },
    },
    ...pluginPatch(),
  });
  expect(options.baseSnapshot.sourceConfig).toBe(config);
  expect(params.onCommitStarted).toHaveBeenCalledOnce();
  expect(config.plugins?.entries?.fixture?.config).toEqual({ enabled: false });
});

it.each(["cancel", "owner", "authority"])(
  "does not commit after %s changes at consent",
  async (change) => {
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

it.each([
  [
    "model defaults",
    {
      configPatch: { ...pluginPatch(), agents: { defaults: { model: "unrequested/model" } } },
    },
    "one plugin configuration patch",
  ],
  ["missing agent", { agentId: "missing" }, 'Unknown agent id "missing"'],
  ["unknown runtime", { runtimeId: "unknown" }, "does not own"],
  ["wrong owner", { configPatch: pluginPatch("other") }, "does not own"],
] as const)("rejects %s before consent or enabling", async (kind, overrides, error) => {
  Object.assign(params, overrides);
  await expect(setupNativeRuntime(params)).rejects.toThrow(error);
  if (kind === "missing agent") {
    expect(io.load).not.toHaveBeenCalled();
  }
  expect(params.prompter.select).not.toHaveBeenCalled();
  expect(io.write).not.toHaveBeenCalled();
});
