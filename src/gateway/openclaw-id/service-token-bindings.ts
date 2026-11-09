// Publishes the claw record's device-token bindings to the Gateway's token checks:
// while remote access runs, and once at Gateway start whatever the Labs switch says,
// so a restart with the switch off keeps tunnel-issued tokens bound to their
// device key. Only the local claw record is read here.
import type { OpenClawIdAuthority } from "./authority.js";
import {
  setDeviceTokenBindingOwner,
  setDeviceTokenBindingsLoading,
} from "./device-token-binding.js";

/** Publishes device-token bindings from the persisted authority. */
export function createTokenBindingPublisher(params: {
  authority: () => Promise<OpenClawIdAuthority>;
  log: { warn: (message: string) => void };
  /** A read that finishes after the Gateway stopped publishes nothing. */
  closed: () => boolean;
}) {
  // Publishes the binding owner over the claw record's bindings.
  const publish = (owner: OpenClawIdAuthority) => {
    if (params.closed()) {
      return;
    }
    setDeviceTokenBindingOwner({
      lookup: (deviceId, role) => owner.tokenBinding(deviceId, role),
      record: (deviceId, role, peerKey) => owner.bindToken(deviceId, role, peerKey),
      reportMismatch: (event) =>
        params.log.warn(
          `openclaw-id: security: refused device token for ${event.deviceId} (${event.role}) presented from ${event.presentedFrom ?? "a non-tunnel connection"}; bound to ${event.boundTo ?? "no tunnel key"}`,
        ),
    });
  };

  // Publishes saved bindings only; a record that cannot be read refuses every device token.
  const load = async () => {
    try {
      const owner = await params.authority();
      if ((await owner.load())?.token_bindings?.length) {
        publish(owner);
      }
    } catch (error) {
      if (params.closed()) {
        return;
      }
      setDeviceTokenBindingOwner("unreadable");
      params.log.warn(
        `openclaw-id: security: could not read device-token bindings; refusing device tokens until the Gateway restarts or OpenClaw ID turns on: ${String(error)}`,
      );
    }
  };

  return {
    /** Publishes the bindings while remote access runs. */
    publish,
    /** Reads saved bindings at Gateway start; device-token checks wait for it. */
    loadAtStart(): Promise<void> {
      const loaded = load();
      setDeviceTokenBindingsLoading(loaded);
      return loaded;
    },
  };
}
