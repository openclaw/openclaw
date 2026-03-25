// Narrow SSRF helpers for extensions that need pinned-dispatcher and policy
// utilities without loading the full infra-runtime surface.

export {
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";
export {
  assertHttpUrlTargetsPrivateNetwork,
  ssrfPolicyFromAllowPrivateNetwork,
} from "./ssrf-policy.js";
