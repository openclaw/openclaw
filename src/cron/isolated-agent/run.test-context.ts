import {
  type ContextTokenResolutionParams,
  type ModelContextTokenProjection,
  resolveConfiguredContextTokenLimits,
} from "../../agents/context-resolution.js";

export function createCronContextRuntimeFixture(
  lookup: (params: ContextTokenResolutionParams) => number | undefined,
  lookupBudget: (
    params: ContextTokenResolutionParams,
  ) => number | ModelContextTokenProjection | undefined = lookup,
) {
  const project = (params: ContextTokenResolutionParams) => ({
    contextTokens: lookup(params),
    configuredContextTokenLimits: resolveConfiguredContextTokenLimits(params),
    source: "model" as const,
  });
  return {
    resolveModelContextTokenProjection: project,
    resolveContextTokenBudgetForModel: async (params: ContextTokenResolutionParams) => {
      const budget = lookupBudget(params);
      return typeof budget === "object" ? budget : { ...project(params), contextTokens: budget };
    },
  };
}
