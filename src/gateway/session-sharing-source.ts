import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import {
  captureIncognitoSessionBinding,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import {
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
  type SessionSourcePredicateFacts,
} from "../config/sessions/session-source-authority.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import { captureSessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "../config/sessions/session-store-target-inventory.js";
import { retainSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import { matchesAgentDatabaseReadCandidatePath } from "../state/openclaw-agent-db-resources.js";
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
  captureSessionSharingIncognitoBinding,
  hasNativeIncognitoSessionSharingSource,
} from "./session-sharing-incognito.js";
import {
  authorizeOwnSessionMutation,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { captureSessionMutationRouting } from "./session-sharing-preparation.js";
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
) {
  const binding = captureIncognitoSessionBinding({
    agentId: target.agentId,
    sessionKey: target.storeKey,
    storePath: target.readSource?.path ?? target.storePath,
  });
  if (binding) {
    const { actor } = binding;
    const read = captureIncognitoSessionMutationFacts(binding, target.storeKey, true);
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
      read.assertCurrent();
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
      actorSource: true,
      source,
      get target() {
        return read.readCurrent().target;
      },
      get members() {
        return [...read.readCurrent().membership];
      },
      assertCurrent,
      release() {
        active = false;
        done.resolve();
        return work;
      },
    };
  }
  const locators = captureSessionStoreReadCandidates(target.storePath);
  const candidate = captureSessionStoreReadCandidate(
    target.readSource?.path ??
      resolveUnsuffixedSqliteTargetFromSessionStorePath(target.storePath).path,
  );
  if (
    !locators.some((locator) =>
      matchesAgentDatabaseReadCandidatePath(
        { ...locator, path: locator.physicalPath },
        candidate.physicalPath,
      ),
    )
  ) {
    throw new Error("Session sharing source changed");
  }
  const identity = readDatabasePathIdentitySync(candidate.physicalPath);
  if (!target.readSource && !identity.key.startsWith("file:")) {
    throw new Error("Session sharing source is unavailable");
  }
  const source: CapturedSessionEntryReadSource = target.readSource ?? {
    agentId: target.agentId,
    path: candidate.physicalPath,
    databaseIdentity: identity.key.slice("file:".length),
    databaseBirthtime: identity.birthtime,
  };
  const databaseIdentity = source.databaseIdentity;
  if (typeof databaseIdentity !== "string") {
    throw new Error("Session sharing reader requires a file-backed source");
  }
  const assertSourceCurrent = () => {
    assertCallerCurrent();
    assertExistingDatabaseIdentity(
      source.path,
      `file:${databaseIdentity}`,
      source.databaseBirthtime,
    );
    if (captureSessionStoreReadCandidate(candidate.path).physicalPath !== candidate.physicalPath) {
      throw new Error("Session sharing source changed");
    }
    for (const locator of locators) {
      if (
        captureSessionStoreReadCandidate(locator.path, locator.scope).physicalPath !==
        locator.physicalPath
      ) {
        throw new Error("Session sharing source changed");
      }
    }
  };
  assertSourceCurrent();
  const env = captureSessionTranscriptStorageEnvironment(process.env);
  const retained = retainSessionHistoryWorkerDatabase({
    agentId: source.agentId,
    path: source.path,
    env,
  });
  const assertCurrent = () => {
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
      actorSource: false,
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
  assertTalkTargetCurrent: (cfg: OpenClawConfig) => void;
  assertTargetCurrent: (
    target: SessionMutationTarget,
    expected: AuthorizedSessionMutationTarget | undefined,
    cfg: OpenClawConfig,
    caches?: SessionSharingLookupCaches,
    ensuredSessionId?: string,
    prepared?: { target: SessionSharingTarget | null; members: readonly string[] },
  ) => void;
}): SessionSourceAssertion {
  const boundSources = new Map(
    params.targets.flatMap((target) => {
      const binding = captureSessionSharingIncognitoBinding(target);
      return binding
        ? [
            [
              target,
              {
                binding,
                facts: captureIncognitoSessionMutationFacts(binding, target.sessionKey, true),
              },
            ] as const,
          ]
        : [];
    }),
  );
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
    params.assertTalkTargetCurrent(cfg);
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
      );
    }
  };
  if (hasNativeIncognitoSessionSharingSource(params.targets)) {
    return Object.assign(assertCurrent, { nativeSource: true });
  }
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
            ? withIncognitoSessionBinding(bound.binding, () =>
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
  return (cfg: OpenClawConfig) => {
    if (!input || !target) {
      return;
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
