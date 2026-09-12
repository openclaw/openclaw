import { readCapabilityConsentErrorDetails } from "../../packages/gateway-protocol/src/capability-consent-error-details.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type {
  PluginsInspectResult,
  PluginsReloadResult,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import { callGateway } from "../gateway/call.js";
import { readActiveGatewayLockIdentity } from "../infra/gateway-lock.js";
import type { PluginCapabilityConsentHandler } from "../plugins/capability-consent.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";

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
        return result.warnings?.length
          ? { ...result.runtime, warnings: result.warnings }
          : result.runtime;
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
  const owner = await readActiveGatewayLockIdentity();
  if (!owner) {
    return null;
  }
  const request = <T>(method: string, params: Record<string, unknown>) =>
    callGateway<T>({
      method,
      params,
      localPortOverride: owner.port,
      ignoreEnvUrlOverride: true,
      requiredMethods: [...new Set([method, "plugins.reload"])],
      timeoutMs: 600_000,
      scopes: ["operator.admin"],
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    });
  return async <T>(
    method: string,
    params: Record<string, unknown>,
    onCapabilityConsent?: PluginCapabilityConsentHandler,
  ) => {
    try {
      return await request<T>(method, params);
    } catch (error) {
      const consent = readCapabilityConsentErrorDetails(
        error instanceof Error && "details" in error ? error.details : undefined,
      );
      if (!consent || !onCapabilityConsent) {
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
      // Only consent rejection is retryable. Connection failure is never proof of offline state.
      return await request<T>(method, { ...params, acknowledgeCapabilities });
    }
  };
}
