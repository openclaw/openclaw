import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export const artifactPreservingReads = resolveGlobalSingleton(
  Symbol.for("openclaw.artifactPreservingStateReads"),
  () => new AsyncLocalStorage<{ agentDatabases: boolean } | false>(),
);

/** Admission scopes every nested reader without changing normal live-read semantics. */
export function withArtifactPreservingStateReads<T>(
  operation: () => T,
  // Inspection may copy agents; repair readers still need their source identity for commit guards.
  options: { agentDatabases?: true } = {},
): T {
  return artifactPreservingReads.run(
    { agentDatabases: options.agentDatabases === true || isArtifactPreservingStateRead("agent") },
    operation,
  );
}

export function isArtifactPreservingStateRead(kind: "shared" | "agent" = "shared"): boolean {
  const scope = artifactPreservingReads.getStore();
  return Boolean(scope && (kind === "shared" || scope.agentDatabases));
}
