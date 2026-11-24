import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { resolveApiKeyForProfile } from "../agents/auth-profiles/oauth.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  updateAuthProfileStoreWithLock,
} from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { fingerprintResolvedProviderAuth } from "../agents/execution-auth-binding.js";
import { modelDefinition, providerConfig } from "../agents/model-auth.fixtures.test-support.js";
import { resolveApiKeyForProviderCore } from "../agents/model-auth.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { readConfigFileSnapshot, validateConfigObjectRaw } from "../config/config.js";
import { materializeRuntimeConfig } from "../config/materialize.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "../system-agent/inference-route.js";
import { commitSetupInferenceActivation } from "../system-agent/setup-inference-transition.js";
import type { verifySetupInferenceConfig } from "../system-agent/setup-inference-turn.js";
import { createSystemAgentVerifiedInferenceBinding } from "../system-agent/verified-inference.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { offerLiveModelVerification } from "./setup.inference-verification.js";
import { createSetupMigrationStage } from "./setup.migration-stage.js";
import {
  createWizardInferenceConfigTarget,
  readSetupConfigFileSnapshot,
  writeWizardConfigFile,
} from "./setup.shared.js";

const mocks = vi.hoisted(() => ({ verify: vi.fn<typeof verifySetupInferenceConfig>() }));
vi.mock("../system-agent/setup-inference.js", () => ({ verifySetupInferenceConfig: mocks.verify }));
vi.mock("../system-agent/setup-inference-turn.js", () => ({
  revalidateStableSetupInferenceOwner: async () => {},
}));
let state: OpenClawTestState;
let stage: Awaited<ReturnType<typeof createSetupMigrationStage>> | undefined;
afterEach(async () => {
  await stage?.cleanup();
  stage = undefined;
  await state?.cleanup();
  vi.restoreAllMocks();
});

const apiKey = (key: string) => ({ type: "api_key" as const, provider: "example", key });
function rejectActivation(
  configTarget: Parameters<typeof commitSetupInferenceActivation>[0]["configTarget"],
  config: OpenClawConfig,
  failure: Error,
) {
  return commitSetupInferenceActivation({
    configTarget,
    config,
    assertCurrent: () => {},
    activate: async () => {
      throw failure;
    },
  });
}

