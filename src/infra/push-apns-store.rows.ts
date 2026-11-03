import type { Insertable } from "kysely";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { ApnsRegistration, RelayApnsRegistration } from "./push-apns-store.types.js";

type ApnsRegistrationInsert = Insertable<DB["apns_registrations"]>;

export function apnsRegistrationToRow(registration: ApnsRegistration): ApnsRegistrationInsert {
  const direct = registration.transport === "direct";
  return {
    node_id: registration.nodeId,
    transport: registration.transport,
    topic: registration.topic,
    environment: registration.environment,
    updated_at_ms: registration.updatedAtMs,
    token: direct ? registration.token : null,
    relay_handle: direct ? null : registration.relayHandle,
    send_grant: direct ? null : registration.sendGrant,
    installation_id: direct ? null : registration.installationId,
    relay_origin: direct ? null : (registration.relayOrigin ?? null),
    distribution: direct ? null : registration.distribution,
    token_debug_suffix: direct ? null : (registration.tokenDebugSuffix ?? null),
    relay_rejection_reason: direct ? null : (registration.relayRejection?.reason ?? null),
  };
}

/** Publication time and diagnostic suffixes do not create a new enrollment. */
export function sameRelayEnrollment(
  left: RelayApnsRegistration,
  right: RelayApnsRegistration,
): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.relayHandle === right.relayHandle &&
    left.sendGrant === right.sendGrant &&
    left.installationId === right.installationId &&
    left.relayOrigin === right.relayOrigin &&
    left.topic === right.topic &&
    left.environment === right.environment &&
    left.distribution === right.distribution
  );
}
