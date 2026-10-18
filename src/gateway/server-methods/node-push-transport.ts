import { getRuntimeConfig } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type loadApnsRegistration,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
} from "../../infra/push-apns.js";

export async function resolveNodePushTransport(
  registration: NonNullable<Awaited<ReturnType<typeof loadApnsRegistration>>>,
  cfg?: OpenClawConfig,
) {
  // Relay registrations must not read local APNs signing material.
  if (registration.transport === "relay") {
    const relay = resolveApnsRelayConfigFromEnv(process.env, (cfg ?? getRuntimeConfig()).gateway, {
      registrationRelayOrigin: registration.relayOrigin,
    });
    return relay.ok
      ? { ok: true as const, transport: { registration, relayConfig: relay.value } }
      : { ok: false as const, error: relay.error };
  }
  const auth = await resolveApnsAuthConfigFromEnv(process.env);
  return auth.ok
    ? { ok: true as const, transport: { registration, auth: auth.value } }
    : { ok: false as const, error: auth.error };
}
