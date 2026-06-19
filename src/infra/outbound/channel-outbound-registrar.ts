// Owner-scoped registrar for the pin-from-here mirror-dispatcher and echo-admission
// registries. This factory is HOST-INTERNAL on purpose: the gateway issues a
// registrar bound to the AUTHENTICATED channel/plugin id (see server-channels.ts),
// so a plugin receives a registrar it cannot re-bind. It is deliberately NOT part
// of the public plugin-sdk surface — a plugin must never be able to choose its own
// owner string (that would let it spoof another channel, e.g. "telegram").
import {
  registerChannelEchoAdmission,
  unregisterChannelEchoAdmission,
  type ChannelEchoAdmission,
} from "./channel-admission.js";
import {
  registerChannelMirrorDispatcher,
  unregisterChannelMirrorDispatcher,
  type MirrorDispatcher,
} from "./mirror-dispatch.js";

export type ChannelOutboundRegistrar = {
  registerMirrorDispatcher: (accountId: string, dispatcher: MirrorDispatcher) => void;
  unregisterMirrorDispatcher: (accountId: string) => void;
  registerEchoAdmission: (accountId: string, admission: ChannelEchoAdmission) => void;
  unregisterEchoAdmission: (accountId: string) => void;
};

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