it.each([
  { target: "file", changed: true, runtimeDefaults: false },
  { target: "stage", changed: true, runtimeDefaults: false },
  { target: "file", changed: false, runtimeDefaults: true },
])(
  "wizard activation uses its $target target (credential changed=$changed, runtime defaults=$runtimeDefaults)",
  async ({ target, changed, runtimeDefaults }) => {
    state = await createOpenClawTestState({ label: "wizard-promotion-recovery" });
    let agentDir = state.agentDir("main");
    const validated = validateConfigObjectRaw({
      ...providerConfig("example", {
        baseUrl: "https://fixture.invalid/v1",
        api: "openai-completions",
        models: [modelDefinition("fixture", { name: "Fixture" })],
      }),
      gateway: { mode: "local" },
      plugins: { slots: { memory: "none" } },
      agents: {
        entries: { main: {} },
        defaults: {
          workspace: state.workspaceDir,
          model: "example/fixture@example:working",
          models: { "example/fixture": { agentRuntime: { id: "openclaw" } } },
        },
      },
    });
    assert.ok(validated.ok);
    let config = validated.config;
    await state.writeConfig(config);
    const initialSnapshot = await (runtimeDefaults
      ? readConfigFileSnapshot()
      : readSetupConfigFileSnapshot());
    config = initialSnapshot.runtimeConfig ?? initialSnapshot.config;
    const finalConfig = initialSnapshot.sourceConfig;
    await state.writeAuthProfiles({
      version: 1,
      profiles: { "example:working": apiKey("working-key") },
    });
    const finalAuth = structuredClone(loadAuthProfileStoreWithoutExternalProfiles(agentDir));
    if (target === "stage") {
      stage = await createSetupMigrationStage({
        providerId: "fixture",
        stateDir: state.stateDir,
        workspaceDir: state.workspaceDir,
        reportDir: state.statePath("migration", "fixture", "report"),
        targetConfig: config,
      });
      config = stage.getStagedConfig();
      agentDir = stage.staged.agentDir;
    }
    const candidate = structuredClone(config);
    candidate.agents!.defaults!.model = "example/fixture@example:pending";
    const pending = {
      ...apiKey("pending-key"),
      setup: {
        replacement: true,
        modelRef: "example/fixture",
        configJson: JSON.stringify(candidate),
      },
    };
    const stateDir = stage?.staged.stateDir;
    const putProfiles = (profiles: AuthProfileStore["profiles"]) =>
      updateAuthProfileStoreWithLock({
        agentDir,
        stateDir,
        updater: (store) => {
          Object.assign(store.profiles, profiles);
          return true;
        },
      });
    await putProfiles({ "example:working": apiKey("working-key"), "example:pending": pending });
    const targetOwner =
      stage?.inferenceConfigTarget ??
      createWizardInferenceConfigTarget((next, options) =>
        writeWizardConfigFile(next, { ...options, mergeBase: config }),
      );
    const savedModels = structuredClone(
      (await targetOwner.read()).config.models?.providers?.example?.models,
    );
    const interceptWrite =
      (write: typeof targetOwner.write): typeof write =>
      async (...args) => {
        const committed = await write(...args);
        if (changed) {
          await putProfiles({ "example:pending": { ...pending, key: "user-changed-key" } });
        }
        return committed;
      };
    mocks.verify.mockImplementation(async (params) => {
      const route = await resolveSystemAgentConfiguredRouteFromConfig(params.config);
      if (!route) {
        throw new Error("Missing fixture route");
      }
      const auth = await resolveApiKeyForProviderCore({
        provider: "example",
        cfg: params.config,
        agentDir,
        profileId: "example:pending",
        lockedProfile: true,
        modelId: "fixture",
        modelApi: "openai-completions",
        secretSentinels: true,
      });
      params.onVerifiedExecution?.(
        await createSystemAgentVerifiedInferenceBinding({
          configuredRoute: { ...route, agentDir },
          executionRoute: { ...route, agentDir },
          auth: {
            authProfileId: "example:pending",
            agentHarnessId: "openclaw",
            modelId: "fixture",
            modelApi: "openai-completions",
            authFingerprint: fingerprintResolvedProviderAuth(auth),
          },
        }),
      );
      return { ok: true, modelRef: "example/fixture", latencyMs: 1 };
    });
    const activation = offerLiveModelVerification({
      config,
      baseConfig: config,
      initialCandidate: {
        config: candidate,
        authProfiles: [],
        persistAuthProfiles: async () => {},
      },
      opts: {},
      prompter: createWizardPrompter({ confirm: async () => true }),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      agentDir,
      stateDir,
      required: true,
      configTarget: {
        write: interceptWrite(targetOwner.write),
        read: async () => {
          const read = await targetOwner.read();
          return {
            config: read.config,
            write: interceptWrite(read.write),
          };
        },
      },
    });
    if (changed) {
      await expect(activation).rejects.toThrow("saved sign-in changed");
    } else {
      await expect(activation).resolves.toMatchObject({ verified: true, persisted: true });
    }
    const reopened = (await targetOwner.read()).config;
    expect(reopened.models?.providers?.example?.models).toEqual(savedModels);
    const selected = splitTrailingAuthProfile(
      resolveAgentModelPrimaryValue(reopened.agents?.defaults?.model) ?? "",
    ).profile;
    const store = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
    const auth = selected
      ? await resolveApiKeyForProfile({ cfg: reopened, store, profileId: selected, agentDir })
      : null;
    expect({ selected, key: auth?.apiKey }).toEqual(
      changed
        ? { selected: "example:working", key: "working-key" }
        : { selected: "example:pending", key: "pending-key" },
    );
    expect(store.profiles["example:pending"]).toEqual(
      changed ? { ...pending, key: "user-changed-key" } : apiKey("pending-key"),
    );
    if (stage) {
      expect((await readConfigFileSnapshot()).sourceConfig).toEqual(finalConfig);
      expect(loadAuthProfileStoreWithoutExternalProfiles(state.agentDir("main"))).toEqual(
        finalAuth,
      );
    }
  },
);

