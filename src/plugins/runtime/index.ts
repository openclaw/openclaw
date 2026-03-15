import { createRequire } from "node:module";
import {
  getApiKeyForModel as getApiKeyForModelRaw,
  resolveApiKeyForProvider as resolveApiKeyForProviderRaw,
} from "../../agents/model-auth.js";
import { resolveStateDir } from "../../config/paths.js";
import { transcribeAudioFile } from "../../media-understanding/transcribe-audio.js";
import { textToSpeechTelephony } from "../../tts/tts.js";
import { createRuntimeChannel } from "./runtime-channel.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { createRuntimeEvents } from "./runtime-events.js";
import { createRuntimeLogging } from "./runtime-logging.js";
import { createRuntimeMedia } from "./runtime-media.js";
import { createRuntimeSystem } from "./runtime-system.js";
import { createRuntimeTools } from "./runtime-tools.js";
import type { PluginRuntime } from "./types.js";

let cachedVersion: string | null = null;

function resolveVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../../package.json") as { version?: string };
    cachedVersion = pkg.version ?? "unknown";
    return cachedVersion;
  } catch {
    cachedVersion = "unknown";
    return cachedVersion;
  }
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
// The gateway creates a real subagent runtime during startup, but plugins may
// be loaded (and cached) before the gateway path runs — or may be re-loaded
// by non-gateway code paths (e.g. loadSchemaWithPlugins) that don't pass
// subagent options. A process-global holder lets any plugin runtime resolve
// the gateway subagent dynamically, regardless of load order or caching.

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
 * Called once during gateway startup so that all plugin runtimes — including
 * those created before the gateway or by non-gateway load paths — can
 * resolve subagent methods dynamically.
 */
export function setGatewaySubagentRuntime(subagent: PluginRuntime["subagent"]): void {
  gatewaySubagentState.subagent = subagent;
}

/**
 * Create a late-binding subagent that resolves to:
 * 1. An explicitly provided subagent (from runtimeOptions), OR
 * 2. The process-global gateway subagent (set during gateway startup), OR
 * 3. The unavailable fallback (throws with a clear error message).
 */
function createLateBindingSubagent(
  explicit?: PluginRuntime["subagent"],
): PluginRuntime["subagent"] {
  if (explicit) {
    return explicit;
  }

  const unavailable = createUnavailableSubagentRuntime();

  return new Proxy(unavailable, {
    get(_target, prop, receiver) {
      const resolved = gatewaySubagentState.subagent ?? unavailable;
      return Reflect.get(resolved, prop, receiver);
    },
  });
}

export type CreatePluginRuntimeOptions = {
  subagent?: PluginRuntime["subagent"];
};

export function createPluginRuntime(_options: CreatePluginRuntimeOptions = {}): PluginRuntime {
  const runtime = {
    version: resolveVersion(),
    config: createRuntimeConfig(),
    subagent: createLateBindingSubagent(_options.subagent),
    system: createRuntimeSystem(),
    media: createRuntimeMedia(),
    tts: { textToSpeechTelephony },
    stt: { transcribeAudioFile },
    tools: createRuntimeTools(),
    channel: createRuntimeChannel(),
    events: createRuntimeEvents(),
    logging: createRuntimeLogging(),
    state: { resolveStateDir },
    modelAuth: {
      // Wrap model-auth helpers so plugins cannot steer credential lookups:
      // - agentDir / store: stripped (prevents reading other agents' stores)
      // - profileId / preferredProfile: stripped (prevents cross-provider
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
