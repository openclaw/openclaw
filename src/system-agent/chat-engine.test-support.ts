// Chat engine tests: proposals, approvals, and the chat-hosted channel wizard.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, expect, vi } from "vitest";
import {
  fingerprintAuthProfileCredential,
  fingerprintOpaqueRuntimeOwner,
  fingerprintResolvedProviderAuth,
} from "../agents/execution-auth-binding.js";
import { committedConfigFiles as hostedConfigFiles } from "../commands/committed-config.test-support.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { runSetupMemoryImportStep } from "../wizard/setup.memory-import.js";
import { runSystemAgentTurnWithDeps as runSystemAgentTurnWithDepsImpl } from "./agent-turn.test-support.js";
import {
  SystemAgentChatEngine as RuntimeSystemAgentChatEngine,
  type SystemAgentChatEngineOptions,
} from "./chat-engine.js";
import type { ChatWizardHostDependencies } from "./chat-wizard-host.js";
import { configSnapshot as makeConfigSnapshot } from "./configured-inference.test-support.js";
import {
  resolveSystemAgentConfiguredRouteFromConfig as resolveSystemAgentConfiguredRouteFromConfigImpl,
  type SystemAgentConfiguredRoute,
} from "./inference-route.js";
import type { SystemAgentOverview } from "./overview.js";
import {
  createSystemAgentVerifiedInferenceTestFixture as createSystemAgentVerifiedInferenceTestFixtureImpl,
  createSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";
import {
  createSystemAgentVerifiedInferenceBinding as createSystemAgentVerifiedInferenceBindingImpl,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "h",
    config: {},
    sourceConfig: {},
    issues: [],
  })),
  readSetupConfigFileSnapshot: vi.fn(),
  setupChannels: vi.fn(),
  setupSkills: vi.fn(),
  runSearchSetupFlow: vi.fn(),
  runSetupMemoryImportStep: vi.fn(),
  writeWizardConfigFile: vi.fn(),
  sharedVerifiedInference: undefined as SystemAgentVerifiedInferenceBinding | undefined,
}));

export type MemoryImportStepParams = Parameters<typeof runSetupMemoryImportStep>[0];

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../wizard/setup.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wizard/setup.shared.js")>()),
  readSetupConfigFileSnapshot: mocks.readSetupConfigFileSnapshot,
  writeWizardConfigFile: mocks.writeWizardConfigFile,
}));

vi.mock("../flows/channel-setup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../flows/channel-setup.js")>()),
  setupChannels: mocks.setupChannels,
}));

vi.mock("../commands/onboard-skills.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/onboard-skills.js")>()),
  setupSkills: mocks.setupSkills,
}));

vi.mock("../flows/search-setup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../flows/search-setup.js")>()),
  runSearchSetupFlow: mocks.runSearchSetupFlow,
}));

vi.mock("../wizard/setup.memory-import.js", () => ({
  runSetupMemoryImportStep: mocks.runSetupMemoryImportStep,
}));

vi.mock("./verified-inference.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./verified-inference.js")>();
  return {
    ...actual,
    resolveSystemAgentVerifiedInferenceRoute: (
      ...args: Parameters<typeof actual.resolveSystemAgentVerifiedInferenceRoute>
    ) => {
      // Most cases own chat state, not inference ownership. Explicit bindings
      // still run the real resolver so every drift and apply-boundary test stays end-to-end.
      if (args[0] === mocks.sharedVerifiedInference) {
        return Promise.resolve(args[0].execution);
      }
      return actual.resolveSystemAgentVerifiedInferenceRoute(...args);
    },
  };
});

const tempDirs: string[] = [];

export const sharedVerifiedInferenceConfig = {
  agents: {
    entries: {
      main: {
        agentDir: "/tmp/openclaw-openclaw-chat-engine-agent",
        model: "openai/gpt-5.5",
      },
    },
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
        auth: "api-key",
        models: [],
      },
    },
  },
} satisfies OpenClawConfig;

export let sharedVerifiedInference: SystemAgentVerifiedInferenceBinding | undefined;
let sharedFixture: Awaited<ReturnType<typeof createSystemAgentVerifiedInferenceTestFixtureImpl>>;
let pluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot | undefined;

function scoped<Args extends unknown[], Result>(
  run: (...args: Args) => Result,
  config?: (args: Args) => OpenClawConfig,
) {
  return (...args: Args) => pluginMetadataSnapshot!.run(() => run(...args), config?.(args));
}

const resolveSystemAgentConfiguredRouteFromConfig = scoped(
  resolveSystemAgentConfiguredRouteFromConfigImpl,
  ([config]) => config,
);
const createSystemAgentVerifiedInferenceTestFixture = scoped(
  createSystemAgentVerifiedInferenceTestFixtureImpl,
  ([config]) => config,
);
const createSystemAgentVerifiedInferenceBinding = scoped(
  createSystemAgentVerifiedInferenceBindingImpl,
);
export const runSystemAgentTurnWithDeps = scoped(runSystemAgentTurnWithDepsImpl);

