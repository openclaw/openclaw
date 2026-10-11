import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { PreservedSessionWorktree } from "../../packages/gateway-protocol/src/index.js";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import {
  SessionWorktreeLifecycleError,
  WorktreeRemovalContentionError,
} from "../agents/worktrees/errors.js";
import { assertManagedWorktreeRemovalComplete } from "../agents/worktrees/git-lock.js";
import { runGit } from "../agents/worktrees/git.js";
import {
  captureWorktreeRegistryReadGuard,
  readRegistryWorktree,
} from "../agents/worktrees/registry-read.js";
import { assertWorktreeRemovalAvailable } from "../agents/worktrees/registry.js";
import { captureWorktreeRunEndContext } from "../agents/worktrees/run-end-lifecycle.js";
import {
  classifyWorktreeRemovalError,
  ManagedWorktreeService,
} from "../agents/worktrees/service.js";
import type { ManagedWorktreeRecord, WorktreeWorkerAuthority } from "../agents/worktrees/types.js";
import { loadSessionEntry, type SessionAccessScope } from "../config/sessions/session-accessor.js";
import {
  captureSessionEntryMetadataRead,
  captureSessionEntrySourceAssertion,
} from "../config/sessions/session-entry-source-authority.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { getChildLogger } from "../logging/logger.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";

function belongsToSession(record: ManagedWorktreeRecord, sessionKey: string) {
  return record.ownerKind === "session" && record.ownerId === sessionKey;
}

/** Settle the detached checkout before the session fence admits same-key successors. */
export async function finalizeDetachedSessionWorktree(params: {
  id: string;
  env: NodeJS.ProcessEnv;
  context: OpenClawStateWorkerContext;
}): Promise<void> {
  params.context.admission.assertCurrent();
  const worktrees = new ManagedWorktreeService({ env: params.env });
  if (await worktrees.removeIfLossless(params.id)) {
    return;
  }
  const retained = await readRegistryWorktree(params.context, params.id);
  if (retained && retained.removedAt === undefined) {
    const safePath = truncateUtf16Safe(sanitizeForLog(retained.path), 256);
    throw new Error(
      `worktree retained: branch=${retained.branch} path=${safePath} outcome=${retained.runEndCleanup?.outcome}`,
    );
  }
}

/** The session lifecycle fence remains held until this exact bound checkout finishes cleanup. */
export async function removeSessionWorktree(params: {
  id?: string;
  sessionKey: string;
  reason: string;
  commitGuard?: () => void;
  workerAuthority?: WorktreeWorkerAuthority;
  env?: NodeJS.ProcessEnv;
}): Promise<PreservedSessionWorktree | undefined> {
  if (!params.id) {
    return undefined;
  }
  const env = params.env ?? process.env;
  const context = captureWorktreeRunEndContext(env);
  const service = new ManagedWorktreeService({ env: { ...env, ...context.environment } });
  const accept = captureWorktreeRegistryReadGuard(context, "session-owner");
  const record = await readRegistryWorktree(context, params.id);
  const assertWorktreeCurrent = accept(record);
  params.commitGuard?.();
  if (!record || record.removedAt !== undefined) {
    return undefined;
  }
  const assertCurrent = () => {
    params.commitGuard?.();
    assertWorktreeCurrent();
    if (!belongsToSession(record, params.sessionKey)) {
      throw new SessionWorktreeLifecycleError(
        "Session worktree ownership changed; retry cleanup.",
        "owner-mismatch",
      );
    }
  };
  try {
    assertCurrent();
    await service.remove({
      id: record.id,
      reason: params.reason,
      commitGuard: assertCurrent,
      workerAuthority: {
        ...params.workerAuthority,
        assertCurrent: params.workerAuthority
          ? params.workerAuthority.assertCurrent
          : params.commitGuard,
        predicates: [
          ...(params.workerAuthority?.predicates ?? []),
          { kind: "session-owner", id: record.id, sessionKey: params.sessionKey },
        ],
      },
    });
  } catch (error) {
    // Authorization loss is a failed lifecycle action, not successful best-effort cleanup.
    params.commitGuard?.();
    const current = await readRegistryWorktree(context, record.id);
    params.commitGuard?.();
    if (current && current.removedAt === undefined) {
      const reason =
        error instanceof SessionWorktreeLifecycleError && error.reason === "owner-mismatch"
          ? error.reason
          : classifyWorktreeRemovalError(error);
      getChildLogger({ subsystem: "session-worktree" }).warn("Session worktree preserved", {
        worktreeId: record.id,
        sessionKey: params.sessionKey,
        reason,
      });
      return { id: current.id, branch: current.branch, path: current.path, reason };
    }
  }
  return undefined;
}

