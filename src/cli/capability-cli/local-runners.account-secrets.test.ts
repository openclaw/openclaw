/** Local capability runners must materialize the selected agent's saved-account SecretRefs. */
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateAuthProfileStoreWithLock } from "../../agents/auth-profiles/store-runtime.js";
import { resolveApiKeyForProviderCore } from "../../agents/model-auth.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearSecretsRuntimeSnapshotState } from "../../secrets/runtime-state.js";
import { setupSecretsRuntimeSnapshotTestHooks } from "../../secrets/runtime.test-support.ts";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";

setupSecretsRuntimeSnapshotTestHooks();

type ProviderEgressParams = { cfg?: OpenClawConfig; config?: OpenClawConfig; agentDir?: string };

const hoisted = vi.hoisted(() => {
  const rawCfg: OpenClawConfig = {};
  const egressAuth: Array<{ source?: string; apiKey?: string }> = [];
  return { rawCfg, egressAuth };
});

// Stands in for the provider plugin at its egress boundary: it performs the same
// saved-account auth lookup a real provider runs before sending a request.
async function resolveEgressAuth(params: ProviderEgressParams): Promise<void> {
  const auth = await resolveApiKeyForProviderCore({
    provider: "customacct",
    cfg: params.cfg ?? params.config,
    agentDir: params.agentDir,
  });
  hoisted.egressAuth.push({ source: auth.source, apiKey: auth.apiKey });
}

vi.mock("../../image-generation/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../image-generation/runtime.js")>()),
  generateImage: vi.fn(async (params: ProviderEgressParams) => {
    await resolveEgressAuth(params);
    return { provider: "customacct", model: "test-model", attempts: [], images: [] };
  }),
}));

vi.mock("../../video-generation/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../video-generation/runtime.js")>()),
  generateVideo: vi.fn(async (params: ProviderEgressParams) => {
    await resolveEgressAuth(params);
    return { provider: "customacct", model: "test-model", attempts: [], videos: [] };
  }),
}));

vi.mock("../../media-understanding/runtime.js", async (importOriginal) => {
  const understandMedia = async (params: ProviderEgressParams) => {
    await resolveEgressAuth(params);
    return { text: "synthetic-ok", provider: "customacct", model: "test-model" };
  };
  return {
    ...(await importOriginal<typeof import("../../media-understanding/runtime.js")>()),
    describeImageFile: vi.fn(understandMedia),
    describeVideoFile: vi.fn(understandMedia),
    transcribeAudioFile: vi.fn(understandMedia),
  };
});

vi.mock("../../plugin-sdk/memory-core-bundled-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugin-sdk/memory-core-bundled-runtime.js")>()),
  createEmbeddingProvider: vi.fn(async (params: ProviderEgressParams) => {
    await resolveEgressAuth(params);
    return {
      provider: {
        id: "customacct",
        model: "test-model",
        embedBatch: async (texts: string[]) => texts.map(() => [0.5]),
      },
    };
  }),
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: () => hoisted.rawCfg,
}));

vi.mock("../cli-utils.js", () => ({
  runCommandWithRuntime: vi.fn(async (_runtime: unknown, run: () => Promise<void>) => await run()),
}));

vi.mock("./output.js", () => ({
  emitJsonOrText: vi.fn(),
  formatEnvelopeForText: vi.fn(),
  providerSummaryText: vi.fn(),
}));

import { registerAudioCapabilityCommands } from "./audio.js";
import { registerEmbeddingCapabilityCommands } from "./embedding.js";
import { registerImageCapabilityCommands } from "./image.js";
import { registerVideoCapabilityCommands } from "./video.js";

// Synthetic-only credential for local-path proof. Never a real key or endpoint.
const ENV_ACCOUNT_KEY = "OPENCLAW_TEST_CAPABILITY_ACCOUNT_KEY";
const ACCOUNT_KEY_VALUE = "synthetic-capability-account-key"; // pragma: allowlist secret

function buildRawCfg(agentDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: { workspace: join(agentDir, "workspace") },
      entries: { ops: { agentDir } },
    },
    models: {
      providers: {
        customacct: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", models: [] },
      },
    },
  };
}

async function runLocalCapability(argv: string[]): Promise<void> {
  const capability = new Command();
  registerImageCapabilityCommands(capability);
  registerEmbeddingCapabilityCommands(capability);
  registerAudioCapabilityCommands(capability);
  registerVideoCapabilityCommands(capability);
  await capability.parseAsync([...argv, "--agent", "ops", "--json"], { from: "user" });
}

describe("local capability runners saved-account SecretRefs", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      prefix: "openclaw-capability-account-",
      env: { [ENV_ACCOUNT_KEY]: ACCOUNT_KEY_VALUE },
    });
    const agentDir = state.agentDir("ops");
    hoisted.rawCfg = buildRawCfg(agentDir);
    // Production CLI boot pins the authored config as the runtime source first.
    setRuntimeConfigSnapshot(structuredClone(hoisted.rawCfg), structuredClone(hoisted.rawCfg));
    hoisted.egressAuth.length = 0;
    const seeded = await updateAuthProfileStoreWithLock({
      agentDir,
      updater: (store) => {
        store.profiles["customacct:saved"] = {
          type: "api_key",
          provider: "customacct",
          keyRef: { source: "env", provider: "default", id: ENV_ACCOUNT_KEY },
        };
        return true;
      },
    });
    expect(seeded).not.toBeNull();
  });

  afterEach(async () => {
    clearSecretsRuntimeSnapshotState();
    await state.cleanup();
  });

  it.each([
    ["image generate", ["image", "generate", "--prompt", "a red square"]],
    ["image describe", ["image", "describe", "--file", "input.png"]],
    ["embedding create", ["embedding", "create", "--text", "hello", "--provider", "customacct"]],
    ["audio transcribe", ["audio", "transcribe", "--file", "input.wav"]],
    ["video generate", ["video", "generate", "--prompt", "a red square"]],
    ["video describe", ["video", "describe", "--file", "input.mp4"]],
  ])("%s resolves the saved account credential", async (_name, argv) => {
    await runLocalCapability(argv);

    expect(hoisted.egressAuth).toHaveLength(1);
    expect(hoisted.egressAuth[0]).toEqual({
      source: "profile:customacct:saved",
      apiKey: ACCOUNT_KEY_VALUE,
    });
  });
});
