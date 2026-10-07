import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { getAgentDeletionDatabaseCleanup } from "./agent-deletion-cleanup.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { hasAgentDatabaseMaintenanceAuthority } from "./openclaw-agent-db-lease.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import type {
  AgentDatabaseGenerationClaim,
  AgentDatabaseNativeGeneration,
} from "./openclaw-agent-execution-contract.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { captureOpenClawStateReadContext } from "./openclaw-state-worker-context.js";

export function assertAgentDatabaseExecutionSharedState(
  options: OpenClawAgentDatabaseOptions,
  sharedDatabaseKey: string,
): void {
  const env =
    process.platform === "win32"
      ? cloneEnvWithPlatformSemantics(options.env ?? process.env)
      : options.env;
  const state = captureOpenClawStateReadContext(resolveOpenClawStateSqlitePath(env));
  if (sharedDatabaseKey !== state.admission.identity.key) {
    throw new Error(
      "Agent database execution belongs to another shared-state database; drain its existing resources before changing the state directory.",
    );
  }
}

export function supportsAgentDatabaseExecutionScope(
  options: OpenClawAgentDatabaseOptions,
): boolean {
  return (
    getOpenClawDatabaseMaintenanceScope()?.ownsSchemaMaintenance !== true &&
    !hasAgentDatabaseMaintenanceAuthority() &&
    !getAgentDeletionDatabaseCleanup(options)
  );
}

/** These native-only scopes still need their complete owning caller cutover. */
export function supportsOpenClawAgentDatabaseExecution(
  options: OpenClawAgentDatabaseOptions,
): boolean {
  return (
    !isIncognitoOpenClawAgentSqlitePath(resolveOpenClawAgentSqlitePath(options), options) &&
    supportsAgentDatabaseExecutionScope(options)
  );
}

/** Bind a native claim to the same borrower and logical generation that captured it. */
export function captureBorrowedAgentDatabaseGenerationClaim(
  assertBorrowed: () => void,
  readGeneration: () => AgentDatabaseNativeGeneration | undefined,
): AgentDatabaseGenerationClaim {
  assertBorrowed();
  const captured = readGeneration();
  if (!captured) {
    throw new Error("Agent database execution has no admitted generation");
  }
  const claim = captured.captureClaim();
  return {
    identity: claim.identity,
    incarnation: claim.incarnation,
    assertCurrent() {
      assertBorrowed();
      if (readGeneration() !== captured) {
        throw new Error("Agent database execution generation was replaced");
      }
      claim.assertCurrent();
    },
  };
}
