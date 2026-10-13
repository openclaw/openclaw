import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { getAgentDeletionDatabaseCleanup } from "./agent-deletion-cleanup.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import {
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "./openclaw-agent-db-identity.js";
import { hasAgentDatabaseMaintenanceAuthority } from "./openclaw-agent-db-lease.js";
import { agentDatabaseLifecycle } from "./openclaw-agent-db-lifecycle.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import type { AgentDatabaseGenerationClaim } from "./openclaw-agent-execution-admission-contract.js";
import type {
  OpenClawAgentDatabaseExecution,
  AgentDatabaseNativeGeneration,
  AgentDatabaseFileExecutionOwner,
  AgentDatabaseExecutionFileIdentity,
} from "./openclaw-agent-execution-contract.js";
import type { IncognitoAgentExecutionOwner } from "./openclaw-agent-execution-incognito.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  isOpenClawDatabaseMaintenanceWorkerAccess,
} from "./openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { captureOpenClawStateReadContext } from "./openclaw-state-worker-context.js";

export type AgentDatabaseExecutionCaptureConstraints = {
  expectedIdentity?: AgentDatabaseExecutionFileIdentity;
  expectedCreationIdentity?: DatabasePathIdentity;
  /** The caller's locator before it pinned options.path to the physical file. */
  requestedPath?: string;
};

export type AgentDatabaseExecutionPreparedTarget = {
  agentId: string;
  pathname: string;
  identity: DatabasePathIdentity;
  initialIdentity?: AgentDatabaseExecutionFileIdentity;
  expectedCreationIdentity?: DatabasePathIdentity;
  requestedPath?: string;
};

/** A read can borrow an already-selected file owner only within its current storage scope. */
export function borrowExistingAgentDatabaseExecution(
  owners: ReadonlyMap<string, AgentDatabaseFileExecutionOwner | IncognitoAgentExecutionOwner>,
  options: { path: string; env?: NodeJS.ProcessEnv },
  capture?: (target: OpenClawAgentDatabaseOptions) => OpenClawAgentDatabaseExecution,
): OpenClawAgentDatabaseExecution | undefined {
  const pathname = path.resolve(options.path);
  const owner =
    owners.get(pathname) ?? owners.get(readDatabasePathIdentitySync(pathname).canonicalPath);
  if (!owner || owner.kind !== "file") {
    return undefined;
  }
  const target = { ...options, agentId: owner.agentId, path: pathname };
  if (!supportsAgentDatabaseExecutionScope(target)) {
    return undefined;
  }
  try {
    assertAgentDatabaseExecutionSharedState(target, owner.sharedDatabaseKey);
    return capture ? capture(target) : owner.borrow(pathname);
  } catch {
    // Initial read selection does not inherit failures of an unrelated writable lifecycle.
    return undefined;
  }
}

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
  const cleanup = getAgentDeletionDatabaseCleanup(options);
  return (
    (isOpenClawDatabaseMaintenanceWorkerAccess() ||
      (getOpenClawDatabaseMaintenanceScope()?.ownsSchemaMaintenance !== true &&
        !hasAgentDatabaseMaintenanceAuthority())) &&
    (!cleanup || cleanup.worker !== undefined)
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

/** Bind native handoff to the admitted connection and recheck it after cleanup waits. */
export function captureNativeAgentDatabaseExecutionIdentity(
  database: OpenClawAgentDatabase,
  agentId: string,
  canonicalPath: string,
  assertBorrowed: () => void,
) {
  assertBorrowed();
  const native = readOpenClawAgentDatabaseIdentity(database);
  const assertCurrent = () => {
    assertBorrowed();
    if (
      database.agentId !== agentId ||
      agentDatabaseLifecycle.databases.get(database.path) !== database ||
      readOpenClawAgentDatabaseIdentity(database) !== native ||
      native.canonicalPath !== canonicalPath ||
      !isOpenClawAgentDatabasePathCurrent(database)
    ) {
      throw new Error("Agent execution cannot adopt a different native database owner");
    }
  };
  assertCurrent();
  if (typeof native.identity !== "string") {
    throw new Error("Agent execution requires an admitted native file");
  }
  const fileIdentity: AgentDatabaseExecutionFileIdentity = {
    kind: "file",
    physicalIdentity: native.identity,
    birthtime: native.birthtime,
    nativeLocation: native.canonicalPath,
  };
  return { fileIdentity, assertCurrent };
}

export function assertAgentDatabaseExecutionCreationIdentity(
  pathname: string,
  expected: DatabasePathIdentity,
  observed: DatabasePathIdentity | undefined,
  expectedFile: AgentDatabaseExecutionFileIdentity | undefined,
): void {
  const capturesAbsence = expected.key.startsWith("path:");
  if (
    expectedFile ||
    (capturesAbsence &&
      (agentDatabaseLifecycle.databases.has(pathname) ||
        agentDatabaseLifecycle.pending.has(pathname))) ||
    (!capturesAbsence &&
      (!expected.key.startsWith("file:") || typeof expected.birthtime !== "string")) ||
    observed?.key !== expected.key ||
    observed.canonicalPath !== expected.canonicalPath ||
    observed.birthtime !== expected.birthtime
  ) {
    throw new Error("Agent creation no longer owns its originally observed target");
  }
}

/** Keep the borrower's captured file constraints bound to its native owner. */
export function assertBorrowedAgentDatabaseFileIdentity({
  borrowedPath,
  identity,
  creatingTarget,
  fileIdentity,
  expectedIdentity,
  nativeIdentity,
}: {
  borrowedPath: string;
  identity: DatabasePathIdentity;
  creatingTarget: DatabasePathIdentity | undefined;
  fileIdentity: AgentDatabaseExecutionFileIdentity | undefined;
  expectedIdentity: AgentDatabaseExecutionFileIdentity | undefined;
  nativeIdentity: AgentDatabaseExecutionFileIdentity | undefined;
}): void {
  if (!fileIdentity || creatingTarget) {
    const current = readDatabasePathIdentitySync(borrowedPath);
    if (
      current.canonicalPath !== identity.canonicalPath ||
      (creatingTarget?.key.startsWith("file:") &&
        (current.key !== creatingTarget.key || current.birthtime !== creatingTarget.birthtime))
    ) {
      throw new Error("Agent database borrower changed its originally observed target");
    }
  }
  if (
    fileIdentity &&
    expectedIdentity &&
    (fileIdentity.physicalIdentity !== expectedIdentity.physicalIdentity ||
      (fileIdentity.birthtime !== undefined &&
        expectedIdentity.birthtime !== undefined &&
        fileIdentity.birthtime !== expectedIdentity.birthtime))
  ) {
    throw new Error("Agent database borrower belongs to another physical file");
  }
  const file = fileIdentity ?? expectedIdentity;
  const birthtime = fileIdentity?.birthtime ?? expectedIdentity?.birthtime;
  if (file) {
    if (
      nativeIdentity &&
      (nativeIdentity.physicalIdentity !== file.physicalIdentity ||
        (birthtime !== undefined && nativeIdentity.birthtime !== birthtime))
    ) {
      throw new Error("Agent database borrower belongs to another physical file");
    }
  }
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
