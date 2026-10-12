import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { assertAgentSessionWriteAdmission } from "../sessions/session-agent-work-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import * as creationClaims from "./agent-creation-claim.js";
import {
  assertAgentDeletionCleanupAliases,
  assertAgentDeletionExecutionCleanupAccess,
  getAgentDeletionDatabaseCleanup,
} from "./agent-deletion-cleanup.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import {
  isSameOpenClawAgentDatabasePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
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
import { runOpenClawAgentWorkerWrite } from "./openclaw-agent-write-admission.js";

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

/** Only the deleted agent's store needs a fresh, exclusive cleanup owner. */
export async function captureAgentDeletionDatabaseExecution(
  options: OpenClawAgentDatabaseOptions,
): Promise<OpenClawAgentDatabaseExecution> {
  const cleanup = getAgentDeletionDatabaseCleanup(options);
  if (cleanup?.worker && cleanup.ownsDatabase) {
    cleanup.assertCurrentHost();
    const pathname = resolveOpenClawAgentSqlitePath(options);
    const previous =
      executions.get(pathname) ??
      executions.get(readDatabasePathIdentitySync(pathname).canonicalPath);
    if (previous?.kind === "file") {
      assertAgentDatabaseExecutionSharedState(options, previous.sharedDatabaseKey);
      assertAgentDeletionExecutionCleanupAccess(previous, options);
      await previous.retireForCleanup();
      cleanup.assertCurrentHost();
    }
  }
  return captureFileAgentDatabaseExecution(options);
}

/** Finish native initialization before publishing a newly available agent to readers. */
export async function prepareOpenClawAgentDatabaseExecution(
  options: OpenClawAgentDatabaseOptions,
  assertCurrent: () => void,
  signal?: AbortSignal,
): Promise<void> {
  assertCurrent();
  const execution = captureOpenClawAgentDatabaseExecution(options);
  try {
    await runOpenClawAgentWorkerWrite(
      options,
      () =>
        execution.prepare(
          {
            assertCurrent,
            createAdmission: (binding) => () => ({
              nativeLocations: binding.nativeLocations,
              admission: createSqliteWorkerOperationAdmission((request, grant) => {
                binding.authorize(request);
                assertCurrent();
                if (!grant()) {
                  throw new Error(
                    `Agent ${options.agentId} database preparation admission expired`,
                  );
                }
              }, binding.attachment),
            }),
          },
          signal,
        ),
      undefined,
      signal,
    );
  } finally {
    await execution.release();
  }
}

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
  assertAgentSessionWriteAdmission(options);
  assertAgentDeletionCleanupAliases(options, isSameOpenClawAgentDatabasePath);
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
