import { appendFileSync } from "node:fs";
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

function tracePluginRuntimeStage(stage: string): void {
  const stageLogPath = process.env.OPENCLAW_STAGE_LOG?.trim();
  if (!stageLogPath) {
    return;
  }
  try {
    appendFileSync(stageLogPath, `${new Date().toISOString()} ${stage}\n`);
  } catch {
    // Best-effort tracing only.
  }
}

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
  tracePluginRuntimeStage("plugin-runtime-create-start");
  const version = resolveVersion();
  tracePluginRuntimeStage("plugin-runtime-post-version");
  const config = createRuntimeConfig();
  tracePluginRuntimeStage("plugin-runtime-post-config");
  const subagent = _options.subagent ?? createUnavailableSubagentRuntime();
  tracePluginRuntimeStage("plugin-runtime-post-subagent");
  const system = createRuntimeSystem();
  tracePluginRuntimeStage("plugin-runtime-post-system");
  const media = createRuntimeMedia();
  tracePluginRuntimeStage("plugin-runtime-post-media");
  const tools = createRuntimeTools();
  tracePluginRuntimeStage("plugin-runtime-post-tools");
  const channel = createRuntimeChannel();
  tracePluginRuntimeStage("plugin-runtime-post-channel");
  const events = createRuntimeEvents();
  tracePluginRuntimeStage("plugin-runtime-post-events");
  const logging = createRuntimeLogging();
  tracePluginRuntimeStage("plugin-runtime-post-logging");
  const runtime = {
    version,
    config,
    subagent,
    system,
    media,
    tts: { textToSpeechTelephony },
    stt: { transcribeAudioFile },
    tools,
    channel,
    events,
    logging,
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

  tracePluginRuntimeStage("plugin-runtime-create-done");
  return runtime;
}

export type { PluginRuntime } from "./types.js";
