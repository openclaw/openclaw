/**
 * Host-owned delegated lineage propagation to child/subagent execution.
 *
 * A child inherits delegated ownership only when the Host proves the relation:
 * the parent execution carries a Host-bound delegated lineage (an explicit
 * Host-bound parent capability, or the Host-owned delegated execution scope it
 * is running inside). A plain id or string never produces the relation, and a
 * parent with no delegated lineage produces none for the child.
 */
import { bindDelegatedExecutionLineage } from "./delegated-execution-lineage.js";
import { readDelegatedExecutionLineage } from "./delegated-execution-lineage.js";
import { readCurrentDelegatedExecutionLineage } from "./delegated-execution-scope.js";

const parentDelegatedLineages = new WeakMap<object, string>();

/**
 * Host-only: stamps the parent's proven delegated lineage onto a spawn request
 * so the child side can read it. Mirrors the execution-identity carrier: the
 * value lives in a private WeakMap keyed by the exact object, never on the
 * public request shape.
 */
export function withParentDelegatedExecutionLineage<T extends object>(
  context: T,
  lineageRef: string | undefined,
): T {
  if (!lineageRef) {
    return context;
  }
  const carried = { ...context };
  parentDelegatedLineages.set(carried, lineageRef);
  return carried;
}

/** Reads the Host-bound parent lineage carried by a spawn request. */
export function readParentDelegatedExecutionLineage(context: object): string | undefined {
  const value = parentDelegatedLineages.get(context);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The delegated lineage a child inherits from its parent, if any. The relation
 * comes from a Host-bound parent capability or the Host-owned delegated scope,
 * never from ambient ids or caller-supplied strings.
 */
export function resolveChildDelegatedExecutionLineage(
  parentContext: object | undefined,
): string | undefined {
  const bound = parentContext ? readDelegatedExecutionLineage(parentContext) : undefined;
  if (bound) {
    return bound;
  }
  if (parentContext) {
    const carried = readParentDelegatedExecutionLineage(parentContext);
    if (carried) {
      return carried;
    }
  }
  return readCurrentDelegatedExecutionLineage();
}

/**
 * Binds the parent's delegated lineage onto the child execution context. Returns
 * the inherited lineage, or undefined when the parent has no delegated lineage
 * (an unrelated child stays DIRECT).
 */
export function inheritDelegatedExecutionLineageForChild(params: {
  parentContext?: object;
  childContext: object;
}): string | undefined {
  const lineageRef = resolveChildDelegatedExecutionLineage(params.parentContext);
  if (!lineageRef) {
    return undefined;
  }
  bindDelegatedExecutionLineage(params.childContext, lineageRef);
  return lineageRef;
}
