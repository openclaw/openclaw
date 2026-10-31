// Installs OpenClaw-owned transport and diagnostic policy before package helpers;
// direct imports need the same wiring as the process-default stream facade.
import { configureAiTransportHost } from "@openclaw/ai";
import { configureProviderErrorRedactor } from "@openclaw/ai/diagnostics";
import { resolveOpenAIStrictToolSetting } from "../agents/openai-strict-tool-setting.js";
import { getModelProviderLocalService } from "../agents/provider-local-service.js";
import { getModelProviderRequestTransport } from "../agents/provider-request-config.js";
import { unwrapModelHeaderSentinelsForProviderEgress } from "../agents/provider-secret-egress.js";
import {
  buildGuardedModelFetch,
  resolveModelRequestTimeoutMs,
} from "../agents/provider-transport-fetch.js";
import { hasGuardedFetchBeforeRequest } from "../infra/net/fetch-request-authority.js";
import { redactSecrets, redactToolPayloadText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAnthropicInlineContentBlocks } from "../media/anthropic-inline-images.js";
import { getProviderAuthAuthority } from "../plugins/provider-auth-authority.js";
import { swapSecretSentinelsInText } from "../secrets/sentinel.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import {
  freezeJsonSnapshot,
  isDeeplyFrozenPlainData,
  isPlainData,
} from "../shared/immutable-data.js";
import { formatModelTransportContext } from "./model-transport-context.js";

const transportLogBySubsystem = new Map<string, ReturnType<typeof createSubsystemLogger>>();

configureProviderErrorRedactor(redactSecrets);

function transportLog(subsystem: string): ReturnType<typeof createSubsystemLogger> {
  let log = transportLogBySubsystem.get(subsystem);
  if (!log) {
    log = createSubsystemLogger(subsystem);
    transportLogBySubsystem.set(subsystem, log);
  }
  return log;
}

configureAiTransportHost({
  immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData, isPlainData },
  runInDetachedAsyncContext,
  observePendingProviderWork: (pending) => {
    void trackAsyncWork(() => pending).catch(() => {});
  },
  buildModelFetch: buildGuardedModelFetch,
  // Public SDK adapters can invoke built-ins before the agent/plugin runtime host loads.
  requiresManagedTransport: (model, scope) => {
    const request = getModelProviderRequestTransport(model);
    return Boolean(
      request?.proxy ||
      request?.tls ||
      getModelProviderLocalService(model) ||
      // Request-owned Access checks must also survive asynchronous payload preparation.
      (scope === "fetch" && (getProviderAuthAuthority(model) || hasGuardedFetchBeforeRequest())),
    );
  },
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
  isLogEnabled: (subsystem, level) => transportLog(subsystem).isEnabled(level, "any"),
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
  logInfo: (subsystem, message, data) => {
    const log = transportLog(subsystem);
    if (log.isEnabled("info")) {
      log.info(
        message +
          formatModelTransportContext(
            data?.requestId !== undefined ? "clientRequestId" : "requestId",
          ),
        data,
      );
    }
  },
  logWarn: (subsystem, message, data) => {
    const log = transportLog(subsystem);
    if (log.isEnabled("warn")) {
      log.warn(
        message +
          formatModelTransportContext(
            data?.requestId !== undefined ? "clientRequestId" : "requestId",
          ),
        data,
      );
    }
  },
});
