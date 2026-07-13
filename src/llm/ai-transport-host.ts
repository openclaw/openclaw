// Installs OpenClaw-owned policy ports before package providers or shared
// transport helpers run. Direct transport imports need the same wiring as the
// process-default stream facade.
import { configureAiTransportHost } from "@openclaw/ai";
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
