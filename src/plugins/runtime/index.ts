import { resolveStateDir } from "../../config/paths.js";
import {
  listRuntimeImageGenerationProviders,
  generateImage,
} from "../../image-generation/runtime.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  createLazyRuntimeMethod,
  createLazyRuntimeMethodBinder,
  createLazyRuntimeModule,
} from "../../shared/lazy-runtime.js";
import { VERSION } from "../../version.js";
import { listWebSearchProviders, runWebSearch } from "../../web-search/runtime.js";
import { createRuntimeAgent } from "./runtime-agent.js";
import { defineCachedValue } from "./runtime-cache.js";
import { createRuntimeChannel } from "./runtime-channel.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { createRuntimeEvents } from "./runtime-events.js";
import { createRuntimeLogging } from "./runtime-logging.js";
import { createRuntimeMedia } from "./runtime-media.js";
import { createRuntimeSystem } from "./runtime-system.js";
import type { PluginRuntime } from "./types.js";

const loadTtsRuntime = createLazyRuntimeModule(() => import("./runtime-tts.runtime.js"));
const loadMediaUnderstandingRuntime = createLazyRuntimeModule(
  () => import("./runtime-media-understanding.runtime.js"),
);
const loadModelAuthRuntime = createLazyRuntimeModule(
  () => import("./runtime-model-auth.runtime.js"),
);

function createRuntimeTts(): PluginRuntime["tts"] {
  const bindTtsRuntime = createLazyRuntimeMethodBinder(loadTtsRuntime);
  return {
    textToSpeech: bindTtsRuntime((runtime) => runtime.textToSpeech),
    textToSpeechTelephony: bindTtsRuntime((runtime) => runtime.textToSpeechTelephony),
    listVoices: bindTtsRuntime((runtime) => runtime.listSpeechVoices),
  };
}

function createRuntimeMediaUnderstandingFacade(): PluginRuntime["mediaUnderstanding"] {
  const bindMediaUnderstandingRuntime = createLazyRuntimeMethodBinder(
    loadMediaUnderstandingRuntime,
  );
  return {
    runFile: bindMediaUnderstandingRuntime((runtime) => runtime.runMediaUnderstandingFile),
    describeImageFile: bindMediaUnderstandingRuntime((runtime) => runtime.describeImageFile),
    describeImageFileWithModel: bindMediaUnderstandingRuntime(
      (runtime) => runtime.describeImageFileWithModel,
    ),
    describeVideoFile: bindMediaUnderstandingRuntime((runtime) => runtime.describeVideoFile),
    transcribeAudioFile: bindMediaUnderstandingRuntime((runtime) => runtime.transcribeAudioFile),
  };
}

function createRuntimeModelAuth(): PluginRuntime["modelAuth"] {
  const getApiKeyForModel = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.getApiKeyForModel,
  );
  const resolveApiKeyForProvider = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.resolveApiKeyForProvider,
  );
  return {
    getApiKeyForModel: (params) =>
      getApiKeyForModel({
        model: params.model,
        cfg: params.cfg,
      }),
    resolveApiKeyForProvider: (params) =>
      resolveApiKeyForProvider({
        provider: params.provider,
        cfg: params.cfg,
      }),
  };
}

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

const gatewaySubagentState = resolveGlobalSingleton<GatewaySubagentState>(
  GATEWAY_SUBAGENT_SYMBOL,
  () => ({
    subagent: undefined,
  }),
);

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

// ── Process-global gateway agent abort runtime ──────────────────────
// Mirrors the subagent pattern: the gateway sets the real agent.abort
// implementation at startup; plugin runtimes that opt in resolve it
// dynamically via late binding.

const GATEWAY_AGENT_ABORT_SYMBOL: unique symbol = Symbol.for(
  "openclaw.plugin.gatewayAgentAbortRuntime",
) as unknown as typeof GATEWAY_AGENT_ABORT_SYMBOL;

type GatewayAgentAbortState = {
  abort: PluginRuntime["agent"]["abort"] | undefined;
};

const gatewayAgentAbortState = resolveGlobalSingleton<GatewayAgentAbortState>(
  GATEWAY_AGENT_ABORT_SYMBOL,
  () => ({ abort: undefined }),
);

/**
 * Set the process-global gateway agent abort runtime.
 * Called during gateway startup so that gateway-bindable plugin runtimes can
 * resolve agent.abort dynamically.
 */
export function setGatewayAgentAbort(abort: PluginRuntime["agent"]["abort"]): void {
  gatewayAgentAbortState.abort = abort;
}

/**
 * Reset the process-global gateway agent abort runtime.
 * Used by tests to avoid leaking gateway state across module reloads.
 */
export function clearGatewayAgentAbort(): void {
  gatewayAgentAbortState.abort = undefined;
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
  const mediaUnderstanding = createRuntimeMediaUnderstandingFacade();
  const baseAgent = createRuntimeAgent();
  const agentWithAbort: PluginRuntime["agent"] = {
    ...baseAgent,
    abort:
      _options.allowGatewaySubagentBinding === true
        ? (params) => {
            const resolved = gatewayAgentAbortState.abort ?? baseAgent.abort;
            return resolved(params);
          }
        : baseAgent.abort,
  };
  const runtime = {
    // Sourced from the shared OpenClaw version resolver (#52899) so plugins
    // always see the same version the CLI reports, avoiding API-version drift.
    version: VERSION,
    config: createRuntimeConfig(),
    agent: agentWithAbort,
    subagent: createLateBindingSubagent(
      _options.subagent,
      _options.allowGatewaySubagentBinding === true,
    ),
    system: createRuntimeSystem(),
    media: createRuntimeMedia(),
    imageGeneration: {
      generate: generateImage,
      listProviders: listRuntimeImageGenerationProviders,
    },
    webSearch: {
      listProviders: listWebSearchProviders,
      search: runWebSearch,
    },
    channel: createRuntimeChannel(),
    events: createRuntimeEvents(),
    logging: createRuntimeLogging(),
    state: { resolveStateDir },
  } satisfies Omit<PluginRuntime, "tts" | "mediaUnderstanding" | "stt" | "modelAuth"> &
    Partial<Pick<PluginRuntime, "tts" | "mediaUnderstanding" | "stt" | "modelAuth">>;

  defineCachedValue(runtime, "tts", createRuntimeTts);
  defineCachedValue(runtime, "mediaUnderstanding", () => mediaUnderstanding);
  defineCachedValue(runtime, "stt", () => ({
    transcribeAudioFile: mediaUnderstanding.transcribeAudioFile,
  }));
  defineCachedValue(runtime, "modelAuth", createRuntimeModelAuth);

  return runtime as PluginRuntime;
}

export type { PluginRuntime } from "./types.js";
