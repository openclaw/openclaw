import { createSessionWorkerExecutionSource } from "../config/sessions/session-worker-execution-source.js";
import {
  readDatabasePathIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { assertAgentSessionWriteAdmission } from "../sessions/session-agent-work-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import * as creationClaims from "./agent-creation-claim.js";
import {
  captureAgentDatabaseAdmission,
  isAgentDatabaseStartupReadReady,
} from "./agent-database-admission.js";
import {
  assertAgentDeletionCleanupAliases,
  assertAgentDeletionExecutionCleanupAccess,
  getAgentDeletionDatabaseCleanup,
} from "./agent-deletion-cleanup.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-resources.js";
import {
  isSameOpenClawAgentDatabasePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import type {
  OpenClawAgentDatabaseExecution,
  AgentDatabaseExecutionState,
} from "./openclaw-agent-execution-contract.js";
import { createAgentDatabaseExecution } from "./openclaw-agent-execution-owner.js";
import {
  assertAgentDatabaseExecutionCreationIdentity,
  assertAgentDatabaseExecutionSharedState,
  toAgentExecutionConstraints,
  type AgentDatabaseExecutionCaptureConstraints,
  supportsOpenClawAgentDatabaseExecution,
} from "./openclaw-agent-execution-scope.js";
import { runOpenClawAgentWorkerWrite } from "./openclaw-agent-write-admission.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { captureOpenClawStateReadContext } from "./openclaw-state-worker-context.js";

export { supportsOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution-scope.js";

// References are derived; the canonical agent and shared resource owners govern retirement.
const executionState = resolveGlobalSingleton<AgentDatabaseExecutionState>(
  Symbol.for("openclaw.agentDatabaseExecutionOwners"),
  () => ({ owners: new Map(), idle: new Set() }),
);
const executions = executionState.owners;

/** Observe initial schema and registry publication through an already-captured physical path. */
export function getPendingOpenClawAgentDatabasePreparation(
  physicalPath: string,
  admission: "read" | "write" = "write",
): Promise<void> | undefined {
  const pending = executions.get(physicalPath)?.getPendingPreparation();
  return pending && admission === "read" && isAgentDatabaseStartupReadReady(physicalPath)
    ? undefined
    : pending;
}

/** Borrow the opener's original file fact without granting read or write admission. */
export function readPendingOpenClawAgentDatabaseIdentity(pathname: string) {
  const owner = executions.get(pathname);
  const identity = owner?.getOpeningIdentity();
  return owner && identity ? { agentId: owner.agentId, identity } : undefined;
}

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
      executions.get((await readDatabasePathIdentity(pathname)).canonicalPath);
    if (previous) {
      assertAgentDatabaseExecutionSharedState(options, previous.sharedDatabaseKey);
      assertAgentDeletionExecutionCleanupAccess(previous, options);
      await previous.retireForCleanup();
      cleanup.assertCurrentHost();
    }
  }
  return captureOpenClawAgentDatabaseExecutionAsync(options);
}

/** Finish native initialization before publishing a newly available agent to readers. */
export async function prepareOpenClawAgentDatabaseExecution(
  options: OpenClawAgentDatabaseOptions,
  assertCurrent: () => void,
  signal?: AbortSignal,
): Promise<void> {
  assertCurrent();
  const execution = await captureOpenClawAgentDatabaseExecutionAsync(options);
  try {
    await runOpenClawAgentWorkerWrite(
      options,
      () =>
        execution.prepare(
          createSessionWorkerExecutionSource(
            assertCurrent,
            `Agent ${options.agentId} database preparation admission expired`,
          ),
          signal,
        ),
      undefined,
      signal,
    );
  } finally {
    await execution.release();
  }
}

/** Borrow before callers yield; native opening stays lazy and release joins owned work. */
export function captureOpenClawAgentDatabaseExecution(
  options: OpenClawAgentDatabaseOptions,
  constraints: AgentDatabaseExecutionCaptureConstraints = {},
  inheritCreationIdentity = false,
): OpenClawAgentDatabaseExecution {
  return captureAgentDatabaseExecution(options, constraints, inheritCreationIdentity);
}

/** Warm canonical captures reuse admitted identity; unknown targets are observed asynchronously. */
export async function captureOpenClawAgentDatabaseExecutionAsync(
  options: OpenClawAgentDatabaseOptions,
  constraints: AgentDatabaseExecutionCaptureConstraints = {},
  creation?: "inherit" | "observed-absence",
): Promise<OpenClawAgentDatabaseExecution & { readonly capturedIdentity: DatabasePathIdentity }> {
  const capture = (identity: DatabasePathIdentity) => {
    const observed = Object.freeze({ ...identity });
    return Object.assign(
      captureAgentDatabaseExecution(
        options,
        {
          ...constraints,
          ...(!constraints.expectedCreationIdentity &&
          !constraints.expectedIdentity &&
          (observed.key.startsWith("file:") || creation === "observed-absence")
            ? toAgentExecutionConstraints(observed)
            : {}),
        },
        creation === "inherit",
        observed,
      ),
      { capturedIdentity: observed },
    );
  };
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const previous = executions.get(pathname);
  const published = previous?.fileIdentity;
  if (constraints.expectedCreationIdentity?.canonicalPath === pathname) {
    return capture(constraints.expectedCreationIdentity);
  }
  if (published?.nativeLocation === pathname) {
    return capture({
      key: `file:${published.physicalIdentity}`,
      canonicalPath: published.nativeLocation,
      birthtime: published.birthtime,
    });
  }
  assertAgentSessionWriteAdmission(options);
  const statePath = resolveOpenClawStateSqlitePath(options.env);
  const state = captureOpenClawStateReadContext(
    statePath,
    openClawStateDatabaseCache.getKnownOpenClawStateDatabaseIdentity(statePath),
  );
  const assertAgentCurrent = captureAgentDatabaseAdmission(options.agentId, { env: options.env });
  const creationClaim = creationClaims.captureAgentCreationClaim(options);
  const cleanup = getAgentDeletionDatabaseCleanup(options);
  const cleanupOwner = cleanup?.ownsDatabase ? cleanup : undefined;
  let retired = false;
  const unregister = registerOpenClawAgentDatabaseAsyncResource(
    {
      agentId: options.agentId,
      path: pathname,
      revoke: () => {
        retired = true;
      },
      close: async () => {},
    },
    options,
  );
  try {
    const observed = await readDatabasePathIdentity(pathname);
    state.admission.assertCurrent();
    (cleanupOwner?.assertCurrentHost ?? assertAgentCurrent)();
    creationClaim?.assertCurrent();
    cleanup?.assertCurrentHost();
    if (retired || (previous && executions.get(pathname) !== previous)) {
      throw new Error("Agent database execution owner retired during capture");
    }
    if (
      published &&
      (observed.key !== `file:${published.physicalIdentity}` ||
        (published.birthtime !== undefined && observed.birthtime !== published.birthtime))
    ) {
      throw new Error("Agent database borrower belongs to another physical file");
    }
    return capture(observed);
  } finally {
    unregister();
  }
}

function captureAgentDatabaseExecution(
  options: OpenClawAgentDatabaseOptions,
  constraints: AgentDatabaseExecutionCaptureConstraints,
  inheritCreationIdentity: boolean,
  observed?: DatabasePathIdentity,
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
    const identity = observed ?? readDatabasePathIdentitySync(pathname);
    existing ??= executions.get(identity.canonicalPath);
    if (expectedCreationIdentity) {
      assertAgentDatabaseExecutionCreationIdentity(
        pathname,
        expectedCreationIdentity,
        expectedCreationIdentity.key.startsWith("path:") && existing
          ? (existing.creationIdentity ?? identity)
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
          expectedCreationIdentity:
            expectedCreationIdentity ??
            (inheritCreationIdentity && identity.key.startsWith("path:") ? identity : undefined),
          requestedPath: constraints.requestedPath,
          observedIdentity: observed,
        },
        executionState,
      );
    }
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
    expectedCreationIdentity ?? (inheritCreationIdentity ? existing.creationIdentity : undefined),
    constraints.requestedPath,
    observed,
  );
}
