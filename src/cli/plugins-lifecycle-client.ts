import { readCapabilityConsentErrorDetails } from "../../packages/gateway-protocol/src/capability-consent-error-details.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type {
  PluginsInspectResult,
  PluginsReloadResult,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import { readActiveGatewayLockIdentity } from "../infra/gateway-lock.js";
import type { PluginCapabilityConsentHandler } from "../plugins/capability-consent.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import { sleep } from "../utils/sleep.js";

/** Capture the local client before a Claw batch takes any package or plugin lease. */
export async function resolvePluginBatchReload(): Promise<PluginInstallBatchReload | undefined> {
  const gateway = await resolvePluginLifecycleGateway();
  return gateway
    ? async (plugins) => {
        const result = await gateway<PluginsReloadResult>("plugins.reload", {
          plugins,
        });
        if (!result.runtime) {
          throw new Error(
            "Gateway did not confirm the plugin batch runtime generation. Inspect plugin status before retrying.",
          );
        }
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
  const { callGateway, isGatewayClientRequestError } = await import("../gateway/call.js");
  const request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const deadline = Date.now() + 600_000;
    for (;;) {
      try {
        return await callGateway<T>({
          method,
          params,
          localPortOverride: owner.port,
          ignoreEnvUrlOverride: true,
          requiredMethods: [...new Set([method, "plugins.reload"])],
          timeoutMs: Math.max(1, deadline - Date.now()),
          scopes: ["operator.admin"],
          clientName: GATEWAY_CLIENT_NAMES.CLI,
          mode: GATEWAY_CLIENT_MODES.CLI,
        });
      } catch (error) {
        // Lifecycle admission rejects before writes so a config reload can drain
        // the request. Honor that response outside the Gateway's admission scope.
        if (
          !isGatewayClientRequestError(error) ||
          error.gatewayCode !== "UNAVAILABLE" ||
          !error.retryable ||
          error.retryAfterMs === undefined ||
          error.retryAfterMs >= deadline - Date.now()
        ) {
          throw error;
        }
        await sleep(error.retryAfterMs);
        if (Date.now() >= deadline) {
          throw error;
        }
      }
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
        const acknowledgeCapabilities = await onCapabilityConsent({
          ...inspection,
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
