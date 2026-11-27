// Installs OpenClaw-owned transport and diagnostic policy before package helpers;
// direct imports need the same wiring as the process-default stream facade.
import {
  configureAiTransportHost,
  getDefaultAiTransportHost,
  type OpenAIStrictToolRoute,
} from "@openclaw/ai";
import { configureProviderErrorRedactor } from "@openclaw/ai/diagnostics";
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
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  freezeJsonSnapshot,
  isDeeplyFrozenPlainData,
  isPlainData,
} from "../shared/immutable-data.js";
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

function strictToolRouteKey(route: OpenAIStrictToolRoute): string {
  return JSON.stringify([route.provider, route.api, route.baseUrl, route.model]);
}

// The store owns expiry; a process re-reads each route at most hourly, so a long-lived Gateway
// sees an expired record without a store read on every request.
const STRICT_TOOL_REJECTION_REREAD_MS = 60 * 60 * 1000;
const knownStrictToolRejections = new Map<string, { known: Promise<boolean>; readAt: number }>();

// Learned strict-tool rejections reuse core plugin state; a later endpoint upgrade is probed
// again after the TTL, at the cost of one retried request.
async function openStrictToolRejections() {
  const { createCorePluginStateKeyedStore } = await import("../plugin-state/plugin-state-store.js");
  return createCorePluginStateKeyedStore<true>({
    ownerId: "core:ai-transport",
    namespace: "openai-strict-tool-rejections",
    maxEntries: 256,
    defaultTtlMs: 30 * 24 * 60 * 60 * 1000,
  });
}

// The package host is process-wide, so installing its base policy must be too.
// A native SDK graph may load after callers install request capture or overrides.
export function configureAiTransportBaseHost(): { runtime: boolean } {
  return resolveGlobalSingleton(Symbol.for("openclaw.ai.baseTransportHostInstalled"), () => {
    configureAiTransportHost({
      // Another module graph may have already installed the runtime-owned ports.
      ...getDefaultAiTransportHost(),
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
          (scope === "fetch" &&
            (getProviderAuthAuthority(model) || hasGuardedFetchBeforeRequest())),
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
      strictToolRejections: {
        has: (route) => {
          const key = strictToolRouteKey(route);
          const cached = knownStrictToolRejections.get(key);
          if (cached && Date.now() - cached.readAt < STRICT_TOOL_REJECTION_REREAD_MS) {
            return cached.known;
          }
          const known = openStrictToolRejections()
            .then((store) => store.lookup(key))
            .then(Boolean);
          knownStrictToolRejections.set(key, { known, readAt: Date.now() });
          return known;
        },
        record: async (route) => {
          const key = strictToolRouteKey(route);
          knownStrictToolRejections.set(key, { known: Promise.resolve(true), readAt: Date.now() });
          return (await openStrictToolRejections()).registerIfAbsent(key, true);
        },
      },
    });
    return { runtime: false };
  });
}

configureAiTransportBaseHost();
