import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import {
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
  type SessionSourcePredicateFacts,
} from "../config/sessions/session-source-authority.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
  isSessionStoreReadCandidateCurrent,
} from "../config/sessions/session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "../config/sessions/session-store-target-inventory.js";
import { retainSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
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
import { captureSessionSharingMemoryFacts } from "./session-sharing-incognito.js";
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

/** Capture the complete selector family before resolving its physical owner. */
function captureSessionSharingStore(
  target: Pick<SessionSharingTarget, "agentId" | "storePath" | "readSource">,
  env: NodeJS.ProcessEnv,
  assertCallerCurrent: () => void,
) {
  const candidates = captureSessionStoreReadCandidates(target.storePath);
  const { agentId, storePath, readSource } = target;
  if (readSource) {
    const known = captureSessionStoreReadCandidate(readSource.path);
    if (
      !candidates.some((candidate) =>
        matchesAgentDatabaseReadCandidatePath(
          { ...candidate, path: candidate.physicalPath },
          known.physicalPath,
        ),
      )
    ) {
      throw new Error("Session sharing source changed");
    }
    // Listing may fail even while the admitted exact file remains accessible.
    candidates.push(known);
  }
  const identities = captureSessionStoreCandidateIdentities(candidates);
  return async () => {
    assertCallerCurrent();
    const resolved =
      readSource ?? (await prepareSqliteTargetFromSessionStorePath(storePath, { agentId, env }));
    const assertSourcePathCurrent = () => {
      if (!candidates.every(isSessionStoreReadCandidateCurrent)) {
        throw new Error("Session sharing source changed");
      }
      try {
        return assertSessionStoreReadCandidate(resolved.path, candidates);
      } catch (cause) {
        throw new Error("Session sharing source changed", { cause });
      }
    };
    const pathname = assertSourcePathCurrent();
    const identity = identities.get(pathname);
    if (!resolved.agentId || !identity?.key.startsWith("file:")) {
      throw new Error("Session sharing source is unavailable");
    }
    const source: CapturedSessionEntryReadSource = readSource ?? {
      agentId: resolved.agentId,
      path: pathname,
      databaseIdentity: identity.key.slice("file:".length),
      databaseBirthtime: identity.birthtime,
    };
    const databaseIdentity = source.databaseIdentity;
    if (typeof databaseIdentity !== "string") {
      throw new Error("Session sharing reader requires a file-backed source");
    }
    const assertCurrent = () => {
      assertSourcePathCurrent();
      assertExistingDatabaseIdentity(pathname, identity.key, identity.birthtime);
      assertExistingDatabaseIdentity(
        source.path,
        `file:${databaseIdentity}`,
        source.databaseBirthtime,
      );
    };
    assertCallerCurrent();
    assertCurrent();
    return { source, assertCurrent };
  };
}

/** Hold the existing reader only until the prepared writer operation settles. */
export async function prepareSessionSharingSource(
  target: Pick<
    SessionSharingTarget,
    "agentId" | "canonicalKey" | "storeKey" | "storePath" | "readSource"
  >,
  assertCallerCurrent: () => void,
  memoryFacts?: NonNullable<ReturnType<typeof captureSessionSharingMemoryFacts>>,
) {
  const read =
    memoryFacts ??
    captureSessionSharingMemoryFacts(
      {
        agentId: target.agentId,
        sessionKey: target.storeKey,
        resolved: target,
      },
      assertCallerCurrent,
    );
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
      get source() {
        return read.source;
      },
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
    NonNullable<ReturnType<typeof captureSessionSharingMemoryFacts>>
  >();
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
      const bound = boundSources.get(target)?.readCurrent();
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
  for (const target of params.targets) {
    const facts = captureSessionSharingMemoryFacts(target, assertSourceCurrent);
    if (facts) {
      boundSources.set(target, facts);
    }
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
        prepared.push(await prepareSessionSharingSource(target, assertSourceCurrent, bound));
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
