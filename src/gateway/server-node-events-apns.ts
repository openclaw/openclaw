import { normalizeOptionalString } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { NodeEventContext } from "./server-node-events-types.js";

export type NodeApnsRegistrationAuthority = {
  resolveApnsRegistrationGeneration?: () => string | null | Promise<string | null>;
  assertApnsRegistrationCurrent?: () => void;
};

export async function registerNodeApnsEvent(
  ctx: Pick<NodeEventContext, "logGateway">,
  nodeId: string,
  obj: Record<string, unknown>,
  authority: NodeApnsRegistrationAuthority | undefined,
  dependencies: {
    ApnsRegistrationPairingChangedError: typeof import("../infra/push-apns-store.errors.js").ApnsRegistrationPairingChangedError;
    registerApnsRegistration: typeof import("../infra/push-apns-store.js").registerApnsRegistration;
    loadOrCreateProcessDeviceIdentity: () => { deviceId: string };
    formatForLog: (value: unknown) => string;
  },
): Promise<"pairing-changed" | undefined> {
  const {
    ApnsRegistrationPairingChangedError,
    registerApnsRegistration,
    loadOrCreateProcessDeviceIdentity,
    formatForLog,
  } = dependencies;
  const transport = normalizeLowercaseStringOrEmpty(obj.transport) || "direct";
  const topic = typeof obj.topic === "string" ? obj.topic : "";
  const environment = obj.environment;
  try {
    const expectedPairingGeneration = await authority?.resolveApnsRegistrationGeneration?.();
    if (!expectedPairingGeneration) {
      ctx.logGateway.warn(
        `push apns register rejected node=${nodeId}: stale or invalidated pairing session`,
      );
      return "pairing-changed";
    }
    if (transport === "relay") {
      const gatewayDeviceId = normalizeOptionalString(obj.gatewayDeviceId) ?? "";
      const currentGatewayDeviceId = loadOrCreateProcessDeviceIdentity().deviceId;
      if (!gatewayDeviceId || gatewayDeviceId !== currentGatewayDeviceId) {
        ctx.logGateway.warn(
          `push relay register rejected node=${nodeId}: gateway identity mismatch`,
        );
        return undefined;
      }
      await registerApnsRegistration({
        nodeId,
        transport: "relay",
        relayHandle: typeof obj.relayHandle === "string" ? obj.relayHandle : "",
        sendGrant: typeof obj.sendGrant === "string" ? obj.sendGrant : "",
        installationId: typeof obj.installationId === "string" ? obj.installationId : "",
        topic,
        environment,
        distribution: obj.distribution,
        relayOrigin: obj.relayOrigin,
        tokenDebugSuffix: obj.tokenDebugSuffix,
        expectedPairingGeneration,
        ...(authority?.assertApnsRegistrationCurrent
          ? { assertCurrent: authority.assertApnsRegistrationCurrent }
          : {}),
      });
    } else {
      await registerApnsRegistration({
        nodeId,
        transport: "direct",
        token: typeof obj.token === "string" ? obj.token : "",
        topic,
        environment,
        expectedPairingGeneration,
        ...(authority?.assertApnsRegistrationCurrent
          ? { assertCurrent: authority.assertApnsRegistrationCurrent }
          : {}),
      });
    }
  } catch (err) {
    if (err instanceof ApnsRegistrationPairingChangedError) {
      ctx.logGateway.warn(
        `push apns register rejected node=${nodeId}: stale or invalidated pairing session`,
      );
      return "pairing-changed";
    }
    ctx.logGateway.warn(`push apns register failed node=${nodeId}: ${formatForLog(err)}`);
  }
  return undefined;
}
