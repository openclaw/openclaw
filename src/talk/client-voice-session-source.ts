import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveSqliteAgentId } from "../config/sessions/session-accessor.sqlite-scope-helpers.js";
import type { SessionPendingInputAuthorityFacts } from "../config/sessions/session-pending-input-authority.js";
import {
  acceptSessionSourceValidation,
  admitPublishedSessionSource,
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
  type SessionSourceValidation,
} from "../config/sessions/session-source-authority.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { isSessionStoreReadCandidateCurrent } from "../config/sessions/session-store-read-candidates.js";
import { prepareSessionStoreCandidatesInWorker } from "../config/sessions/session-transcript-worker-resources.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { resolveStateDir } from "../config/state-dir.js";
import {
  assertDatabasePathIdentity,
  assertExistingDatabaseIdentity,
  readDatabasePathIdentity,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type {
  AgentDatabaseRequestExecutionSource,
  OpenClawAgentDatabaseAdmissionExecution,
} from "../state/openclaw-agent-execution-admission-contract.js";
import { toAgentExecutionConstraints } from "../state/openclaw-agent-execution-scope.js";
import { captureOpenClawAgentDatabaseExecutionAsync } from "../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import {
  assertClientVoiceSessionSettlementCurrent,
  captureClientVoiceSessionSettlementContext,
  type captureClientVoiceSessionSettlement,
} from "./client-voice-session-lifecycle.js";
import type {
  ClientVoiceRunBinding,
  ClientVoiceSessionRecord,
} from "./client-voice-session-store.js";
import type { VoiceSessionMutation } from "./client-voice-session-write.kernel.js";

