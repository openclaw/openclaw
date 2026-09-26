import type { Insertable } from "kysely";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { ApnsRegistration } from "./push-apns-store.types.js";

type ApnsRegistrationInsert = Insertable<DB["apns_registrations"]>;

export function apnsRegistrationToRow(registration: ApnsRegistration): ApnsRegistrationInsert {
  const base = {
    node_id: registration.nodeId,
    transport: registration.transport,
    topic: registration.topic,
    environment: registration.environment,
    updated_at_ms: registration.updatedAtMs,
  };
  if (registration.transport === "direct") {
    const { token } = registration;
    return {
      ...base,
      token,
      relay_handle: null,
      send_grant: null,
      installation_id: null,
      relay_origin: null,
      distribution: null,
      token_debug_suffix: null,
    };
  }
  return {
    ...base,
    token: null,
    relay_handle: registration.relayHandle,
    send_grant: registration.sendGrant,
    installation_id: registration.installationId,
    relay_origin: registration.relayOrigin ?? null,
    distribution: registration.distribution,
    token_debug_suffix: registration.tokenDebugSuffix ?? null,
  };
}
