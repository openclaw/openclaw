/**
 * SDK-based wrapper for GitHub Copilot auth status and model discovery.
 *
 * Uses `@github/copilot-sdk` (CopilotClient) to check authentication
 * and list available models. The SDK manages the Copilot CLI process
 * lifecycle internally — callers don't need to handle tokens or endpoints.
 *
 * This module differs from `../agents/copilot-sdk.ts` (the CLI backend):
 *  - CLI backend: runs interactive agent sessions via JSON-RPC stdio
 *  - This module: auth verification + model catalogue for the REST provider pipeline
 */
import type { ModelDefinitionConfig } from "../config/types.js";

// ---------------------------------------------------------------------------
// Lazy SDK import — @github/copilot-sdk is ESM-only + optional dependency
// ---------------------------------------------------------------------------

type CopilotSdkModule = typeof import("@github/copilot-sdk");

let sdkModulePromise: Promise<CopilotSdkModule> | undefined;

function loadSdk(): Promise<CopilotSdkModule> {
  sdkModulePromise ??= import("@github/copilot-sdk");
  return sdkModulePromise;
}

// ---------------------------------------------------------------------------
// Client lifecycle — lazy, not a module-level singleton
// ---------------------------------------------------------------------------

type SdkClient = InstanceType<CopilotSdkModule["CopilotClient"]>;

let sharedClient: SdkClient | undefined;
let clientStartPromise: Promise<SdkClient> | undefined;

/**
 * Get (or create) a shared CopilotClient. The client is started on first call
 * and reused for subsequent calls. Call {@link stopCopilotSdkClient} to shut it
 * down when you're done.
 */
export async function ensureCopilotSdkClient(): Promise<SdkClient> {
  if (sharedClient) {
    return sharedClient;
  }
  if (clientStartPromise) {
    return clientStartPromise;
  }

  clientStartPromise = (async () => {
    try {
      const { CopilotClient } = await loadSdk();
      const client = new CopilotClient();
      await client.start();
      sharedClient = client;
      clientStartPromise = undefined;
      return client;
    } catch (err) {
      clientStartPromise = undefined;
      throw err;
    }
  })();

  return clientStartPromise;
}

/**
 * Shut down the shared CopilotClient if one is running.
 */
export async function stopCopilotSdkClient(): Promise<void> {
  const client = sharedClient;
  sharedClient = undefined;
  clientStartPromise = undefined;
  if (client) {
    await client.stop();
  }
}

// ---------------------------------------------------------------------------
// Auth status
// ---------------------------------------------------------------------------

export type CopilotAuthStatus = {
  authenticated: boolean;
  login?: string;
  host?: string;
  authType?: string;
  message?: string;
};

/**
 * Check whether the current user is authenticated with GitHub Copilot
 * via the SDK / CLI.
 *
 * Returns a simplified status object. Does NOT throw on auth failure —
 * callers should inspect `.authenticated`.
 */
export async function getCopilotSdkAuthStatus(): Promise<CopilotAuthStatus> {
  try {
    const client = await ensureCopilotSdkClient();
    const status = await client.getAuthStatus();
    return {
      authenticated: status.isAuthenticated,
      login: status.login,
      host: status.host,
      authType: status.authType,
      message: status.statusMessage,
    };
  } catch (err) {
    return {
      authenticated: false,
      message: `SDK auth check failed: ${String(err)}`,
    };
  }
}

/**
 * Check if the SDK is available (copilot CLI is installed and can be spawned).
 * This is a lightweight check — it attempts to start the client and ping it.
 */
export async function isCopilotSdkAvailable(): Promise<boolean> {
  try {
    const client = await ensureCopilotSdkClient();
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

type SdkModelInfo = Awaited<ReturnType<SdkClient["listModels"]>>[number];

/**
 * Convert an SDK `ModelInfo` into OpenClaw's `ModelDefinitionConfig`.
 */
export function buildCopilotModelDefinitionFromSdk(model: SdkModelInfo): ModelDefinitionConfig {
  const supportsVision = model.capabilities?.supports?.vision ?? false;
  const supportsReasoning = model.capabilities?.supports?.reasoningEffort ?? false;

  return {
    id: model.id,
    name: model.name || model.id,
    api: "openai-responses",
    reasoning: supportsReasoning,
    input: supportsVision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.capabilities?.limits?.max_context_window_tokens ?? 128_000,
    maxTokens: model.capabilities?.limits?.max_prompt_tokens ?? 8192,
  };
}

/**
 * Discover available Copilot models via the SDK.
 *
 * Returns an array of `ModelDefinitionConfig` built from the SDK's model
 * catalogue. Returns `null` if the SDK is unavailable or the user isn't
 * authenticated (callers should fall back to hardcoded defaults).
 */
export async function discoverCopilotModelsViaSdk(): Promise<ModelDefinitionConfig[] | null> {
  try {
    const client = await ensureCopilotSdkClient();
    const models = await client.listModels();
    if (!models || models.length === 0) {
      return null;
    }
    return models
      .filter((m) => m.policy?.state !== "disabled")
      .map(buildCopilotModelDefinitionFromSdk);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test helpers — allow resetting module state in tests
// ---------------------------------------------------------------------------

/** @internal — reset module state for tests */
export function _resetForTesting(): void {
  sharedClient = undefined;
  clientStartPromise = undefined;
  sdkModulePromise = undefined;
}
