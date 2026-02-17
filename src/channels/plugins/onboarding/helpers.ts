import type { PromptAccountId, PromptAccountIdParams } from "../onboarding-types.js";
import { promptAccountId as promptAccountIdSdk } from "../../../plugin-sdk/onboarding.js";

export const promptAccountId: PromptAccountId = async (params: PromptAccountIdParams) => {
  return await promptAccountIdSdk(params);
};

export function addWildcardAllowFrom(allowFrom?: Array<string | number> | null): string[] {
  const next = (allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean);
  if (!next.includes("*")) {
    next.push("*");
  }
  return next;
}

export function mergeAllowFromEntries(
  current: Array<string | number> | null | undefined,
  additions: Array<string | number>,
): string[] {
  const merged = [...(current ?? []), ...additions].map((v) => String(v).trim()).filter(Boolean);
  return [...new Set(merged)];
}
