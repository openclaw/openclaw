/**
 * Host-only binding between an executing context and the delegated task lineage
 * it belongs to.
 *
 * Ownership is task-scoped. An execution inherits delegated ownership only when
 * the Host proves the relation by binding this brand onto the exact context
 * object the runtime carries. Module state, plugin data, model output, session
 * keys, and tool arguments can never produce it, and unrelated runs that merely
 * share a user, agent, workspace, Gateway, or session stay DIRECT.
 */
import { readCurrentDelegatedExecutionLineage } from "./delegated-execution-scope.js";

const DELEGATED_EXECUTION_LINEAGE = Symbol("openclaw.delegatedExecutionLineage");

/** Binds the delegated task lineage an execution belongs to. Host-only by construction. */
export function bindDelegatedExecutionLineage(context: object, lineageRef: string): void {
  if (typeof lineageRef !== "string" || lineageRef.length === 0) {
    throw new Error("delegated execution lineage must be a non-empty reference");
  }
  Object.defineProperty(context, DELEGATED_EXECUTION_LINEAGE, {
    value: lineageRef,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

/** Reads a Host-bound lineage. Returns undefined when no relation is proven. */
export function readDelegatedExecutionLineage(context: unknown): string | undefined {
  if (typeof context !== "object" || context === null) {
    return undefined;
  }
  const value = Reflect.get(context, DELEGATED_EXECUTION_LINEAGE);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const DELEGATED_EXECUTION_FALLBACK_AUTHORITY = Symbol(
  "openclaw.delegatedExecutionFallbackAuthority",
);

/**
 * Carries the live trusted-human fallback authority the Host minted for one
 * authorized fallback run. Branded like the lineage: only Host code can attach
 * it, and the authority re-checks its own liveness on every use.
 */
export function bindDelegatedExecutionFallbackAuthority(context: object, authority: unknown): void {
  Object.defineProperty(context, DELEGATED_EXECUTION_FALLBACK_AUTHORITY, {
    value: authority,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

/** Reads a Host-bound fallback authority, if this execution carries one. */
export function readDelegatedExecutionFallbackAuthority(context: unknown): unknown {
  if (typeof context !== "object" || context === null) {
    return undefined;
  }
  return Reflect.get(context, DELEGATED_EXECUTION_FALLBACK_AUTHORITY);
}

/** The fallback authority carried by an execution, or undefined. */
export function resolveDelegatedExecutionFallbackAuthority(
  contexts: readonly (unknown | undefined)[],
): unknown {
  for (const context of contexts) {
    const authority = readDelegatedExecutionFallbackAuthority(context);
    if (authority !== undefined) {
      return authority;
    }
  }
  return undefined;
}

/**
 * First proven lineage across the contexts one execution may legitimately
 * carry, then the Host-owned delegated execution scope the execution is running
 * inside. A Host context binding wins over the ambient scope; unrelated
 * execution that has neither stays DIRECT.
 */
export function resolveDelegatedExecutionLineage(
  contexts: readonly (unknown | undefined)[],
): string | undefined {
  for (const context of contexts) {
    const lineageRef = readDelegatedExecutionLineage(context);
    if (lineageRef) {
      return lineageRef;
    }
  }
  return readCurrentDelegatedExecutionLineage();
}
