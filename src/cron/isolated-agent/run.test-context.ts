import {
  type ContextTokenResolutionParams,
  resolveAuthoredModelContextTokens,
} from "../../agents/context-resolution.js";

export function createCronContextRuntimeFixture(
  lookup: (params: ContextTokenResolutionParams) => number | undefined,
  lookupBudget = lookup,
) {
  const project = (params: ContextTokenResolutionParams) => ({
    contextTokens: lookup(params),
    authoredContextTokens: resolveAuthoredModelContextTokens(params),
    source: "model" as const,
  });
  return {
    resolveModelContextTokenProjection: project,
    resolveContextTokenBudgetForModel: async (params: ContextTokenResolutionParams) => ({
      ...project(params),
      contextTokens: lookupBudget(params),
    }),
  };
}
