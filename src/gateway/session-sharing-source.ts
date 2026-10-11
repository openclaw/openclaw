import { readExactSessionEntryRowValidated } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import {
  captureIncognitoSessionBinding,
  withIncognitoSessionBinding,
  type IncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import { listSessionMembersInDatabase } from "../config/sessions/session-sharing-store.kernel.js";
import {
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
  type SessionSourcePredicateFacts,
} from "../config/sessions/session-source-authority.js";
import { retainSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  assertDatabasePathIdentity,
  assertExistingDatabaseIdentity,
} from "../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  assertIncognitoAgentDatabasePathAvailable,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { authorizeGatewaySessionCreation } from "./operator-role-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import {
  createSessionSharingLookupCaches,
  sessionMutationTargetChanged,
  type AuthorizedSessionMutationTarget,
  type SessionSharingLookupCaches,
  type SessionMutationAuthorizationParams,
} from "./session-sharing-authorization.js";
import {
  captureIncognitoSessionMutationFacts,
  captureSessionActorMutationFacts,
  captureSessionSharingActorBinding,
  captureSessionSharingIncognitoBinding,
  hasNativeIncognitoSessionSharingSource,
} from "./session-sharing-incognito.js";
import {
  authorizeOwnSessionMutation,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { captureSessionMutationRouting } from "./session-sharing-preparation.js";
import { captureSessionSharingStore } from "./session-sharing-source-store.js";
import type {
  SessionMutationTarget,
  resolveTalkSessionTargetInput,
} from "./session-sharing-target-input.js";
import { prepareTalkSessionTarget, assertTalkSessionStorageTarget } from "./talk/session-target.js";
import type { PreparedTalkSessionTarget } from "./talk/session-target.types.js";

/** Hold the existing reader only until the prepared writer operation settles. */
export async function prepareSessionSharingSource(
  target: Pick<
    SessionSharingTarget,
    "agentId" | "canonicalKey" | "storeKey" | "storePath" | "readSource"
  >,
  assertCallerCurrent: () => void,
  memoryFacts?: ReturnType<typeof captureSessionActorMutationFacts>,
) {
  const memoryBinding = memoryFacts
    ? undefined
    : captureSessionSharingActorBinding({
        agentId: target.agentId,
        sessionKey: target.storeKey,
        resolved: target,
      });
  const read =
    memoryFacts ??
    (memoryBinding &&
      captureSessionActorMutationFacts(
        memoryBinding,
        target.storeKey,
        true,
        target.readSource?.path ?? target.storePath,
      ));
  if (read) {
    if (
      target.agentId !== read.location.agentId ||
      (target.readSource &&
        !isSameSessionSharingSource(
          { readSource: read.source, storePath: read.location.path },
          target,
        ))
    ) {
      throw new Error("Session sharing source changed");
    }
    let active = true;
    const assertCurrent = () => {
      if (!active) {
        throw new Error("Session sharing source is no longer retained");
      }
      assertCallerCurrent();
      read.assertCurrent();
    };
    assertCurrent();
    return {
      actorSource: true as const,
      source: read.source,
      get target() {
        return read.readCurrent().target;
      },
      get members() {
        return [...read.readCurrent().membership];
      },
      assertCurrent,
      async release() {
        active = false;
      },
    };
  }
  const binding = captureIncognitoSessionBinding({
    agentId: target.agentId,
    sessionKey: target.storeKey,
    storePath: target.readSource?.path ?? target.storePath,
  });
  if (binding) {
    const { actor } = binding;
    const nativeRead = captureIncognitoSessionMutationFacts(binding, target.storeKey, true);
    const source = {
      agentId: actor.agentId,
      path: actor.path,
      databaseIdentity: actor.identity.incarnation,
    };
    if (
      target.readSource &&
      !isSameSessionSharingSource({ readSource: source, storePath: actor.path }, target)
    ) {
      throw new Error("Session sharing source changed");
    }
    let active = true;
    const assertCurrent = () => {
      if (!active) {
        throw new Error("Session sharing source is no longer retained");
      }
      assertCallerCurrent();
      nativeRead.assertCurrent();
    };
    assertCurrent();
    const done = createDeferredCore();
    const ready = createDeferredCore();
    const work = actor.sessions.withSharedState(async () => {
      assertCurrent();
      ready.resolve();
      await done.promise;
    });
    void work.catch(ready.reject);
    try {
      await ready.promise;
      assertCurrent();
    } catch (error) {
      active = false;
      done.resolve();
      await releaseSessionSourceAuthorities([{ release: () => work }], [error]);
      throw error;
    }
    return {
      actorSource: true as const,
      source,
      get target() {
        return nativeRead.readCurrent().target;
      },
      get members() {
        return [...nativeRead.readCurrent().membership];
      },
      assertCurrent,
      release() {
        active = false;
        done.resolve();
        return work;
      },
    };
  }
  const env = captureSessionTranscriptStorageEnvironment(process.env);
  const prepareSource = captureSessionSharingStore(target, env, assertCallerCurrent);
  const { source, assertCurrent: assertSourceCurrent } = await prepareSource();
  const retained = retainSessionHistoryWorkerDatabase({
    agentId: source.agentId,
    path: source.path,
    env,
  });
  const assertCurrent = () => {
    assertCallerCurrent();
    assertSourceCurrent();
    retained.owner.assertCurrent();
  };
  try {
    const result = await retained.owner.readExactEntries({
      sessionKeys: [target.storeKey],
      projection: "sharing",
      includeAuthorization: true,
      env,
    });
    assertCurrent();
    if (
      result.databaseIdentity?.identity !== source.databaseIdentity ||
      result.databaseIdentity?.birthtime !== source.databaseBirthtime
    ) {
      throw new Error("Session sharing source changed");
    }
    const entry = result.entries.find(({ sessionKey }) => sessionKey === target.storeKey)?.entry;
    return {
      actorSource: false as const,
      source,
      target: entry ? { ...target, readSource: source, storeKeys: [target.storeKey], entry } : null,
      members:
        result.sharing?.members.find((row) => row.sessionKey === target.storeKey)?.identityIds ??
        [],
      assertCurrent,
      release: retained.release,
    };
  } catch (error) {
    await releaseSessionSourceAuthorities([retained], [error]);
    throw error;
  }
}

/** Storage facts are prepared here; the sharing owner supplies every access decision. */
export function withPreparedSessionSharingSource(params: {
  targets: AuthorizedSessionMutationTarget[];
  sourceConfig: OpenClawConfig;
  request: SessionMutationAuthorizationParams;
  ownSessionProfileId?: string;
  talk: ReturnType<typeof resolveTalkSessionTargetInput>;
  assertTalkTargetCurrent: (cfg: OpenClawConfig) => PreparedTalkSessionTarget | undefined;
  assertTargetCurrent: (
    target: SessionMutationTarget,
    expected: AuthorizedSessionMutationTarget | undefined,
    cfg: OpenClawConfig,
    caches?: SessionSharingLookupCaches,
    ensuredSessionId?: string,
    prepared?: { target: SessionSharingTarget | null; members: readonly string[] },
    currentTalkTarget?: PreparedTalkSessionTarget,
  ) => void;
}): SessionSourceAssertion {
  const boundSources = new Map<
    AuthorizedSessionMutationTarget,
    | {
        kind: "memory";
        facts: ReturnType<typeof captureSessionActorMutationFacts>;
      }
    | {
        kind: "native";
        binding: IncognitoSessionBinding;
        facts: ReturnType<typeof captureIncognitoSessionMutationFacts>;
      }
  >();
  for (const target of params.targets) {
    const memoryBinding = captureSessionSharingActorBinding(target);
    if (memoryBinding) {
      boundSources.set(target, {
        kind: "memory",
        facts: captureSessionActorMutationFacts(
          memoryBinding,
          target.sessionKey,
          true,
          target.resolved?.readSource?.path ??
            target.resolved?.storePath ??
            target.absentTarget?.storePath,
        ),
      });
      continue;
    }
    const binding = captureSessionSharingIncognitoBinding(target);
    if (binding) {
      boundSources.set(target, {
        kind: "native",
        binding,
        facts: captureIncognitoSessionMutationFacts(binding, target.sessionKey, true),
      });
    }
  }
  const targetChanged = (key: string) => sessionMutationTargetChanged(params.request.method, key);
  const assertSource = () => {
    const error = authorizeOwnSessionMutation({
      client: params.request.client,
      target: null,
      expectedProfileId: params.ownSessionProfileId,
    });
    if (error) {
      throw new SessionMutationAuthorizationChangedError(error);
    }
    return params.request.context.getRuntimeConfig();
  };
  const assertCurrent = () => {
    const cfg = assertSource();
    const currentTalkTarget = params.assertTalkTargetCurrent(cfg);
    const caches = createSessionSharingLookupCaches();
    for (const target of params.targets) {
      const bound = boundSources.get(target)?.facts.readCurrent();
      params.assertTargetCurrent(
        target,
        target,
        cfg,
        caches,
        undefined,
        bound && {
          target: bound.target,
          members: [...bound.membership],
        },
        currentTalkTarget,
      );
    }
  };
  const changed = () => targetChanged(params.targets[0]?.sessionKey ?? "");
  const assertRoutingCurrent = captureSessionMutationRouting(params.sourceConfig, changed);
  const talkAgentId = params.sourceConfig.talk?.agentId;
  const assertSourceCurrent = () => {
    const cfg = assertSource();
    assertRoutingCurrent(cfg);
    if (
      (params.talk && cfg.talk?.agentId !== talkAgentId) ||
      (params.talk?.kind === "relay" && !params.talk.isCurrent())
    ) {
      throw changed();
    }
  };
  // Unselected incognito sources remain native until the acquisition cutover.
  if (hasNativeIncognitoSessionSharingSource(params.targets)) {
    if (boundSources.size > 0) {
      return Object.assign(assertCurrent, { nativeSource: true });
    }
    const env = captureSessionTranscriptStorageEnvironment(process.env);
    return Object.assign(assertCurrent, {
      nativeSource: true,
      prepareSessionSource: () =>
        prepareNativeSessionSharingSource(params, env, assertSourceCurrent),
    });
  }
  const prepare = async (): Promise<PreparedSessionSourceAuthority> => {
    const prepared: Awaited<ReturnType<typeof prepareSessionSharingSource>>[] = [];
    const release = () => releaseSessionSourceAuthorities(prepared);
    try {
      assertSourceCurrent();
      const targets = params.targets.map((expected) => {
        const route = expected.resolved ?? expected.absentTarget;
        if (!route) {
          throw targetChanged(expected.sessionKey);
        }
        return { ...route, storeKey: expected.resolved?.storeKey ?? route.canonicalKey };
      });
      for (const [index, target] of targets.entries()) {
        const bound = boundSources.get(params.targets[index]!);
        prepared.push(
          await (bound
            ? bound.kind === "memory"
              ? prepareSessionSharingSource(target, assertSourceCurrent, bound.facts)
              : withIncognitoSessionBinding(bound.binding, () =>
                  prepareSessionSharingSource(target, assertSourceCurrent),
                )
            : prepareSessionSharingSource(target, assertSourceCurrent)),
        );
      }
      const assertPrepared = (index: number, facts?: SessionSourcePredicateFacts) => {
        const read = prepared[index]!;
        if (!facts) {
          read.assertCurrent();
        }
        assertSourceCurrent();
        const expected = params.targets[index]!;
        params.assertTargetCurrent(expected, expected, assertSource(), undefined, undefined, {
          target: facts
            ? facts.entry
              ? {
                  ...targets[index]!,
                  storeKeys: [targets[index]!.storeKey],
                  readSource: read.source,
                  entry: facts.entry,
                }
              : null
            : read.target,
          members: facts?.members ?? read.members,
        });
      };
      const assertPreparedCurrent = () => {
        assertSourceCurrent();
        for (let index = 0; index < prepared.length; index += 1) {
          assertPrepared(index);
        }
      };
      assertPreparedCurrent();
      return {
        assertCurrent: assertPreparedCurrent,
        checks: prepared.flatMap((read, index) =>
          read.actorSource
            ? []
            : [
                {
                  predicate: {
                    source: read.source,
                    sessionKey: targets[index]!.storeKey,
                    fields: [
                      "sessionId",
                      "lifecycleRevision",
                      "createdActor",
                      "visibility",
                      "incognito",
                      "sandbox",
                    ],
                    expected: read.target?.entry,
                    members: read.members,
                  },
                  refuse: (facts) => {
                    assertPrepared(index, facts);
                    throw targetChanged(params.targets[index]!.sessionKey);
                  },
                },
              ],
        ),
        release,
      };
    } catch (error) {
      await releaseSessionSourceAuthorities(prepared, [error]);
      throw error;
    }
  };
  return Object.assign(assertCurrent, {
    prepareSessionSource: prepare,
    ...(boundSources.size ? { prepareSessionSourceScope: prepare } : {}),
  });
}

async function prepareNativeSessionSharingSource(
  params: Parameters<typeof withPreparedSessionSharingSource>[0],
  env: NodeJS.ProcessEnv,
  assertSourceCurrent: () => void,
): Promise<PreparedSessionSourceAuthority> {
  const resources: Pick<PreparedSessionSourceAuthority, "release">[] = [];
  const release = () => releaseSessionSourceAuthorities(resources);
  try {
    assertSourceCurrent();
    const sharedContext = captureOpenClawStateReadWorkerContext({ env });
    const sharedIdentity = sharedContext.admission.identity;
    const retainSource = (agentId: string, path: string) => {
      const retained = retainOpenClawAgentDatabaseReadOnly({ agentId, path, env });
      if (!retained.found) {
        throw new Error("Session sharing source is unavailable");
      }
      resources.push(retained.claim);
      return retained;
    };
    const selections = params.targets.map((expected) => {
      const target = expected.resolved ?? expected.absentTarget;
      if (!target) {
        throw sessionMutationTargetChanged(params.request.method, expected.sessionKey);
      }
      if (isIncognitoSessionKey(expected.sessionKey)) {
        // Pin every process-held source before durable owner discovery can yield.
        const pathname = resolveIncognitoOpenClawAgentSqlitePath({ agentId: target.agentId, env });
        return {
          expected,
          target,
          incognito: true as const,
          retained: retainSource(target.agentId, pathname),
        };
      }
      return {
        expected,
        target,
        incognito: false as const,
        prepareSource: captureSessionSharingStore(target, env, assertSourceCurrent),
      };
    });
    const reads: Array<
      Pick<(typeof selections)[number], "expected" | "target" | "incognito"> & {
        retained: ReturnType<typeof retainSource>;
        readSource: CapturedSessionEntryReadSource;
        assertSourceCurrent: (() => void) | undefined;
        key: string;
      }
    > = [];
    for (const selection of selections) {
      const { expected, target, incognito } = selection;
      const native = selection.incognito
        ? { retained: selection.retained, assertCurrent: undefined }
        : await selection.prepareSource().then((prepared) => ({
            retained: retainSource(prepared.source.agentId, prepared.source.path),
            assertCurrent: prepared.assertCurrent,
          }));
      const retained = native.retained;
      const identity = readOpenClawAgentDatabaseIdentity(retained.database);
      const readSource = {
        agentId: retained.database.agentId,
        path: retained.database.path,
        databaseIdentity: identity.identity,
        databaseBirthtime: identity.birthtime,
      };
      reads.push({
        expected,
        target,
        incognito,
        retained,
        readSource,
        assertSourceCurrent: native.assertCurrent,
        key: expected.resolved?.storeKey ?? target.canonicalKey,
      });
    }
    const [{ prepareOpenClawStateCurrentReader }, { readAgentDeletionJournalInDatabase }] =
      await Promise.all([
        import("../state/openclaw-state-db-current-reader.js"),
        import("../state/agent-deletion-journal.js"),
      ]);
    const shared = await prepareOpenClawStateCurrentReader(sharedContext);
    if (shared) {
      resources.push({ release: () => shared.dispose() });
    }
    const assertCurrent = () => {
      assertSourceCurrent();
      if (!shared) {
        // Native one-shots may have no shared state; later creation revokes that absence.
        sharedContext.maintenanceScope?.assertReadAdmission();
        sharedContext.admission.assertCurrent();
        assertDatabasePathIdentity(sharedContext.admission.databasePath, sharedIdentity);
      }
      for (const read of reads) {
        read.assertSourceCurrent?.();
        read.retained.claim.assertCurrent();
        if (read.incognito) {
          assertIncognitoAgentDatabasePathAvailable(read.readSource.path);
        } else {
          assertExistingDatabaseIdentity(
            read.readSource.path,
            `file:${String(read.readSource.databaseIdentity)}`,
            read.readSource.databaseBirthtime,
          );
        }
        if (
          shared?.read((database) =>
            readAgentDeletionJournalInDatabase(database, read.target.agentId, "runtime"),
          )
        ) {
          throw new Error(
            `OpenClaw agent database is unavailable while agent ${read.target.agentId} is deleted.`,
          );
        }
        const entry = readExactSessionEntryRowValidated(
          read.retained.database,
          read.key,
          "list",
        )?.entry;
        params.assertTargetCurrent(
          read.expected,
          read.expected,
          params.request.context.getRuntimeConfig(),
          undefined,
          undefined,
          {
            target: entry
              ? {
                  ...read.target,
                  storeKey: read.key,
                  storeKeys: [read.key],
                  readSource: read.readSource,
                  entry,
                }
              : null,
            members: listSessionMembersInDatabase(read.retained.database, read.key).map(
              (member) => member.identityId,
            ),
          },
        );
      }
    };
    assertCurrent();
    return { nativeSource: true, checks: [], assertCurrent, release };
  } catch (error) {
    await releaseSessionSourceAuthorities(resources, [error]);
    throw error;
  }
}

export function captureSessionSharingTalkAuthority({
  request,
  input,
  target,
  authorizesAgentRun,
}: {
  request: SessionMutationAuthorizationParams;
  input: ReturnType<typeof resolveTalkSessionTargetInput>;
  target: PreparedTalkSessionTarget | undefined;
  authorizesAgentRun: boolean;
}) {
  return (cfg: OpenClawConfig): PreparedTalkSessionTarget | undefined => {
    if (!input || !target) {
      return undefined;
    }
    let current: PreparedTalkSessionTarget;
    try {
      if (input.kind === "relay") {
        if (!input.isCurrent()) {
          throw sessionMutationTargetChanged(request.method, target.sessionKey);
        }
        assertTalkSessionStorageTarget(cfg, target);
        current = target;
      } else {
        current = prepareTalkSessionTarget(cfg, input.sessionKey);
      }
    } catch {
      throw sessionMutationTargetChanged(request.method, target.sessionKey);
    }
    if (
      current.agentId !== target.agentId ||
      current.sessionKey !== target.sessionKey ||
      current.canonicalKey !== target.canonicalKey ||
      current.storePath !== target.storePath
    ) {
      throw sessionMutationTargetChanged(request.method, target.sessionKey);
    }
    const error =
      authorizesAgentRun &&
      authorizeGatewaySessionCreation({
        cfg: request.context.getCommittedRuntimeConfig?.() ?? cfg,
        client: request.client,
        agentId: current.agentId,
      });
    if (error) {
      throw new SessionMutationAuthorizationChangedError(error);
    }
    return current;
  };
}

export function isSameSessionSharingSource(
  current: Pick<SessionSharingTarget, "readSource" | "storePath">,
  expected: Pick<SessionSharingTarget, "readSource" | "storePath">,
): boolean {
  const source = expected.readSource;
  return source
    ? current.readSource?.databaseIdentity === source.databaseIdentity &&
        current.readSource.databaseBirthtime === source.databaseBirthtime &&
        current.readSource.agentId === source.agentId
    : current.storePath === expected.storePath;
}

export function resolveSessionSharingMembership(
  target: SessionSharingTarget,
  identityId: string | undefined,
  members: readonly string[] | undefined,
  projection: SessionRowProjection | undefined,
): boolean | undefined {
  return members
    ? Boolean(identityId && members.includes(identityId))
    : projection &&
        Boolean(
          identityId && projection.hasMembership(target.storePath, target.storeKey, identityId),
        );
}
