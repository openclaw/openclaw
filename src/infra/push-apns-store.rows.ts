import type { Insertable } from "kysely";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { ApnsRegistration } from "./push-apns-store.types.js";

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
  };
}
