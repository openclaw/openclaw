import type { ProviderUsageSnapshot, UsageProviderId } from "../../infra/provider-usage.types.js";

export type ProviderUsageStatus = Pick<
  ProviderUsageSnapshot,
  "windows" | "summary" | "plan" | "billing" | "accountEmail"
>;

export type ProfileUsageStatus = ProviderUsageStatus & {
  providerId: UsageProviderId;
};

export function buildProfileUsagePayload(usage: ProfileUsageStatus | undefined) {
  if (!usage) {
    return undefined;
  }
  return {
    providerId: usage.providerId,
    windows: usage.windows,
    ...(usage.summary ? { summary: usage.summary } : {}),
    ...(usage.plan ? { plan: usage.plan } : {}),
    ...(usage.billing?.length ? { billing: usage.billing } : {}),
  };
}
