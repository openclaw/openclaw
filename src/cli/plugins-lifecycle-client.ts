import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readCapabilityConsentErrorDetails } from "../../packages/gateway-protocol/src/capability-consent-error-details.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type {
  PluginsInspectResult,
  PluginsReloadResult,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import { sleepWithAbort } from "../infra/backoff.js";
import { readActiveGatewayLockIdentity } from "../infra/gateway-lock.js";
import type { PluginCapabilityConsentHandler } from "../plugins/capability-consent.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import { createDeferredCore } from "../shared/deferred.js";
import { monotonicNow } from "../shared/monotonic-time.js";
import { registerSignalExitGate } from "./signal-exit-barrier.js";

/** Capture the local client before a Template batch takes any package or plugin lease. */
export async function resolvePluginBatchReload(): Promise<PluginInstallBatchReload | undefined> {
  const gateway = await resolvePluginLifecycleGateway();
  return gateway
    ? async (plugins, options) => {
        const result = await gateway<PluginsReloadResult>("plugins.reload", {
          plugins,
        });
        if (!result.runtime) {
          throw new Error(
            "Gateway did not confirm the plugin batch runtime generation. Inspect plugin status before retrying.",
          );
        }
        options?.commitGuard?.();
        return {
          ...result.runtime,
          ...(result.restartRequired ? { restartRequired: true } : {}),
          ...(result.warnings?.length ? { warnings: result.warnings } : {}),
        };
      }
    : undefined;
}

export type PluginLifecycleGateway = <T>(
  method: string,
  params: Record<string, unknown>,
  onCapabilityConsent?: PluginCapabilityConsentHandler,
) => Promise<T>;

/** Select the local runtime owner before acquiring a lease the Gateway also needs. */
export async function resolvePluginLifecycleGateway(): Promise<PluginLifecycleGateway | null> {
  const owner = await readActiveGatewayLockIdentity({ requireInspection: true });
  if (!owner) {
    return null;
  }
  const { callGateway } = await import("../gateway/call.js");
  const { isGatewayProtocolResponseError } = await import("../gateway/client.js");
  const request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const deadline = monotonicNow() + 600_000;
    const waitForDrain = method === "plugins.reload" && params.waitForDrain === true;
    const controller = new AbortController();
    const finished = createDeferredCore();
    const releaseExitGate = registerSignalExitGate(finished.promise, () => controller.abort());
    try {
      for (;;) {
        try {
          controller.signal.throwIfAborted();
          return await callGateway<T>({
            method,
            params,
            localPortOverride: owner.port,
            ignoreEnvUrlOverride: true,
            requiredMethods: [...new Set([method, "plugins.reload"])],
            timeoutMs: waitForDrain ? null : Math.max(1, deadline - monotonicNow()),
            signal: controller.signal,
            scopes: ["operator.admin"],
            clientName: GATEWAY_CLIENT_NAMES.CLI,
            mode: GATEWAY_CLIENT_MODES.CLI,
          });
        } catch (error) {
          // Release the rejected RPC so reload can drain it; never replay an uncertain effect.
          if (
            !isGatewayProtocolResponseError(error) ||
            error.gatewayCode !== "UNAVAILABLE" ||
            !error.retryable ||
            !isRecord(error.details) ||
            error.details.mutationAccepted !== false ||
            error.retryAfterMs === undefined ||
            error.retryAfterMs <= 0 ||
            error.retryAfterMs >= deadline - monotonicNow()
          ) {
            throw error;
          }
          await sleepWithAbort(error.retryAfterMs, controller.signal);
          if (monotonicNow() >= deadline) {
            throw error;
          }
        }
      }
    } finally {
      finished.resolve();
      releaseExitGate();
    }
  };
  return async <T>(
    method: string,
    params: Record<string, unknown>,
    onCapabilityConsent?: PluginCapabilityConsentHandler,
  ) => {
    const reviewedPluginIds = new Set<string>();
    let requestParams = params;
    for (;;) {
      try {
        return await request<T>(method, requestParams);
      } catch (error) {
        const consent = readCapabilityConsentErrorDetails(
          error instanceof Error && "details" in error ? error.details : undefined,
        );
        if (!consent || !onCapabilityConsent || reviewedPluginIds.has(consent.pluginId)) {
          throw error;
        }
        const { plugin, ...inspection } = await request<PluginsInspectResult>("plugins.inspect", {
          pluginId: consent.pluginId,
        });
        if (!inspection.reviewToken) {
          throw new Error(`Gateway did not return a capability-consent token for "${plugin.id}".`, {
            cause: error,
          });
        }
        const acknowledgeCapabilities = await onCapabilityConsent({
          ...inspection,
          reviewToken: inspection.reviewToken,
          pluginId: plugin.id,
          name: plugin.name,
          ...(plugin.version ? { version: plugin.version } : {}),
          ...(consent.widened ? { widened: consent.widened } : {}),
          ...(consent.acceptedAt ? { acceptedAt: consent.acceptedAt } : {}),
        });
        if (!acknowledgeCapabilities) {
          throw error;
        }
        // A batch can need consent for each package. Never retry a transport failure
        // or a repeated rejection after acknowledging the same plugin.
        reviewedPluginIds.add(consent.pluginId);
        requestParams = { ...params, acknowledgeCapabilities };
      }
    }
  };
}
