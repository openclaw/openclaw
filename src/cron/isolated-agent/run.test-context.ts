import {
  type ContextTokenResolutionParams,
  type ModelContextTokenProjection,
  resolveAuthoredModelContextTokens,
} from "../../agents/context-resolution.js";

export function createCronContextRuntimeFixture(
  lookup: (params: ContextTokenResolutionParams) => number | undefined,
  lookupBudget: (
    params: ContextTokenResolutionParams,
  ) => number | ModelContextTokenProjection | undefined = lookup,
) {
  const project = (params: ContextTokenResolutionParams) => ({
    contextTokens: lookup(params),
    authoredContextTokens: resolveAuthoredModelContextTokens(params),
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
