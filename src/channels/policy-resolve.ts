import type { DmPolicy, GroupPolicy } from "../config/types.base.js";

type ResolveDmPolicyParams = {
  accountPolicy?: DmPolicy;
  channelPolicy?: DmPolicy;
  legacyPolicy?: DmPolicy;
  defaultPolicy: DmPolicy;
};

export function resolveDmPolicy(params: ResolveDmPolicyParams): DmPolicy {
  return (
    params.accountPolicy ?? params.channelPolicy ?? params.legacyPolicy ?? params.defaultPolicy
  );
}

type ResolveGroupPolicyParams = {
  accountPolicy?: GroupPolicy;
  channelPolicy?: GroupPolicy;
  defaultPolicy: GroupPolicy;
};

export function resolveGroupPolicy(params: ResolveGroupPolicyParams): GroupPolicy {
  return params.accountPolicy ?? params.channelPolicy ?? params.defaultPolicy;
}