/** Voice metadata stays bound to its admitted physical store across provider and queue waits. */
export function captureClientVoiceSessionSourceOptions(agentId: string) {
  const env = cloneEnvWithPlatformSemantics(process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const path = resolveOpenClawAgentSqlitePath({ agentId, env });
  return { agentId, env, path };
}

/** Retain entry ownership independently of the durable voice metadata store. */
export async function captureClientVoiceEntrySource(
  params: { agentId: string; storePath?: string },
  assertLifetimeCurrent: () => void,
  original = captureClientVoiceSessionSourceOptions(params.agentId),
) {
  const storePath = params.storePath ?? original.path;
  const prepared = await prepareSessionStoreCandidatesInWorker({ write: { storePath } });
  if (!("write" in prepared) || !prepared.write) {
    throw new Error("Talk entry preparation omitted its captured source");
  }
  const captured = prepared.write;
  const canonical = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  const assertCurrent = () => {
    assertLifetimeCurrent();
  };
  const capture = async (
    target: Awaited<ReturnType<typeof prepareSqliteTargetFromSessionStorePath>>,
  ) => {
    assertCurrent();
    const agentId = resolveSqliteAgentId({
      scopedAgentId: params.agentId,
      storeAgentId: target.agentId,
      storeShared: target.shared,
    });
    if (!agentId || !target.agentId) {
      throw new Error("Talk entry target has no physical owner");
    }
    const resolved = await prepareSessionStoreCandidatesInWorker({
      resolveWrite: { pathname: target.path, captured },
    });
    if (!("identity" in resolved) || !resolved.identity) {
      throw new Error("Talk entry preparation omitted its physical identity");
    }
    assertCurrent();
    const observed = resolved.identity;
    const options = { agentId: target.agentId, path: observed.canonicalPath, env: original.env };
    const execution = await captureOpenClawAgentDatabaseExecutionAsync(
      options,
      {
        expectedIdentity: toAgentExecutionConstraints(observed).expectedIdentity,
        requestedPath: target.path,
      },
      "inherit",
    );
    return {
      options,
      identity: observed,
      execution,
      agentId,
      storePath,
      assertCurrent,
      assertLegacyCurrent() {
        assertCurrent();
        if (!captured.candidates.every(isSessionStoreReadCandidateCurrent)) {
          throw new Error("Session database selector changed during discovery");
        }
      },
      readCustody: captured.candidates.map((candidate) => ({
        sourcePath: candidate.path,
        candidates: [candidate],
      })),
      creating: !observed.key.startsWith("file:"),
    };
  };
  return canonical.agentId
    ? capture(canonical)
    : capture(
        await prepareSqliteTargetFromSessionStorePath(storePath, {
          agentId: params.agentId,
          env: original.env,
        }),
      );
}

export function createClientVoiceSessionSource(
  options: ReturnType<typeof captureClientVoiceSessionSourceOptions>,
  initialIdentity: DatabasePathIdentity | Promise<DatabasePathIdentity>,
) {
  const settlementContext = captureClientVoiceSessionSettlementContext(options.env);
  const assertCurrent = () => {
    assertClientVoiceSessionSettlementCurrent(settlementContext);
    settlementContext.admission.assertCurrent();
  };
  let identity = initialIdentity instanceof Promise ? undefined : initialIdentity;
  const prepared = Promise.resolve(initialIdentity).then((observed) => {
    assertCurrent();
    identity = observed;
    return observed;
  });
  // Relay acceptance remains synchronous; its reservation joins this preparation.
  void prepared.catch(() => {});
  return {
    options,
    get identity() {
      if (!identity) {
        throw new Error("Voice session source preparation has not completed");
      }
      return identity;
    },
    prepare: () => prepared,
    async prepareCurrent() {
      const observed = await prepared;
      await prepareSessionStoreCandidatesInWorker({
        validate: { candidates: [], sources: [{ path: options.path, identity: observed }] },
      });
      assertCurrent();
    },
    settlementContext,
    assertCurrent,
    assertLegacyCurrent() {
      assertCurrent();
      assertDatabasePathIdentity(options.path, this.identity);
    },
  };
}

export function captureClientVoiceSessionSource(agentId: string) {
  const options = captureClientVoiceSessionSourceOptions(agentId);
  return createClientVoiceSessionSource(options, readDatabasePathIdentity(options.path));
}

export type ClientVoiceSessionSource = ReturnType<typeof captureClientVoiceSessionSource>;

/** Voice metadata keeps its durable agent owner, including for incognito transcripts. */
export function captureClientVoiceSessionWriter(params: {
  agentId: string;
  assertCurrent?: () => void;
  physicalSource?: ClientVoiceSessionSource;
}) {
  const options =
    params.physicalSource?.options ?? captureClientVoiceSessionSourceOptions(params.agentId);
  params.physicalSource?.assertCurrent();
  let execution: Awaited<ReturnType<typeof captureOpenClawAgentDatabaseExecutionAsync>> | undefined;
  const pending = (
    params.physicalSource
      ? params.physicalSource
          .prepare()
          .then((identity) =>
            captureOpenClawAgentDatabaseExecutionAsync(
              options,
              { expectedIdentity: toAgentExecutionConstraints(identity).expectedIdentity },
              "inherit",
            ),
          )
      : captureOpenClawAgentDatabaseExecutionAsync(options, {}, "inherit")
  ).then((retained) => {
    execution = retained;
    return retained;
  });
  const captured =
    params.physicalSource ??
    createClientVoiceSessionSource(
      options,
      pending.then((retained) => retained.capturedIdentity),
    );
  const ready = Promise.all([pending, captured.prepare()]).then(([retained]) => retained);
  void ready.catch(() => {});
  const preparedExecution = () => {
    if (!execution) {
      throw new Error("Voice session writer preparation has not completed");
    }
    return execution;
  };
  const assertCurrent = () => {
    assertClientVoiceSessionSettlementCurrent(captured.settlementContext);
    preparedExecution().assertCurrent();
    captured.assertCurrent();
    params.assertCurrent?.();
  };
  const createSource = (
    authority?: PreparedSessionSourceAuthority,
  ): AgentDatabaseRequestExecutionSource => ({
    assertCurrent: () => {
      assertCurrent();
      authority?.assertCurrent();
    },
    get readCustody() {
      const identity = readCommittedIdentity() ?? captured.identity;
      return [
        ...(identity.key.startsWith("file:")
          ? [
              {
                sourcePath: options.path,
                candidates: [
                  { path: options.path, physicalPath: identity.canonicalPath, identity },
                ],
              },
            ]
          : []),
        ...(authority?.readCustody ?? []),
      ];
    },
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          const facts = isRecord(request.facts) ? request.facts.publication : undefined;
          if (isRecord(facts) && facts.kind === "voice-session-authority") {
            if (!authority) {
              throw new Error("Voice session authority omitted its prepared assertion");
            }
            if (facts.sourceValidation) {
              acceptSessionSourceValidation(
                authority,
                // SAFETY: voice.session.mutate supplies validation from this transaction.
                facts.sourceValidation as SessionSourceValidation,
              );
            }
            if (facts.facts) {
              if (!authority.transaction) {
                throw new Error("Voice session transaction omitted its prepared assertion");
              }
              // SAFETY: voice.session.mutate supplies the pending-input facts from this transaction.
              authority.transaction.assertCurrent(facts.facts as SessionPendingInputAuthorityFacts);
            }
            authority.assertCurrent();
          }
          if (!grant()) {
            throw new Error("Voice session write authority expired");
          }
        }, binding.attachment),
      });
    },
  });
  function mutate(
    input: VoiceSessionMutation,
    publish?: undefined,
    authority?: PreparedSessionSourceAuthority,
  ): Promise<ClientVoiceSessionRecord | undefined>;
  function mutate<T>(
    input: VoiceSessionMutation,
    publish: (record: ClientVoiceSessionRecord | undefined, entry?: InternalSessionEntry) => T,
    authority?: PreparedSessionSourceAuthority,
  ): Promise<T>;
  async function mutate<T>(
    input: VoiceSessionMutation,
    publish?: (record: ClientVoiceSessionRecord | undefined, entry?: InternalSessionEntry) => T,
    authority?: PreparedSessionSourceAuthority,
  ): Promise<T | ClientVoiceSessionRecord | undefined> {
    const mutation = structuredClone(input);
    const source = createSource(authority);
    return runOpenClawAgentWorkerWrite(options, async () => {
      const retained = await ready;
      if (mutation.kind === "create") {
        await retained.prepare(source);
      }
      const result = await retained.runExisting(source, async (worker) => {
        const committed = await worker.execute({
          type: "voice.session.mutate",
          input: {
            ...mutation,
            ...(authority?.transaction
              ? {
                  transactionSource: {
                    source: authority.transaction.source,
                    agentId: authority.transaction.agentId,
                    sessionKey: authority.transaction.sessionKey,
                  },
                }
              : {}),
            ...(authority?.checks.length
              ? { sources: authority.checks.map((check) => check.predicate) }
              : {}),
          },
        });
        // Install acknowledged facts before releasing the existing writer FIFO.
        return {
          value: publish ? publish(committed.record, committed.entry) : committed.record,
        };
      });
      if (!result) {
        throw new Error("Voice session database is missing");
      }
      return result.value;
    });
  }
  const readCommittedIdentity = () => {
    const committed = preparedExecution().fileIdentity;
    return (
      committed && {
        key: `file:${committed.physicalIdentity}`,
        birthtime: committed.birthtime,
        canonicalPath: committed.nativeLocation,
      }
    );
  };
  return {
    options,
    get identity() {
      return readCommittedIdentity() ?? captured.identity;
    },
    settlementContext: captured.settlementContext,
    get source(): ClientVoiceSessionSource {
      assertCurrent();
      const committed = readCommittedIdentity();
      if (committed) {
        return createClientVoiceSessionSource(options, committed);
      }
      if (captured.identity.key.startsWith("file:")) {
        return captured;
      }
      throw new Error("Voice session creation has not been acknowledged");
    },
    assertCurrent,
    assertLegacyCurrent() {
      assertCurrent();
      const identity = readCommittedIdentity() ?? captured.identity;
      if (identity.key.startsWith("file:")) {
        assertDatabasePathIdentity(options.path, identity);
      }
    },
    get admissionExecution(): OpenClawAgentDatabaseAdmissionExecution {
      return preparedExecution();
    },
    prepare: () => ready,
    adoptNativeDatabase: (database: OpenClawAgentDatabase) =>
      preparedExecution().adoptNativeDatabase(database),
    release: async () => (await pending).release(),
    read(voiceSessionId: string) {
      return runOpenClawAgentWorkerWrite(options, async () =>
        (await ready).runExisting(createSource(), async (worker) => {
          const result = await worker.execute({
            type: "voice.session.read",
            input: { voiceSessionId },
          });
          assertCurrent();
          return result;
        }),
      );
    },
    mutate,
  };
}

