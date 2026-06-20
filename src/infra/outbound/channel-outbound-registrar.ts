// Owner-scoped registrar for the pin-from-here mirror-dispatcher and echo-admission
// registries. This factory is HOST-INTERNAL on purpose: the gateway issues a
// registrar bound to the AUTHENTICATED channel/plugin id (see server-channels.ts),
// so a plugin receives a registrar it cannot re-bind. It is deliberately NOT part
// of the public plugin-sdk surface — a plugin must never be able to choose its own
// owner string (that would let it spoof another channel, e.g. "telegram").
import {
  registerChannelEchoAdmission,
  unregisterChannelEchoAdmission,
} from "./channel-admission.js";
import type { ChannelOutboundRegistrar } from "./channel-outbound-registrar.types.js";
import {
  registerChannelMirrorDispatcher,
  unregisterChannelMirrorDispatcher,
} from "./mirror-dispatch.js";

// The type lives in the leaf module (./channel-outbound-registrar.types.js) so type
// consumers like ChannelGatewayContext don't pull this factory's value imports (the
// outbound delivery pipeline) into a module cycle; re-exported here for convenience.
export type { ChannelOutboundRegistrar };

/**
 * Create a registrar bound to the host's AUTHENTICATED `channel` id. Both the
 * registry's owner key AND its channel key are this bound id — callers never supply
 * either, so a plugin can only register/replace/unregister mirror+admission handlers
 * for its OWN channel and can never spoof or touch another channel/account's entry.
 */
export function createChannelOutboundRegistrar(channel: string): ChannelOutboundRegistrar {
  return {
    registerMirrorDispatcher: (accountId, dispatcher) =>
      registerChannelMirrorDispatcher(channel, channel, accountId, dispatcher),
    unregisterMirrorDispatcher: (accountId) =>
      unregisterChannelMirrorDispatcher(channel, channel, accountId),
    registerEchoAdmission: (accountId, admission) =>
      registerChannelEchoAdmission(channel, channel, accountId, admission),
    unregisterEchoAdmission: (accountId) =>
      unregisterChannelEchoAdmission(channel, channel, accountId),
  };
}
