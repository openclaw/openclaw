import {
  getApiKeyForModel as getApiKeyForModelRaw,
  resolveApiKeyForProvider as resolveApiKeyForProviderRaw,
} from "../../agents/model-auth.js";
import { resolveStateDir } from "../../config/paths.js";
import {
  generateImage,
  listRuntimeImageGenerationProviders,
} from "../../image-generation/runtime.js";
import {
  describeImageFile,
  describeImageFileWithModel,
  describeVideoFile,
  runMediaUnderstandingFile,
  transcribeAudioFile,
} from "../../media-understanding/runtime.js";
import { listSpeechVoices, textToSpeech, textToSpeechTelephony } from "../../tts/runtime.js";
import { VERSION } from "../../version.js";
import { listWebSearchProviders, runWebSearch } from "../../web-search/runtime.js";
import { createRuntimeAgent } from "./runtime-agent.js";
import { createRuntimeChannel } from "./runtime-channel.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { createRuntimeEvents } from "./runtime-events.js";
import { createRuntimeLogging } from "./runtime-logging.js";
import { createRuntimeMedia } from "./runtime-media.js";
import { createRuntimeSystem } from "./runtime-system.js";
import { createRuntimeTools } from "./runtime-tools.js";
import type { PluginRuntime } from "./types.js";

function createUnavailableSubagentRuntime(): PluginRuntime["subagent"] {
  const unavailable = () => {
    throw new Error("Plugin runtime subagent methods are only available during a gateway request.");
  };
  return {
    run: unavailable,
    waitForRun: unavailable,
    getSessionMessages: unavailable,
    getSession: unavailable,
    deleteSession: unavailable,
  };
}

// ── Process-global gateway subagent runtime ─────────────────────────
// The gateway creates a real subagent runtime during startup, but gateway-owned
// plugin registries may be loaded (and cached) before the gateway path runs.
// A process-global holder lets explicitly gateway-bindable runtimes resolve the
// active gateway subagent dynamically without changing the default behavior for
// ordinary plugin runtimes.

const GATEWAY_SUBAGENT_SYMBOL: unique symbol = Symbol.for(
  "openclaw.plugin.gatewaySubagentRuntime",
) as unknown as typeof GATEWAY_SUBAGENT_SYMBOL;

type GatewaySubagentState = {
  subagent: PluginRuntime["subagent"] | undefined;
};

const gatewaySubagentState: GatewaySubagentState = (() => {
  const g = globalThis as typeof globalThis & {
    [GATEWAY_SUBAGENT_SYMBOL]?: GatewaySubagentState;
  };
  const existing = g[GATEWAY_SUBAGENT_SYMBOL];
  if (existing) {
    return existing;
  }
  const created: GatewaySubagentState = { subagent: undefined };
  g[GATEWAY_SUBAGENT_SYMBOL] = created;
  return created;
})();

/**
 * Set the process-global gateway subagent runtime.
 * Called during gateway startup so that gateway-bindable plugin runtimes can
 * resolve subagent methods dynamically even when their registry was cached
 * before the gateway finished loading plugins.
 */
export function setGatewaySubagentRuntime(subagent: PluginRuntime["subagent"]): void {
  gatewaySubagentState.subagent = subagent;
}

/**
 * Reset the process-global gateway subagent runtime.
 * Used by tests to avoid leaking gateway state across module reloads.
 */
export function clearGatewaySubagentRuntime(): void {
  gatewaySubagentState.subagent = undefined;
}

/**
 * Create a late-binding subagent that resolves to:
 * 1. An explicitly provided subagent (from runtimeOptions), OR
 * 2. The process-global gateway subagent when the caller explicitly opts in, OR
 * 3. The unavailable fallback (throws with a clear error message).
 */
function createLateBindingSubagent(
  explicit?: PluginRuntime["subagent"],
  allowGatewaySubagentBinding = false,
): PluginRuntime["subagent"] {
  if (explicit) {
    return explicit;
  }

  const unavailable = createUnavailableSubagentRuntime();
  if (!allowGatewaySubagentBinding) {
    return unavailable;
  }

  return new Proxy(unavailable, {
    get(_target, prop, _receiver) {
      const resolved = gatewaySubagentState.subagent ?? unavailable;
      return Reflect.get(resolved, prop, resolved);
    },
  });
}

export type CreatePluginRuntimeOptions = {
  subagent?: PluginRuntime["subagent"];
  allowGatewaySubagentBinding?: boolean;
};

export function createPluginRuntime(_options: CreatePluginRuntimeOptions = {}): PluginRuntime {
  const runtime = {
    version: VERSION,
    config: createRuntimeConfig(),
    agent: createRuntimeAgent(),
    subagent: createLateBindingSubagent(
      _options.subagent,
      _options.allowGatewaySubagentBinding === true,
    ),
    system: createRuntimeSystem(),
    media: createRuntimeMedia(),
    tts: { textToSpeech, textToSpeechTelephony, listVoices: listSpeechVoices },
    mediaUnderstanding: {
      runFile: runMediaUnderstandingFile,
      describeImageFile,
      describeImageFileWithModel,
      describeVideoFile,
      transcribeAudioFile,
    },
    imageGeneration: {
      generate: generateImage,
      listProviders: listRuntimeImageGenerationProviders,
    },
    webSearch: {
      listProviders: listWebSearchProviders,
      search: runWebSearch,
    },
    stt: { transcribeAudioFile },
    tools: createRuntimeTools(),
    channel: createRuntimeChannel(),
    events: createRuntimeEvents(),
    logging: createRuntimeLogging(),
    state: { resolveStateDir },
    modelAuth: {
      // Wrap model-auth helpers so plugins cannot steer credential lookups:
      // - agentDir / store: stripped (prevents reading other agents' stores)
      // - profileId / preferredProfile: stripped (prevents cross-profile
      //   credential access via profile steering)
      // Plugins only specify provider/model; the core auth pipeline picks
      // the appropriate credential automatically.
      getApiKeyForModel: (params) =>
        getApiKeyForModelRaw({
          model: params.model,
          cfg: params.cfg,
        }),
      resolveApiKeyForProvider: (params) =>
        resolveApiKeyForProviderRaw({
          provider: params.provider,
          cfg: params.cfg,
        }),
    },
  } satisfies PluginRuntime;

  return runtime;
}

export type { PluginRuntime } from "./types.js";
