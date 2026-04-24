import { createGemmaCppManager } from "./gemmacpp-manager.js";
import { createLlamaCppManager } from "./llamacpp-manager.js";
import { DEFAULT_MODELS } from "./model-registry.js";
import { createOllamaManager } from "./ollama-manager.js";
import type {
  BackendId,
  ProvisionOpts,
  ProvisionProgress,
  ProvisionResult,
  RuntimeHandle,
  RuntimeManager,
} from "./types.js";

export function createRuntimeManager(backend: BackendId): RuntimeManager {
  switch (backend) {
    case "ollama":
      return createOllamaManager();
    case "llama-cpp":
      return createLlamaCppManager();
    case "gemma-cpp":
      return createGemmaCppManager();
    default:
      throw new Error(`Unknown backend: ${backend as string}`);
  }
}

/**
 * Provision a backend end-to-end: install runtime, start it, pull model,
 * verify with a healthcheck, and return a handle to the running service.
 */
export async function provision(opts: ProvisionOpts): Promise<ProvisionResult> {
  const { backend, port, progress } = opts;
  // Use the model identifier (tag or name), never the download URL.
  // The URL is only used internally by pullModel().
  const modelId = opts.model ?? DEFAULT_MODELS[backend].ollamaTag ?? DEFAULT_MODELS[backend].id;
  const manager = createRuntimeManager(backend);

  const log: ProvisionProgress = progress ?? (() => {});

  // Step 1: Install runtime if needed.
  log(`[${manager.displayName}] Checking installation...`);
  if (!(await manager.isInstalled())) {
    log(`[${manager.displayName}] Installing runtime...`);
    await manager.install(log);
  } else {
    log(`[${manager.displayName}] Runtime already installed.`);
  }

  // Step 2+3: Pull model and start runtime.
  // Ollama can start first then pull via API. llama.cpp/gemma.cpp need the model
  // file on disk before the server starts.
  let handle: RuntimeHandle;

  if (backend === "ollama") {
    log(`[${manager.displayName}] Starting runtime...`);
    handle = await manager.start(port);
    log(`[${manager.displayName}] Runtime started on port ${handle.port} (PID ${handle.pid}).`);
    try {
      log(`[${manager.displayName}] Pulling model ${modelId}...`);
      await manager.pullModel(modelId, handle.port, log);
      log(`[${manager.displayName}] Model ready.`);
    } catch (err) {
      await handle.stop();
      throw err;
    }
  } else {
    log(`[${manager.displayName}] Downloading model ${modelId}...`);
    await manager.pullModel(modelId, 0, log);
    log(`[${manager.displayName}] Model ready.`);
    log(`[${manager.displayName}] Starting runtime...`);
    handle = await manager.start(port);
    log(`[${manager.displayName}] Runtime started on port ${handle.port} (PID ${handle.pid}).`);
  }

  // Step 4: Verify healthcheck.
  const healthy = await manager.healthcheck(handle.port);
  if (!healthy) {
    await handle.stop();
    throw new Error(`[${manager.displayName}] Healthcheck failed after model pull.`);
  }
  log(`[${manager.displayName}] Healthcheck passed.`);

  return { backend, handle, modelId };
}

/**
 * Send a test chat completion request to verify the backend can generate text.
 */
export async function verifyCompletion(
  apiBaseUrl: string,
  modelId: string,
): Promise<{ ok: boolean; content: string; error?: string }> {
  try {
    // Determine the correct endpoint path.
    // Ollama uses /v1/chat/completions, llama.cpp uses /v1/chat/completions,
    // gemma.cpp shim uses /v1/chat/completions.
    const url = `${apiBaseUrl}/v1/chat/completions`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Say hello in exactly one word." }],
        max_tokens: 32,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const text = await response.text();
      return { ok: false, content: "", error: `HTTP ${response.status}: ${text}` };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content ?? "";
    return {
      ok: content.trim().length > 0,
      content: content.trim(),
      error: content.trim().length === 0 ? "Empty response" : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      content: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