export type ClientVoiceSessionWriter = ReturnType<typeof captureClientVoiceSessionWriter>;

export function selectPreparedClientVoiceSource(
  authority: PreparedSessionSourceAuthority,
  identities: ReadonlyMap<string, DatabasePathIdentity>,
) {
  const preparedSources = [
    ...authority.checks.map(({ predicate }) => predicate.source),
    ...(authority.transaction ? [authority.transaction.source] : []),
  ].filter((source) =>
    [...identities.values()].some(
      (identity) =>
        typeof source.databaseIdentity === "string" &&
        identity.key === `file:${source.databaseIdentity}` &&
        identity.birthtime === source.databaseBirthtime,
    ),
  );
  return preparedSources.every(
    (source) => source.databaseIdentity === preparedSources[0]?.databaseIdentity,
  )
    ? preparedSources[0]
    : undefined;
}

/** An explicit source qualifies the run's store; an omitted source retains replay custody. */
export function matchesClientVoiceRunSource(
  owner: { binding: ClientVoiceRunBinding; source: ClientVoiceSessionSource } | undefined,
  binding: ClientVoiceRunBinding,
  source?: ClientVoiceSessionSource,
): boolean {
  return (
    owner?.binding.agentId === binding.agentId &&
    owner.binding.voiceSessionId === binding.voiceSessionId &&
    owner.binding.sessionKey === binding.sessionKey &&
    (!source ||
      (owner.source.identity.key === source.identity.key &&
        owner.source.identity.birthtime === source.identity.birthtime))
  );
}

