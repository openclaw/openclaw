/** Local `model run` must preserve config SecretRef provenance through snapshot activation. */
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import { updateAuthProfileStoreWithLock } from "../../agents/auth-profiles/store-runtime.js";
import { resolveProviderConfigSecretInput } from "../../agents/model-auth-provider-config.js";
import {
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearSecretsRuntimeSnapshotState } from "../../secrets/runtime-state.js";
import { setupSecretsRuntimeSnapshotTestHooks } from "../../secrets/runtime.test-support.ts";
import { looksLikeSecretSentinel, resolveSecretSentinel } from "../../secrets/sentinel.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";

setupSecretsRuntimeSnapshotTestHooks();

const hoisted = vi.hoisted(() => {
  const rawCfg: OpenClawConfig = {};
  return {
    rawCfg,
    completeWithPreparedSimpleCompletionModel: vi.fn(
      async (
        _params: Parameters<
          typeof import("../../agents/simple-completion-execution.js").completeWithPreparedSimpleCompletionModel
        >[0],
      ) => ({
        content: [{ type: "text", text: "synthetic-ok" }],
      }),
    ),
    emitJsonOrText: vi.fn(),
  };
});

const completeWithPreparedSimpleCompletionModelMock =
  hoisted.completeWithPreparedSimpleCompletionModel;
const emitJsonOrTextMock = hoisted.emitJsonOrText;

vi.mock("../../agents/simple-completion-execution.js", () => ({
  completeWithPreparedSimpleCompletionModel: hoisted.completeWithPreparedSimpleCompletionModel,
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: () => hoisted.rawCfg,
}));

vi.mock("../cli-utils.js", () => ({
  runCommandWithRuntime: vi.fn(async (_runtime: unknown, run: () => Promise<void>) => await run()),
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeJson: vi.fn(),
    writeStdout: vi.fn(),
  },
}));

vi.mock("./output.js", () => ({
  emitJsonOrText: hoisted.emitJsonOrText,
  formatEnvelopeForText: vi.fn(),
  providerSummaryText: vi.fn(),
}));

import { registerModelCapabilityCommands } from "./model.js";

// Synthetic-only credentials for local-path proof. Never real keys or endpoints.
const ENV_CONFIG_KEY = "OPENCLAW_TEST_PROVENANCE_CONFIG_KEY";
const ENV_ACCOUNT_KEY = "OPENCLAW_TEST_PROVENANCE_ACCOUNT_KEY";
const ENV_MISSING_KEY = "OPENCLAW_TEST_PROVENANCE_MISSING_KEY";
// Deliberately collides with the decoy profile id below: without SecretRef
// provenance the resolved bytes are misread as a profile reference.
const CONFIG_KEY_VALUE = "customcfg:decoy"; // pragma: allowlist secret
const ACCOUNT_KEY_VALUE = "synthetic-account-key"; // pragma: allowlist secret

function buildRawCfg(agentDir: string): OpenClawConfig {
  const model: ModelDefinitionConfig = {
    id: "test-model",
    name: "Test model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 128,
  };
  return {
    agents: {
      defaults: { workspace: join(agentDir, "workspace") },
      entries: {
        ops: { agentDir, model: "customcfg/test-model" },
      },
    },
    models: {
      providers: {
        customcfg: {
          api: "openai-completions",
          auth: "api-key",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: { source: "env", provider: "default", id: ENV_CONFIG_KEY },
          models: [structuredClone(model)],
        },
        customacct: {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:1/v1",
          models: [structuredClone(model)],
        },
      },
    },
  };
}

async function seedProfiles(
  agentDir: string,
  profiles: AuthProfileStore["profiles"],
): Promise<void> {
  const seededStore = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (store) => {
      Object.assign(store.profiles, profiles);
      return true;
    },
  });
  expect(seededStore).not.toBeNull();
}

function seedStandardProfiles(agentDir: string): Promise<void> {
  return seedProfiles(agentDir, {
    "customcfg:decoy": {
      type: "api_key",
      provider: "customcfg",
      key: "synthetic-decoy-key", // pragma: allowlist secret
    },
    "customacct:healthy": {
      type: "api_key",
      provider: "customacct",
      keyRef: { source: "env", provider: "default", id: ENV_ACCOUNT_KEY },
    },
  });
}

async function runLocalModelRun(model: string): Promise<void> {
  const capability = new Command();
  registerModelCapabilityCommands(capability);
  const work = new AsyncWorkScope();
  try {
    await work.track(() =>
      capability.parseAsync(
        [
          "model",
          "run",
          "--prompt",
          "hello",
          "--agent",
          "ops",
          "--model",
          model,
          "--local",
          "--json",
        ],
        { from: "user" },
      ),
    );
  } finally {
    await work.drain();
  }
}