export { createSystemAgentVerifiedInferenceTestFixture };

export function useTempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-engine-"));
  tempDirs.push(dir);
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  return dir;
}

export function configSnapshot(config: OpenClawConfig): ConfigFileSnapshot {
  return makeConfigSnapshot(config, { hash: "h", raw: null });
}

function testHarnessBinding(route: SystemAgentConfiguredRoute) {
  if (route.runner !== "embedded") {
    return { auth: {}, deps: {} };
  }
  const agentHarnessId =
    route.agentHarnessRuntimeOverride === "auto"
      ? "openclaw"
      : (route.agentHarnessRuntimeOverride ?? "codex");
  if (agentHarnessId === "openclaw") {
    return { auth: { agentHarnessId }, deps: {} };
  }
  return {
    auth: {
      agentHarnessId,
      runtimeOwnerKind: "plugin-harness" as const,
      runtimeOwnerId: agentHarnessId,
      runtimeArtifactId: `${agentHarnessId}-test-artifact`,
      runtimeArtifactFingerprint: `${agentHarnessId}-test-fingerprint`,
    },
    deps: {
      validateAgentHarnessRuntimeArtifact: vi.fn(async () => true),
    },
  };
}

export async function createAmbientVerifiedBinding(config: OpenClawConfig) {
  const route = await resolveSystemAgentConfiguredRouteFromConfig(config);
  if (!route) {
    throw new Error("missing test route");
  }
  const authFingerprint = fingerprintResolvedProviderAuth({
    apiKey: "test-key",
    source: "models.json",
    mode: "api-key",
  });
  if (!authFingerprint) {
    throw new Error("missing test ambient auth fingerprint");
  }
  const harnessBinding = testHarnessBinding(route);
  return await createSystemAgentVerifiedInferenceBinding({
    configuredRoute: route,
    executionRoute: route,
    auth: {
      authFingerprint,
      modelId: route.model,
      modelApi: route.provider === "anthropic" ? "anthropic-messages" : "openai-responses",
      ...harnessBinding.auth,
    },
    deps: harnessBinding.deps,
  });
}

export async function createOAuthVerifiedBinding(
  config: OpenClawConfig,
  credential: Parameters<typeof fingerprintAuthProfileCredential>[0]["credential"],
) {
  const route = await resolveSystemAgentConfiguredRouteFromConfig(config);
  if (!route) {
    throw new Error("missing test OAuth route");
  }
  const profileId = "anthropic:oauth";
  const authFingerprint = fingerprintAuthProfileCredential({ profileId, credential });
  if (!authFingerprint) {
    throw new Error("missing test OAuth fingerprint");
  }
  const harnessBinding = testHarnessBinding(route);
  return await createSystemAgentVerifiedInferenceBinding({
    configuredRoute: route,
    executionRoute: route,
    auth: { authProfileId: profileId, authFingerprint, ...harnessBinding.auth },
    deps: {
      ...harnessBinding.deps,
      loadAuthProfileStoreForRuntimeAsync: vi.fn(async () => ({
        version: 1,
        profiles: { [profileId]: credential },
      })) as never,
    },
  });
}

export async function createCliVerifiedBinding(config: OpenClawConfig) {
  const route = await resolveSystemAgentConfiguredRouteFromConfig(config);
  if (!route || route.runner !== "cli") {
    throw new Error("missing test CLI route");
  }
  const runtimeArtifactId = route.provider;
  const runtimeArtifactFingerprint = `${runtimeArtifactId}-test-artifact`;
  const runtimeOwnerFingerprint = fingerprintOpaqueRuntimeOwner({
    kind: "cli-runtime",
    runner: "cli",
    provider: route.provider,
    backendId: runtimeArtifactId,
    runtimeArtifactFingerprint,
  });
  if (!runtimeOwnerFingerprint) {
    throw new Error("missing test CLI runtime-owner fingerprint");
  }
  const deps: SystemAgentVerifiedInferenceDeps = {
    resolveCliRuntimeArtifactFingerprint: vi.fn(async () => runtimeArtifactFingerprint),
    resolveCliRuntimeOwnerFingerprint: vi.fn(async () => runtimeOwnerFingerprint),
  };
  const binding = await createSystemAgentVerifiedInferenceBinding({
    configuredRoute: route,
    executionRoute: route,
    auth: {
      runtimeOwnerFingerprint,
      runtimeOwnerKind: "cli-runtime",
      runtimeOwnerId: runtimeArtifactId,
      runtimeArtifactId,
      runtimeArtifactFingerprint,
    },
    deps,
  });
  return { binding, deps };
}

type TestSystemAgentChatEngineOptions = Omit<SystemAgentChatEngineOptions, "verifiedInference"> &
  ChatWizardHostDependencies & {
    executeOperation?: typeof import("./operations.js").executeSystemAgentOperation;
    verifiedInference?: SystemAgentVerifiedInferenceBinding;
  };

