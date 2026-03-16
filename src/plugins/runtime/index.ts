import { createRequire } from "node:module";
import {
  getApiKeyForModel as getApiKeyForModelRaw,
  resolveApiKeyForProvider as resolveApiKeyForProviderRaw,
} from "../../agents/model-auth.js";
import { resolveStateDir } from "../../config/paths.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver-runtime.js";
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

export type CreatePluginRuntimeOptions = {
  subagent?: PluginRuntime["subagent"];
};

export function createPluginRuntime(_options: CreatePluginRuntimeOptions = {}): PluginRuntime {
  const runtime = {
    version: resolveVersion(),
    config: createRuntimeConfig(),
    subagent: _options.subagent ?? createUnavailableSubagentRuntime(),
    outbound: {
      deliverOutboundPayloads: (params) => {
        // Strip internal-only fields at runtime so JS/CJS plugins cannot bypass safeguards.
        const {
          skipQueue: _sq,
          mirror: _mi,
          session: _se,
          deps: _de,
          ...publicParams
        } = params as Record<string, unknown>;
        return deliverOutboundPayloads(
          publicParams as Parameters<typeof deliverOutboundPayloads>[0],
        );
      },
    },
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