/** Reads the auth captured by the faked provider-egress boundary. */
function getCompletionAuth() {
  return completeWithPreparedSimpleCompletionModelMock.mock.calls.at(-1)?.[0]?.auth;
}

describe("local model run config SecretRef provenance", () => {
  let agentDir = "";
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      prefix: "openclaw-model-run-prov-",
      env: {
        [ENV_CONFIG_KEY]: CONFIG_KEY_VALUE,
        [ENV_ACCOUNT_KEY]: ACCOUNT_KEY_VALUE,
        [ENV_MISSING_KEY]: undefined,
      },
    });
    agentDir = state.agentDir("ops");
    hoisted.rawCfg = buildRawCfg(agentDir);
    // Replicate production CLI boot (config-guard pins the authored raw config
    // as the runtime source before any command runs). Without this the helper
    // would fall back to the resolved config, exactly like a bootless process.
    setRuntimeConfigSnapshot(structuredClone(hoisted.rawCfg), structuredClone(hoisted.rawCfg));
    completeWithPreparedSimpleCompletionModelMock.mockClear();
    emitJsonOrTextMock.mockClear();
  });

  afterEach(async () => {
    clearSecretsRuntimeSnapshotState();
    await state.cleanup();
  });

  it("preserves config SecretRef provenance and sentinelizes the intended credential", async () => {
    await seedStandardProfiles(agentDir);
    await runLocalModelRun("customcfg/test-model");

    expect(emitJsonOrTextMock).toHaveBeenCalledTimes(1);
    const source = getRuntimeConfigSourceSnapshot();
    const { ref } = resolveProviderConfigSecretInput(source ?? undefined, "customcfg");
    expect(ref).toMatchObject({ source: "env", id: ENV_CONFIG_KEY });
    expect(completeWithPreparedSimpleCompletionModelMock).toHaveBeenCalledTimes(1);
    const auth = getCompletionAuth();
    expect(auth?.source).toBe("models.providers.customcfg");
    expect(looksLikeSecretSentinel(auth?.apiKey ?? "")).toBe(true);
    expect(resolveSecretSentinel(auth?.apiKey ?? "")).toBe(CONFIG_KEY_VALUE);
  });

  it("materializes a persisted account SecretRef for the selected provider", async () => {
    await seedStandardProfiles(agentDir);
    await runLocalModelRun("customacct/test-model");

    expect(completeWithPreparedSimpleCompletionModelMock).toHaveBeenCalledTimes(1);
    const auth = getCompletionAuth();
    expect(auth?.source).toBe("profile:customacct:healthy");
    expect(looksLikeSecretSentinel(auth?.apiKey ?? "")).toBe(true);
    expect(resolveSecretSentinel(auth?.apiKey ?? "")).toBe(ACCOUNT_KEY_VALUE);
  });

  it("keeps a healthy selected provider usable while an unrelated sibling is unavailable", async () => {
    await seedProfiles(agentDir, {
      "otherprovider:cold": {
        type: "api_key",
        provider: "otherprovider",
        keyRef: { source: "env", provider: "default", id: ENV_MISSING_KEY },
      },
      "customacct:healthy": {
        type: "api_key",
        provider: "customacct",
        keyRef: { source: "env", provider: "default", id: ENV_ACCOUNT_KEY },
      },
    });
    await runLocalModelRun("customacct/test-model");

    expect(completeWithPreparedSimpleCompletionModelMock).toHaveBeenCalledTimes(1);
    const auth = getCompletionAuth();
    expect(auth?.source).toBe("profile:customacct:healthy");
    expect(resolveSecretSentinel(auth?.apiKey ?? "")).toBe(ACCOUNT_KEY_VALUE);
  });

  it("fails closed when the selected account SecretRef is unavailable", async () => {
    await seedProfiles(agentDir, {
      "customacct:healthy": {
        type: "api_key",
        provider: "customacct",
        keyRef: { source: "env", provider: "default", id: ENV_MISSING_KEY },
      },
    });

    await expect(runLocalModelRun("customacct/test-model")).rejects.toThrow(
      /Auth lookup failed for provider "customacct": .*customacct:healthy.*is configured but unavailable \(secret reference was not found\)/,
    );
    expect(completeWithPreparedSimpleCompletionModelMock).not.toHaveBeenCalled();
  });
});
