// Repo-local (NON-public) channel-outbound internals: the pin-from-here mirror
// dispatcher + echo-admission registries.
//
// These are global, last-wins registries keyed by caller-provided
// `(channel, accountId)` strings with no per-plugin ownership enforcement, so a
// caller could replace or unregister another channel's handler. They are
// therefore NOT part of the public plugin SDK contract: in-repo channel
// extensions (e.g. telegram) register through this internal subpath, which is
// listed in `scripts/lib/plugin-sdk-private-local-only-subpaths.json` so it never
// enters the public export map. Promote to a public, owner-scoped registrar only
// with maintainer sign-off.
export {
  registerChannelMirrorDispatcher,
  unregisterChannelMirrorDispatcher,
  type MirrorDispatcher,
} from "../infra/outbound/mirror-dispatch.js";
export {
  registerChannelEchoAdmission,
  unregisterChannelEchoAdmission,
  type ChannelEchoAdmission,
} from "../infra/outbound/channel-admission.js";
