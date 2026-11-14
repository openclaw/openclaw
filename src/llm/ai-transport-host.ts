// Installs OpenClaw-owned transport and diagnostic policy before package helpers;
// direct imports need the same wiring as the process-default stream facade.
import { configureAiTransportHost, getDefaultAiTransportHost } from "@openclaw/ai";
import { configureProviderErrorRedactor } from "@openclaw/ai/diagnostics";
import { resolveOpenAIStrictToolSetting } from "../agents/openai-strict-tool-setting.js";
import { unwrapModelHeaderSentinelsForProviderEgress } from "../agents/provider-secret-egress.js";
import {
  buildGuardedModelFetch,
  resolveModelRequestTimeoutMs,
} from "../agents/provider-transport-fetch.js";
import { redactSecrets, redactToolPayloadText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAnthropicInlineContentBlocks } from "../media/anthropic-inline-images.js";
import { swapSecretSentinelsInText } from "../secrets/sentinel.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { formatModelTransportContext } from "./model-transport-context.js";

const transportLogBySubsystem = new Map<string, ReturnType<typeof createSubsystemLogger>>();

// Error projection is module-local, unlike the process-shared transport host.
configureProviderErrorRedactor(redactSecrets);

function transportLog(subsystem: string): ReturnType<typeof createSubsystemLogger> {
  let log = transportLogBySubsystem.get(subsystem);
  if (!log) {
    log = createSubsystemLogger(subsystem);
    transportLogBySubsystem.set(subsystem, log);
  }
  return log;
}

// The package host is process-wide, so installing its base policy must be too.
// A native SDK graph may load after callers install request capture or overrides.
resolveGlobalSingleton(Symbol.for("openclaw.ai.baseTransportHostInstalled"), () => {
  configureAiTransportHost({
    // Another module graph may have already installed the runtime-owned ports.
    ...getDefaultAiTransportHost(),
    runInDetachedAsyncContext,
    observePendingProviderWork: (pending) => {
      void trackAsyncWork(() => pending).catch(() => {});
    },
    buildModelFetch: buildGuardedModelFetch,
    unwrapModelTransportSentinels: unwrapModelHeaderSentinelsForProviderEgress,
    resolveSecretSentinel: (value) => {
      const swapped = swapSecretSentinelsInText(value);
      const unknown = swapped.unknown[0];
      if (unknown) {
        throw new Error(
          `Secret sentinel ${unknown} is not registered in this process; refusing to construct provider client`,
        );
      }
      return swapped.text;
    },
    redactToolPayloadText,
    normalizeAnthropicInlineContentBlocks,
    resolveOpenAIStrictToolSetting,
    resolveModelRequestTimeoutMs: (model) => resolveModelRequestTimeoutMs(model, undefined),
    logDebug: (subsystem, build) => {
      const log = transportLog(subsystem);
      if (!log.isEnabled("debug", "any")) {
        return;
      }
      const entry = build();
      if (entry) {
        log.debug(entry.message + formatModelTransportContext(), entry.data);
      }
    },
    logInfo: (subsystem, message, data) =>
      transportLog(subsystem).info(message + formatModelTransportContext(), data),
    logWarn: (subsystem, message, data) =>
      transportLog(subsystem).warn(message + formatModelTransportContext(), data),
  });
  return true;
});
