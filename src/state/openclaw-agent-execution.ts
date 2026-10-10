import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import * as creationClaims from "./agent-creation-claim.js";
import { assertAgentDeletionExecutionCleanupAccess } from "./agent-deletion-cleanup.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type { OpenClawAgentDatabaseExecution } from "./openclaw-agent-execution-contract.js";
import { createAgentDatabaseExecutionCapture } from "./openclaw-agent-execution-incognito.js";
import {
  createAgentDatabaseExecution,
  type AgentDatabaseExecutionState,
} from "./openclaw-agent-execution-owner.js";
import {
  assertAgentDatabaseExecutionCreationIdentity,
  assertAgentDatabaseExecutionSharedState,
  borrowExistingAgentDatabaseExecution,
  type AgentDatabaseExecutionCaptureConstraints,
  supportsOpenClawAgentDatabaseExecution,
} from "./openclaw-agent-execution-scope.js";

export { supportsOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution-scope.js";

// References are derived; the canonical agent and shared resource owners govern retirement.
const executionState = resolveGlobalSingleton<AgentDatabaseExecutionState>(
  Symbol.for("openclaw.agentDatabaseExecutionOwners"),
  () => ({ owners: new Map(), idle: new Set() }),
);
const executions = executionState.owners;

/** File captures stay synchronous; explicit ephemeral targets await their pinned actor. */
export const captureOpenClawAgentDatabaseExecution = createAgentDatabaseExecutionCapture(
  executions,
  captureFileAgentDatabaseExecution,
);

/** Borrow an existing physical owner without opening or preparing a writer. */
export function captureExistingOpenClawAgentDatabaseExecution(
  options: { path: string; env?: NodeJS.ProcessEnv },
  constraints?: { expectedCreationIdentity: DatabasePathIdentity },
): OpenClawAgentDatabaseExecution | undefined {
  return borrowExistingAgentDatabaseExecution(
    executions,
    options,
    constraints ? (target) => captureFileAgentDatabaseExecution(target, constraints) : undefined,
  );
}

/** Borrow before callers yield; native opening stays lazy and release joins owned work. */
function captureFileAgentDatabaseExecution(
  options: OpenClawAgentDatabaseOptions,
  constraints: AgentDatabaseExecutionCaptureConstraints = {},
): OpenClawAgentDatabaseExecution {
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveOpenClawAgentSqlitePath(options);
  creationClaims.assertAgentCreationClaimAliases(options);
  if (!supportsOpenClawAgentDatabaseExecution(options)) {
    throw new Error("This agent database scope still requires its existing native owner");
  }
  let existing = executions.get(pathname);
  const expectedCreationIdentity = constraints.expectedCreationIdentity
    ? Object.freeze({ ...constraints.expectedCreationIdentity })
    : undefined;
  if (!existing || expectedCreationIdentity) {
    const identity = readDatabasePathIdentitySync(pathname);
    existing ??= executions.get(identity.canonicalPath);
    if (expectedCreationIdentity) {
      assertAgentDatabaseExecutionCreationIdentity(
        pathname,
        expectedCreationIdentity,
        expectedCreationIdentity.key.startsWith("path:") && existing?.kind === "file"
          ? existing.creationIdentity
          : identity,
        constraints.expectedIdentity,
      );
    }
    if (!existing) {
      return createAgentDatabaseExecution(
        options,
        {
          agentId,
          pathname,
          identity,
          initialIdentity: constraints.expectedIdentity,
          expectedCreationIdentity,
          requestedPath: constraints.requestedPath,
        },
        executionState,
      );
    }
  }
  if (existing.kind !== "file") {
    throw new Error("Agent namespace belongs to an incognito execution owner");
  }
  if (existing.agentId !== agentId) {
    throw new Error(
      `OpenClaw agent database ${pathname} is already open for agent ${existing.agentId}; requested agent ${agentId}.`,
    );
  }
  assertAgentDatabaseExecutionSharedState(options, existing.sharedDatabaseKey);
  assertAgentDeletionExecutionCleanupAccess(existing, options);
  return existing.borrow(
    pathname,
    constraints.expectedIdentity,
    expectedCreationIdentity,
    constraints.requestedPath,
  );
}