/** Foreign sources use their publication owner; local predicates belong to the voice writer. */
export async function prepareClientVoiceSessionSourceChecks(
  writer: Pick<ClientVoiceSessionSource, "options" | "identity">,
  authorities: readonly PreparedSessionSourceAuthority[],
): Promise<PreparedSessionSourceAuthority> {
  const checks: PreparedSessionSourceAuthority["checks"] = [];
  const publishedChecks: PreparedSessionSourceAuthority["checks"] = [];
  const foreign = new Map<string | symbol, PreparedSessionSourceAuthority["checks"]>();
  const canAdmitOnce = authorities.every(
    (authority) =>
      !authority.nativeSource && !authority.opaqueCommitGuard && !authority.hasOpaqueCheck,
  );
  for (const check of authorities.flatMap((authority) => authority.checks)) {
    const source = check.predicate.source;
    if (
      typeof source.databaseIdentity === "string" &&
      `file:${source.databaseIdentity}` === writer.identity.key &&
      source.databaseBirthtime === writer.identity.birthtime
    ) {
      checks.push(check);
    } else {
      if (admitPublishedSessionSource(check.predicate)) {
        // Opaque guards keep live checks through native commit; ordinary writes admit once.
        if (!canAdmitOnce) {
          publishedChecks.push(check);
        }
        continue;
      }
      const group = foreign.get(source.databaseIdentity) ?? [];
      group.push(check);
      foreign.set(source.databaseIdentity, group);
    }
  }
  const assertAuthoritiesCurrent = () => {
    authorities.forEach((authority) => authority.assertCurrent());
    publishedChecks.forEach(({ predicate }) => {
      if (!admitPublishedSessionSource(predicate)) {
        throw new Error("Voice session source is unavailable");
      }
    });
  };
  if (foreign.size === 0) {
    return {
      nativeSource: publishedChecks.length > 0,
      checks,
      assertCurrent: assertAuthoritiesCurrent,
    };
  }
  const [
    { retainOpenClawAgentDatabaseReadOnly },
    { readOpenClawAgentDatabaseIdentity },
    { readSessionSourceValidation },
    { hasSqliteSessionOwnerColumns },
  ] = await Promise.all([
    import("../state/openclaw-agent-db-readonly.js"),
    import("../state/openclaw-agent-db-identity.js"),
    import("../config/sessions/session-source-predicate.worker.js"),
    import("../config/sessions/session-accessor.sqlite-owner-projection.js"),
  ]);
  const resources: Pick<PreparedSessionSourceAuthority, "release">[] = [];
  const release = () => releaseSessionSourceAuthorities(resources);
  const assertions: (() => void)[] = [];
  try {
    assertAuthoritiesCurrent();
    for (const group of foreign.values()) {
      const source = group[0]!.predicate.source;
      const assertPathsCurrent = () => {
        for (const { predicate } of group) {
          if (typeof predicate.source.databaseIdentity === "string") {
            assertExistingDatabaseIdentity(
              predicate.source.path,
              `file:${predicate.source.databaseIdentity}`,
              predicate.source.databaseBirthtime,
            );
          }
        }
      };
      assertPathsCurrent();
      const retained = retainOpenClawAgentDatabaseReadOnly({
        ...writer.options,
        agentId: source.agentId,
        path: source.path,
      });
      if (!retained.found) {
        throw new Error("Voice session source is unavailable");
      }
      resources.push(retained.claim);
      const identity = readOpenClawAgentDatabaseIdentity(retained.database);
      if (
        identity.identity !== source.databaseIdentity ||
        identity.birthtime !== source.databaseBirthtime
      ) {
        throw new Error("Voice session source changed its captured database owner");
      }
      // A first native query can discover owner columns; do that before worker grants.
      hasSqliteSessionOwnerColumns(retained.database.db);
      const predicates = group.map((check) => check.predicate);
      assertions.push(() => {
        assertPathsCurrent();
        retained.claim.assertCurrent();
        acceptSessionSourceValidation(
          { checks: group, assertCurrent: assertAuthoritiesCurrent },
          readSessionSourceValidation(retained.database, predicates),
        );
      });
    }
    return {
      nativeSource: true,
      checks,
      assertCurrent: () => {
        assertAuthoritiesCurrent();
        assertions.forEach((assertCurrent) => assertCurrent());
      },
      release,
    };
  } catch (error) {
    await releaseSessionSourceAuthorities(resources, [error]);
    throw error;
  }
}

export type ClientVoiceRun = {
  binding: ClientVoiceRunBinding;
  source: ClientVoiceSessionSource;
  settlement?: ReturnType<typeof captureClientVoiceSessionSettlement>;
  stopObserving?: () => void;
  retired?: true;
};
