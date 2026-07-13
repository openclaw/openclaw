import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-tools.js";
import { resetRegisteredAgentHarnessSessions } from "../../agents/harness/registry.js";
import { runExclusiveSessionStoreWrite } from "../../config/sessions/store-writer.js";
import {
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import type { ReplyInitConflictRecoveryState } from "./reply-session-init-conflict.js";

export type ReplySessionInitLifecycleMutationIdentity = {
  sessionId: string;
  sessionKey: string;
};

export type ReplySessionInitAttemptOutcome<Result> =
  | { kind: "complete"; result: Result }
  | ({ kind: "lifecycle-mutation" } & ReplySessionInitLifecycleMutationIdentity)
  | ({
      kind: "conflict-self-heal";
      sessionFile: string | undefined;
    } & ReplySessionInitLifecycleMutationIdentity);

type ReplySessionInitAttemptContext = {
  agentId: string;
  storePath: string;
};

export async function runReplySessionInitAttempt<
  Result,
  Params,
  AttemptContext extends ReplySessionInitAttemptContext,
>(options: {
  params: Params;
  staleSnapshotRetried: boolean;
  selfHealRequested?: boolean;
  signal?: AbortSignal;
  resolveAttemptContext: (params: Params) => AttemptContext;
  runLocked: (
    params: Params,
    attemptContext: AttemptContext,
    staleSnapshotRetried: boolean,
    lifecycleMutationIdentity: ReplySessionInitLifecycleMutationIdentity | undefined,
    conflictRecovery: ReplyInitConflictRecoveryState,
  ) => Promise<ReplySessionInitAttemptOutcome<Result>>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<Result> {
  const attemptContext = options.resolveAttemptContext(options.params);
  const runLocked = (
    staleSnapshotRetried: boolean,
    lifecycleMutationIdentity: ReplySessionInitLifecycleMutationIdentity | undefined,
    conflictRecovery: ReplyInitConflictRecoveryState,
  ) =>
    options.runLocked(
      options.params,
      attemptContext,
      staleSnapshotRetried,
      lifecycleMutationIdentity,
      conflictRecovery,
    );
  let pending = await runExclusiveSessionStoreWrite(
    attemptContext.storePath,
    async () =>
      await runLocked(options.staleSnapshotRetried, undefined, {
        selfHealRequested: options.selfHealRequested ?? false,
        recoveryAttempted: false,
      }),
  );

  while (true) {
    if (pending.kind === "complete") {
      return pending.result;
    }
    if (pending.kind === "conflict-self-heal") {
      pending = await selfHealReplySessionInitConflict({
        attemptContext,
        candidate: pending,
        runLocked,
        signal: options.signal,
        warn: options.warn,
      });
      continue;
    }
    pending = await runReplySessionRolloverMutation({
      attemptContext,
      candidate: pending,
      runLocked,
      selfHealRequested: options.selfHealRequested ?? false,
      signal: options.signal,
    });
  }
}

async function runReplySessionRolloverMutation<Result>(options: {
  attemptContext: ReplySessionInitAttemptContext;
  candidate: ReplySessionInitLifecycleMutationIdentity;
  runLocked: (
    staleSnapshotRetried: boolean,
    lifecycleMutationIdentity: ReplySessionInitLifecycleMutationIdentity | undefined,
    conflictRecovery: ReplyInitConflictRecoveryState,
  ) => Promise<ReplySessionInitAttemptOutcome<Result>>;
  selfHealRequested: boolean;
  signal?: AbortSignal;
}): Promise<ReplySessionInitAttemptOutcome<Result>> {
  const identities = [options.candidate.sessionKey, options.candidate.sessionId];
  let preparedOutcome: ReplySessionInitAttemptOutcome<Result> | undefined;
  return await runExclusiveSessionLifecycleMutation({
    scope: options.attemptContext.storePath,
    identities,
    signal: options.signal,
    prepare: async () => {
      const revalidated = await runExclusiveSessionStoreWrite(
        options.attemptContext.storePath,
        async () =>
          await options.runLocked(false, undefined, {
            selfHealRequested: options.selfHealRequested,
            recoveryAttempted: false,
          }),
      );
      if (
        revalidated.kind !== "lifecycle-mutation" ||
        revalidated.sessionKey !== options.candidate.sessionKey ||
        revalidated.sessionId !== options.candidate.sessionId
      ) {
        preparedOutcome = revalidated;
        return;
      }
      const drained = await interruptSessionWorkAdmissions({
        scope: options.attemptContext.storePath,
        identities,
        timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      });
      if (!drained) {
        throw new Error(
          `timed out draining work before reply session rollover: ${options.candidate.sessionKey}`,
        );
      }
    },
    run: async () =>
      preparedOutcome ??
      (await runExclusiveSessionStoreWrite(
        options.attemptContext.storePath,
        async () =>
          await options.runLocked(false, options.candidate, {
            selfHealRequested: options.selfHealRequested,
            recoveryAttempted: false,
          }),
      )),
  });
}

async function selfHealReplySessionInitConflict<Result>(options: {
  attemptContext: ReplySessionInitAttemptContext;
  candidate: ReplySessionInitLifecycleMutationIdentity & { sessionFile: string | undefined };
  runLocked: (
    staleSnapshotRetried: boolean,
    lifecycleMutationIdentity: ReplySessionInitLifecycleMutationIdentity | undefined,
    conflictRecovery: ReplyInitConflictRecoveryState,
  ) => Promise<ReplySessionInitAttemptOutcome<Result>>;
  signal?: AbortSignal;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<ReplySessionInitAttemptOutcome<Result>> {
  const identities = [options.candidate.sessionKey, options.candidate.sessionId];
  let preparedOutcome: ReplySessionInitAttemptOutcome<Result> | undefined;
  return await runExclusiveSessionLifecycleMutation({
    scope: options.attemptContext.storePath,
    identities,
    signal: options.signal,
    prepare: async () => {
      const revalidated = await runExclusiveSessionStoreWrite(
        options.attemptContext.storePath,
        async () =>
          await options.runLocked(false, undefined, {
            selfHealRequested: true,
            recoveryAttempted: false,
          }),
      );
      if (
        revalidated.kind !== "conflict-self-heal" ||
        revalidated.sessionKey !== options.candidate.sessionKey ||
        revalidated.sessionId !== options.candidate.sessionId
      ) {
        preparedOutcome = revalidated;
        return;
      }
      const drained = await interruptSessionWorkAdmissions({
        scope: options.attemptContext.storePath,
        identities,
        timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      });
      if (!drained) {
        throw new Error(
          `timed out draining work before reply session init self-heal: ${options.candidate.sessionKey}`,
        );
      }
    },
    run: async () => {
      if (preparedOutcome) {
        return preparedOutcome;
      }
      await retireSessionMcpRuntime({
        sessionId: options.candidate.sessionId,
        reason: "reply-session-init-conflict",
        onError: (error, sessionIdLocal) => {
          options.warn(
            `failed to dispose bundle MCP runtime for conflicted session ${sessionIdLocal}`,
            { error: String(error) },
          );
        },
      });
      await resetRegisteredAgentHarnessSessions({
        agentId: options.attemptContext.agentId,
        sessionId: options.candidate.sessionId,
        sessionKey: options.candidate.sessionKey,
        sessionFile: options.candidate.sessionFile,
        reason: "reset",
      });
      return await runExclusiveSessionStoreWrite(
        options.attemptContext.storePath,
        async () =>
          await options.runLocked(false, undefined, {
            selfHealRequested: true,
            recoveryAttempted: true,
          }),
      );
    },
  });
}
