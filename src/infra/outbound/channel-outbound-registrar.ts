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
  registerMirrorDispatcher: (
    channel: string,
    accountId: string,
    dispatcher: MirrorDispatcher,
  ) => void;
  unregisterMirrorDispatcher: (channel: string, accountId: string) => void;
  registerEchoAdmission: (
    channel: string,
    accountId: string,
    admission: ChannelEchoAdmission,
  ) => void;
  unregisterEchoAdmission: (channel: string, accountId: string) => void;
};

/**
 * Create an owner-scoped registrar. `owner` MUST be the host's authenticated
 * channel/plugin id — callers (plugins) never supply it themselves. The registrar
 * binds it so a plugin can only register, replace, or unregister entries it owns
 * and can never touch another channel/account's mirror or admission handler.
 */
export function createChannelOutboundRegistrar(owner: string): ChannelOutboundRegistrar {
  return {
    registerMirrorDispatcher: (channel, accountId, dispatcher) =>
      registerChannelMirrorDispatcher(owner, channel, accountId, dispatcher),
    unregisterMirrorDispatcher: (channel, accountId) =>
      unregisterChannelMirrorDispatcher(owner, channel, accountId),
    registerEchoAdmission: (channel, accountId, admission) =>
      registerChannelEchoAdmission(owner, channel, accountId, admission),
    unregisterEchoAdmission: (channel, accountId) =>
      unregisterChannelEchoAdmission(owner, channel, accountId),
  };
}
