// Repo-local (NON-public) channel-outbound internals: the pin-from-here mirror
// dispatcher + echo-admission registries.
//
// These are global, last-wins registries keyed by caller-provided
// `(channel, accountId)` strings with no per-plugin ownership enforcement, so a
// caller could replace or unregister another channel's handler. They are
// therefore kept OFF the public `channel-outbound` contract: in-repo channel
// extensions (e.g. telegram) register through this dedicated subpath, which is
// tracked in `scripts/lib/plugin-sdk-deprecated-public-subpaths.json` — resolvable
// by bundled extensions but flagged as a bundled-maintenance seam, not a
// recommended contract for new third-party plugins. Promote to a stable,
// owner-scoped public registrar only with maintainer sign-off.
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