/** Every ordinary engine test starts from a real, live-gate-shaped authority grant. */
export class SystemAgentChatEngine extends RuntimeSystemAgentChatEngine {
  override answerWizard = scoped(super.answerWizard.bind(this));
  override cancelWizard = scoped(super.cancelWizard.bind(this));
  override resolveOperatorApproval = scoped(super.resolveOperatorApproval.bind(this));
  override loadOverview = scoped(super.loadOverview.bind(this));
  override planGreeting = scoped(super.planGreeting.bind(this));
  override seedHistory = scoped(super.seedHistory.bind(this));
  override propose = scoped(super.propose.bind(this));
  override handle = scoped(super.handle.bind(this));

  constructor(opts: TestSystemAgentChatEngineOptions = {}) {
    const { executeOperation, ...engineOptions } = opts;
    const explicitBinding = engineOptions.verifiedInference;
    super(
      {
        ...engineOptions,
        verifiedInference: explicitBinding ?? sharedFixture.binding,
        deps: {
          ...(explicitBinding
            ? { validateAgentHarnessRuntimeArtifact: async () => true }
            : sharedFixture.deps),
          readConfigFileSnapshot: async () =>
            configSnapshot(structuredClone(sharedVerifiedInferenceConfig)),
          ...engineOptions.deps,
        },
      },
      {
        wizardDependencies: opts,
        ...(executeOperation ? { executeOperation } : {}),
      },
    );
  }
}

export async function advanceGatewayWizardToSecretStorage(engine: SystemAgentChatEngine) {
  const portStep = await engine.handle("configure gateway");
  expect((await engine.handle("19001")).text).toContain("Gateway bind address");
  // The wizard no longer asks token vs password; bind goes straight to Tailscale exposure,
  // then to how the generated secret is stored.
  expect((await engine.handle("2")).text).toContain("Tailscale exposure");
  const storageStep = await engine.handle("1");
  expect(storageStep.text).toContain("store the Gateway");
  return { portStep, storageStep };
}

beforeAll(async () => {
  pluginMetadataSnapshot = createSystemAgentPluginMetadataTestSnapshot(
    sharedVerifiedInferenceConfig,
  );
  sharedFixture = await createSystemAgentVerifiedInferenceTestFixture(
    sharedVerifiedInferenceConfig,
  );
  sharedVerifiedInference = sharedFixture.binding;
  mocks.sharedVerifiedInference = sharedFixture.binding;
  mocks.readConfigFileSnapshot.mockResolvedValue(
    configSnapshot(structuredClone(sharedVerifiedInferenceConfig)) as never,
  );
});

afterEach(() => {
  hostedConfigFiles.clear();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.readConfigFileSnapshot.mockResolvedValue(
    configSnapshot(structuredClone(sharedVerifiedInferenceConfig)) as never,
  );
  mocks.readSetupConfigFileSnapshot.mockReset();
  mocks.setupChannels.mockReset();
  mocks.setupSkills.mockReset();
  mocks.runSearchSetupFlow.mockReset();
  mocks.runSetupMemoryImportStep.mockReset();
  mocks.writeWizardConfigFile.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

export const CANCEL_HINT = "Say `cancel` to stop this setup.";
export const countCancelHints = (text: string) => text.split(CANCEL_HINT).length - 1;

export function fakeOverviewLoader(
  overrides: {
    defaultModel?: string;
    setupModel?: string;
    claudeFound?: boolean;
    codexFound?: boolean;
  } = {},
) {
  return async (): Promise<SystemAgentOverview> => ({
    config: { path: "/tmp/openclaw.json", exists: false, valid: true, issues: [], hash: null },
    agents: [],
    defaultAgentId: "main",
    defaultModel: overrides.defaultModel,
    ...(overrides.setupModel ? { setupModel: overrides.setupModel } : {}),
    tools: {
      codex: { command: "codex", found: overrides.codexFound ?? false },
      claude: { command: "claude", found: overrides.claudeFound ?? false },
      gemini: { command: "gemini", found: false },
      apiKeys: { openai: false, anthropic: false },
    },
    gateway: { url: "ws://127.0.0.1:18789", source: "local", reachable: false },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  });
}

export { expectDefined } from "@openclaw/normalization-core";
export { hashSystemAgentOperation } from "./operator-approval.js";
export type { OpenClawConfig } from "../config/types.openclaw.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { classifySystemAgentApprovalText } from "./operator-approval.js";
export { SystemAgentWizardAnswerError } from "./chat-engine.js";
export type { SystemAgentChatEngineOptions } from "./chat-engine.js";
export { SystemAgentInferenceUnavailableError } from "./inference-error.js";
export { verifyConfigAfterSystemAgentWrite } from "./post-write-verification.js";
export type { SystemAgentVerifiedInferenceBinding } from "./verified-inference.js";
export { RuntimeSystemAgentChatEngine };
export { mocks };
export { operationMocks } from "./chat-engine.mocks.test-support.js";
