// Narrow plugin-sdk surface for the bundled mqtt-hooks plugin.
// Keep this list additive and scoped to symbols used under extensions/mqtt-hooks.

export { createDedupeCache } from "../infra/dedupe.js";
export {
  dispatchAgentIngressAction,
  dispatchWakeIngressAction,
} from "../gateway/ingress-dispatch.js";
export type { IngressAgentDispatchResult } from "../gateway/ingress-dispatch.js";
export {
  renderIngressTemplate,
  renderOptionalIngressTemplate,
} from "../gateway/ingress-template.js";
export {
  getIngressAgentPolicyError as getHookAgentPolicyError,
  getIngressSessionKeyPrefixError as getHookSessionKeyPrefixError,
  getIngressSessionKeyRequestPolicyError as getHookSessionKeyRequestPolicyError,
  isIngressAgentAllowed as isHookAgentAllowed,
  normalizeIngressDispatchSessionKey as normalizeHookDispatchSessionKey,
  resolveIngressDispatchPolicies as resolveHookIngressPolicies,
  resolveIngressSessionKey as resolveHookSessionKey,
  resolveIngressTargetAgentId as resolveHookTargetAgentId,
} from "../gateway/ingress-policy.js";
export { getHookChannelError, resolveHookChannel, resolveHookDeliver } from "../gateway/hooks.js";
export type { HookAgentDispatchPayload, HookMessageChannel } from "../gateway/hooks.js";
export type { IngressDispatchPoliciesResolved } from "../gateway/ingress-policy.js";
export type { OpenClawConfig } from "../config/config.js";
export type {
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "../plugins/types.js";