/** Restore preparation preserves conversation metadata until its caller commits unarchive. */
export async function restoreSessionWorktree(params: {
  entry: SessionEntry;
  scope: SessionAccessScope;
  commitGuard?: SessionSourceAssertion;
  assertRestoreAllowed?: () => void;
}): Promise<SessionSourceAssertion> {
  const { entry, scope: requestedScope } = params;
  const id = entry.worktree?.id;
  if (!id) {
    return composeSessionSourceAssertion([params.commitGuard]);
  }
  const context = captureWorktreeRunEndContext(requestedScope.env ?? process.env);
  const scope = {
    ...requestedScope,
    env: { ...(requestedScope.env ?? process.env), ...context.environment },
  };
  const metadata = captureSessionEntryMetadataRead(scope, () => {
    params.commitGuard?.();
    params.assertRestoreAllowed?.();
  });
  const accept = captureWorktreeRegistryReadGuard(context, "session-owner");
  const record = await readRegistryWorktree(context, id);
  const assertWorktreeCurrent = accept(record);
  const assertSessionCurrent = () => {
    const current = metadata ? metadata.readCurrent() : loadSessionEntry(scope);
    if (
      current?.sessionId !== entry.sessionId ||
      current?.lifecycleRevision !== entry.lifecycleRevision ||
      current?.archivedAt !== entry.archivedAt ||
      !isDeepStrictEqual(current?.worktree, entry.worktree)
    ) {
      throw new SessionWorktreeLifecycleError(
        "Session changed while preparing its worktree; retry the request.",
        "session-changed",
      );
    }
  };
  const source = captureSessionEntrySourceAssertion({
    scope: {
      agentId: scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey),
      sessionKey: scope.sessionKey,
      storePath: resolveSessionStorePathForScope(scope),
      env: scope.env,
    },
    expected: entry,
    // The destination's patch snapshot owns archivedAt; successful unarchive changes it.
    fields: ["sessionId", "lifecycleRevision", "worktree"],
    assertCurrent: assertSessionCurrent,
    refuse: () => {
      throw new SessionWorktreeLifecycleError(
        "Session changed while preparing its worktree; retry the request.",
        "session-changed",
      );
    },
  });
  const assertCurrent = composeSessionSourceAssertion(
    [params.commitGuard, source],
    (assertSources) => {
      assertSources();
      assertWorktreeCurrent();
      try {
        assertWorktreeRemovalAvailable(scope.env ?? process.env, id);
      } catch (error) {
        if (error instanceof WorktreeRemovalContentionError) {
          throw new SessionWorktreeLifecycleError(error.message, "busy");
        }
        throw error;
      }
      if (record && !belongsToSession(record, scope.sessionKey)) {
        throw new SessionWorktreeLifecycleError(
          "Session worktree has a different owner; restore the correct binding before retrying.",
          "owner-mismatch",
        );
      }
    },
  );
  const workerAuthority: WorktreeWorkerAuthority = {
    assertCurrent: composeSessionSourceAssertion([params.commitGuard, source]),
    predicates: [{ kind: "session-owner", id, sessionKey: scope.sessionKey }],
  };
  assertCurrent();
  if (!record || (record.removedAt !== undefined && !record.snapshotRef)) {
    throw new SessionWorktreeLifecycleError(
      "Session worktree snapshot is missing or expired. The conversation is preserved; start a new worktree task from the source repository to continue.",
      "restore-failed",
    );
  }
  if (record.removedAt !== undefined) {
    params.assertRestoreAllowed?.();
    try {
      await new ManagedWorktreeService({ env: scope.env }).restore({
        id,
        commitGuard: assertCurrent,
        workerAuthority,
      });
    } catch (error) {
      assertCurrent();
      if (error instanceof SessionWorktreeLifecycleError) {
        throw error;
      }
      if (!existsSync(record.repoRoot)) {
        throw new SessionWorktreeLifecycleError(
          "Session worktree source repository is missing. Restore the original repository and its snapshot refs, then retry; otherwise start a new worktree task. The conversation is preserved.",
          "restore-failed",
        );
      }
      const snapshot = await runGit(record.repoRoot, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${record.snapshotRef}^{commit}`,
      ]);
      assertCurrent();
      if (snapshot.code !== 0) {
        throw new SessionWorktreeLifecycleError(
          "Session worktree snapshot is missing or unavailable. Restore the original repository snapshot, or start a new worktree task. The conversation is preserved.",
          "restore-failed",
        );
      }
      throw new SessionWorktreeLifecycleError(
        "Session worktree could not be restored. Free disk space if needed, check the source repository, then retry. The conversation and snapshot are preserved.",
        "restore-failed",
      );
    }
  } else {
    try {
      await assertManagedWorktreeRemovalComplete(record, { beforeRun: assertCurrent });
    } catch (error) {
      assertCurrent();
      if (error instanceof WorktreeRemovalContentionError) {
        throw new SessionWorktreeLifecycleError(error.message, "restore-failed");
      }
      throw error;
    }
  }
  assertCurrent();
  return assertCurrent;
}
