import type { SecretRef } from "../config/types.secrets.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import {
  normalizeAndGroupSecretRefs,
  secretRefKey,
  type ProviderRefGroup,
} from "./ref-contract.js";
import type { refResolutionError } from "./resolve-errors.js";

export type ProviderRefGroupResult = {
  group: ProviderRefGroup;
  values: Map<string, unknown>;
  refFailures: Map<string, ReturnType<typeof refResolutionError>>;
};

/** Resolves provider groups concurrently and aggregates values and failures by ref. */
export async function resolveProviderGroups(params: {
  refs: SecretRef[];
  errorMode: "continue" | "stop";
  limit: number;
  resolveGroup: (
    group: ProviderRefGroup,
    errorMode: "continue" | "stop",
  ) => Promise<ProviderRefGroupResult>;
}) {
  const groups = normalizeAndGroupSecretRefs(params.refs);
  const errorsByIndex = new Map<number, unknown>();
  const taskResults = await runTasksWithConcurrency({
    tasks: groups.map((group) => async () => params.resolveGroup(group, params.errorMode)),
    limit: params.limit,
    errorMode: params.errorMode,
    onTaskError: (error, index) => {
      errorsByIndex.set(index, error);
    },
  });

  const resolved = new Map<string, unknown>();
  const failures: Array<{ group: ProviderRefGroup; error: unknown }> = [];
  for (const result of taskResults.results) {
    if (!result) {
      continue;
    }
    for (const ref of result.group.refs) {
      const error = result.refFailures.get(ref.id);
      if (error) {
        failures.push({ group: result.group, error });
      } else {
        resolved.set(secretRefKey(ref), result.values.get(ref.id));
      }
    }
  }
  for (const [index, group] of groups.entries()) {
    if (errorsByIndex.has(index)) {
      failures.push({ group, error: errorsByIndex.get(index) });
    }
  }
  return {
    resolved,
    failures,
    hasError: taskResults.hasError,
    firstError: taskResults.firstError,
  };
}
