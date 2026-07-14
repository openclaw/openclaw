import type { ToolErrorSummary } from "./tool-error-summary.js";
import { isSameToolMutationAction } from "./tool-mutation.js";

const unresolvedMutations = Symbol("openclaw.unresolvedToolMutations");

// Enumerable symbols survive internal object spreads without entering JSON,
// logs, or the public ToolErrorSummary string-key surface.
type UnresolvedMutationState = ToolErrorSummary & {
  [unresolvedMutations]?: ToolErrorSummary[];
};

function listUnresolvedMutations(current: ToolErrorSummary | undefined): ToolErrorSummary[] {
  if (current?.mutatingAction !== true) {
    return [];
  }
  const { [unresolvedMutations]: pending = [], ...latest } = current as UnresolvedMutationState;
  return [...pending, latest];
}

function packUnresolvedMutations(entries: ToolErrorSummary[]): ToolErrorSummary | undefined {
  const latest = entries.at(-1);
  if (!latest) {
    return undefined;
  }
  const pending = entries.slice(0, -1);
  const state: UnresolvedMutationState = {
    ...latest,
  };
  if (pending.length > 0) {
    state[unresolvedMutations] = pending;
  }
  return state;
}

/** Merge a failure without dropping older distinct unresolved mutations. */
export function mergeUnresolvedMutationError(
  next: ToolErrorSummary,
  current: ToolErrorSummary | undefined,
): ToolErrorSummary {
  if (next.mutatingAction !== true) {
    return current?.mutatingAction ? current : next;
  }
  const entries = listUnresolvedMutations(current);
  const sameIndex = entries.findIndex((entry) => isSameToolMutationAction(entry, next));
  if (sameIndex >= 0) {
    entries.splice(sameIndex, 1);
  }
  entries.push(next);
  return packUnresolvedMutations(entries) ?? next;
}

/** Clear only the mutation matched by a successful action. */
export function resolveSuccessfulToolMutation(
  current: ToolErrorSummary | undefined,
  success: Pick<ToolErrorSummary, "toolName" | "meta" | "actionFingerprint" | "fileTarget">,
): ToolErrorSummary | undefined {
  const remaining = listUnresolvedMutations(current).filter(
    (entry) => !isSameToolMutationAction(entry, success),
  );
  return packUnresolvedMutations(remaining);
}