it("wizard recovery restores serialized model defaults after provider canonicalization", async () => {
  state = await createOpenClawTestState({ label: "wizard-serialized-recovery" });
  const provider = {
    baseUrl: "https://fixture.invalid/v1",
    api: "openai-completions" as const,
    models: [
      modelDefinition("fixture", {
        name: "Fixture",
        reasoning: false,
        contextWindow: 32768,
        maxTokens: 4096,
      }),
    ],
  };
  const before = providerConfig("Example", provider);
  await state.writeConfig(before);
  const candidate = materializeRuntimeConfig({
    ...before,
    ...providerConfig("example", provider),
  });
  const failure = new Error("activation refused");
  // The real wizard commits only changes from its captured runtime merge base.
  const mergeBase = materializeRuntimeConfig(before);
  const target = createWizardInferenceConfigTarget(async (next, options) => {
    const committed = await writeWizardConfigFile(next, { ...options, mergeBase });
    const persisted = (await readSetupConfigFileSnapshot()).sourceConfig;
    expect(persisted.security).toBeUndefined();
    expect(persisted.tools).toBeUndefined();
    expect(persisted.messages?.queue).toBeUndefined();
    return committed;
  });
  await expect(rejectActivation(target, candidate, failure)).rejects.toBe(failure);
  expect((await target.read()).config.models?.providers).toEqual(before.models?.providers);
});

it.each([
  { pending: true, superseded: false },
  { pending: false, superseded: true },
])(
  "wizard recovery preserves concurrent ownership (pending=$pending, superseded=$superseded)",
  async ({ pending, superseded }) => {
    state = await createOpenClawTestState({ label: "wizard-concurrent-recovery" });
    const base: OpenClawConfig = providerConfig("example", {
      baseUrl: "https://working.invalid/v1",
      api: "openai-completions",
    });
    if (pending) {
      base.plugins = { installs: { fixture: { source: "npm", spec: "fixture@1.0.0" } } };
    }
    await state.writeConfig(base);
    const candidate = structuredClone(base);
    candidate.models!.providers!.example!.baseUrl = "https://replacement.invalid/v1";
    const concurrent = structuredClone(base);
    concurrent.models!.providers!.example!.headers = { "X-Unrelated": "keep" };
    const target = createWizardInferenceConfigTarget(async (config, options) => {
      await state.writeConfig(concurrent);
      const committed = await writeWizardConfigFile(config, { ...options, mergeBase: base });
      if (superseded) {
        const newer = structuredClone(committed.nextConfig);
        newer.models!.providers!.example!.baseUrl = "https://newer.invalid/v1";
        await state.writeConfig(newer);
      }
      return committed;
    });
    await expect(
      rejectActivation(target, candidate, new Error("promotion refused")),
    ).rejects.toThrow(superseded ? "Newer connection settings" : "promotion refused");
    const restored = (await target.read()).config;
    expect(restored.models?.providers?.example).toEqual({
      ...concurrent.models?.providers?.example,
      ...(superseded ? { baseUrl: "https://newer.invalid/v1" } : {}),
    });
    if (pending) {
      expect(restored.plugins?.installs).toBeUndefined();
      expect((await loadInstalledPluginIndexInstallRecords()).fixture).toMatchObject({
        source: "npm",
        spec: "fixture@1.0.0",
      });
    }
  },
);

it("wizard precondition rejection preserves an intervening writer of the same candidate", async () => {
  state = await createOpenClawTestState({ label: "wizard-write-refusal" });
  const base: OpenClawConfig = { gateway: { mode: "local", port: 18789 } };
  const candidate: OpenClawConfig = { gateway: { mode: "local", port: 18790 } };
  await state.writeConfig(base);
  const refusal = new Error("config write precondition refused");
  const target = createWizardInferenceConfigTarget(async (config, options) => {
    try {
      return await writeWizardConfigFile(config, {
        ...options,
        writeOptions: {
          beforeCommit: async () => {
            throw refusal;
          },
        },
      });
    } catch (error) {
      expect(error).toBe(refusal);
      await writeWizardConfigFile(candidate);
      throw error;
    }
  });
  const activate = vi.fn(async () => undefined);
  await expect(
    commitSetupInferenceActivation({
      configTarget: target,
      config: candidate,
      assertCurrent: () => {},
      activate,
    }),
  ).rejects.toBe(refusal);
  expect(activate).not.toHaveBeenCalled();
  expect((await target.read()).config.gateway?.port).toBe(18790);
});
