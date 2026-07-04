// Streams LLM responses through registered providers and normalizes events.
// This facade owns the process-default AI runtime wiring: it installs the
// OpenClaw host policy ports and registers built-in providers exactly once,
// before any caller imports the stream API.
import { configureAiTransportHost } from "@openclaw/ai";
import { defaultApiRegistry } from "@openclaw/ai/internal/runtime";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { resolveOpenAIStrictToolSetting } from "../agents/openai-strict-tool-setting.js";
import { buildGuardedModelFetch } from "../agents/provider-transport-fetch.js";
import { redactSecrets, redactToolPayloadText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const transportLogBySubsystem = new Map<string, ReturnType<typeof createSubsystemLogger>>();

function transportLog(subsystem: string): ReturnType<typeof createSubsystemLogger> {
  let log = transportLogBySubsystem.get(subsystem);
  if (!log) {
    log = createSubsystemLogger(subsystem);
    transportLogBySubsystem.set(subsystem, log);
  }
  return log;
}

configureAiTransportHost({
  buildModelFetch: buildGuardedModelFetch,
  redactSecrets,
  redactToolPayloadText,
  resolveOpenAIStrictToolSetting,
  logDebug: (subsystem, build) => {
    const log = transportLog(subsystem);
    if (!log.isEnabled("debug", "any")) {
      return;
    }
    const entry = build();
    if (entry) {
      log.debug(entry.message, entry.data);
    }
  },
});
registerBuiltInApiProviders(defaultApiRegistry);

export {
  complete,
  completeSimple,
  getEnvApiKey,
  stream,
  streamSimple,
} from "@openclaw/ai/internal/runtime";
