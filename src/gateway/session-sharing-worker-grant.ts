import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import { assertCapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.js";
import {
  captureIncognitoSessionBinding,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import { hasSessionMemberInDatabase } from "../config/sessions/session-sharing-store.kernel.js";
import {
  releaseSessionSourceAuthorities,
  type SessionSourceTransactionGrant,
} from "../config/sessions/session-source-authority.js";
import { captureSessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import {
  captureSessionStoreReadCandidates,
  createSessionStoreRegistryMutationFilter,
} from "../config/sessions/session-store-target-inventory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { captureOpenClawAgentReadOnlyAdmission } from "../state/openclaw-agent-db-readonly-open.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../state/openclaw-agent-db-registry-listing.js";
import { matchesAgentDatabaseReadCandidatePath } from "../state/openclaw-agent-db-resources.js";
import { authorizeGatewaySessionCreation } from "./operator-role-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import {
  sessionMutationTargetChanged,
  findPreparedSharingTarget,
  prepareAuthorizedSessionMutationFacts,
  type AuthorizedSessionMutationTarget,
  type PreparedMutationSharing,
  type SessionMutationAuthorizationParams,
} from "./session-sharing-authorization.js";
import {
  captureSessionActorMutationFacts,
  captureSessionSharingActorBinding,
} from "./session-sharing-incognito.js";
import {
  captureSessionMutationRouting,
  prepareSessionMutationFacts,
} from "./session-sharing-preparation.js";
import {
  prepareProjectedSessionSharing,
  prepareSessionSharingProfiles,
  type PreparedSessionSharingProfiles,
} from "./session-sharing-read.js";
import { prepareSessionSharingSource } from "./session-sharing-source.js";

/** Legacy locators keep exact agent-store authority without rediscovering shared-state ownership. */
export async function prepareSessionSharingWorkerGrant(params: {
  targets: readonly AuthorizedSessionMutationTarget[];
  request: SessionMutationAuthorizationParams;
  sourceConfig: OpenClawConfig;
  authorizesAgentRun: boolean;
  transactionFacts?: boolean;
  transactionSource?: Omit<SessionSourceTransactionGrant, "assertCurrent">;
  consume: (
    expected: AuthorizedSessionMutationTarget,
    cfg: OpenClawConfig,
    facts: PreparedMutationSharing,
    profiles: PreparedSessionSharingProfiles,
  ) => void;
}) {
  const targets = params.targets.map((target) => {
    const memoryBinding = captureSessionSharingActorBinding(target);
    return {
      ...target,
      resolved: target.resolved && { ...target.resolved },
      memoryFacts:
        memoryBinding &&
        captureSessionActorMutationFacts(
          memoryBinding,
          target.sessionKey,
          true,
          target.resolved?.readSource?.path ??
            target.resolved?.storePath ??
            target.absentTarget?.storePath,
        ),
      binding: memoryBinding
        ? undefined
        : captureIncognitoSessionBinding({
            agentId: target.agentId,
            sessionKey: target.sessionKey,
            storePath: target.resolved?.readSource?.path ?? target.resolved?.storePath,
          }),
    };
  });
  const changed = (key = targets[0]?.sessionKey ?? "") =>
    sessionMutationTargetChanged(params.request.method, key);
  if (params.transactionSource && (!params.transactionFacts || targets.length !== 1)) {
    throw changed();
  }
  const assertRouting = captureSessionMutationRouting(params.sourceConfig, changed, targets);
  const talkAgentId = params.sourceConfig.talk?.agentId;
  let active = true;
  const releases: Array<{ release: () => void | Promise<void> }> = [];
  const sourceChecks: Array<() => void> = [];
  let transaction: SessionSourceTransactionGrant | undefined;
  const release = () => {
    active = false;
    return releaseSessionSourceAuthorities(releases.splice(0));
  };
  try {
    const reads: Array<(profiles: PreparedSessionSharingProfiles) => void> = [];
    for (const expected of targets) {
      const initialConfig = params.request.context.getRuntimeConfig();
      assertRouting(initialConfig);
      if (expected.memoryFacts || expected.binding) {
        const target = expected.resolved;
        if (!target) {
          throw changed(expected.sessionKey);
        }
        const prepare = () =>
          prepareSessionSharingSource(target, () =>
            assertRouting(params.request.context.getRuntimeConfig()),
          );
        const source = await (expected.memoryFacts
          ? prepareSessionSharingSource(
              target,
              () => assertRouting(params.request.context.getRuntimeConfig()),
              expected.memoryFacts,
            )
          : withIncognitoSessionBinding(expected.binding!, prepare));
        releases.push(source);
        sourceChecks.push(source.assertCurrent);
        reads.push((profiles) => {
          source.assertCurrent();
          params.consume(
            expected,
            params.request.context.getRuntimeConfig(),
            {
              target: source.target,
              storageTarget: target,
              members: [],
              isMember: (id) => source.members.includes(id),
              assertCurrent: source.assertCurrent,
            },
            profiles,
          );
        });
        continue;
      }
      const durableRoute = expected.resolved ?? expected.absentTarget;
      if (!durableRoute) {
        throw changed(expected.sessionKey);
      }
      if (typeof durableRoute.readSource?.databaseIdentity !== "symbol") {
        const prepared = findPreparedSharingTarget(params.request, expected);
        const retained = prepared
          ? undefined
          : await prepareSessionMutationFacts({
              cfg: initialConfig,
              sessionKey: expected.sessionKey,
              agentId: durableRoute.agentId,
              allowMissing: true,
            });
        if (retained) {
          releases.push(retained);
        }
        const sourceFacts = retained?.readCurrent(initialConfig);
        const sourcePath = sourceFacts?.sourcePath;
        const sourceIdentity = sourcePath && readDatabasePathIdentitySync(sourcePath);
        const fallbackSource =
          sourcePath && sourceIdentity
            ? {
                agentId: sourceFacts?.sourceAgentId ?? durableRoute.agentId,
                path: sourcePath,
                databaseIdentity: sourceIdentity.key.slice("file:".length),
                databaseBirthtime: sourceIdentity.birthtime,
              }
            : durableRoute.readSource;
        const read = (): PreparedMutationSharing => {
          if (prepared) {
            return prepared.read();
          }
          const facts = retained!.readCurrent(params.request.context.getRuntimeConfig());
          return {
            target: facts.target && { ...facts.target, readSource: fallbackSource },
            storageTarget: retained!.storageTarget,
            members: [],
            isMember: (id) => facts.membership.has(id),
            assertCurrent: () => {
              retained!.readCurrent(params.request.context.getRuntimeConfig());
            },
          };
        };
        const initial = read();
        if (params.transactionFacts && targets.length === 1) {
          const provided = params.transactionSource;
          const capturedSource =
            initial.target?.readSource ?? prepared?.readSource ?? fallbackSource;
          const source = provided?.source ?? capturedSource;
          if (
            !source ||
            (provided &&
              (provided.agentId !== durableRoute.agentId ||
                provided.sessionKey !== durableRoute.canonicalKey))
          ) {
            throw changed(expected.sessionKey);
          }
          if (
            capturedSource &&
            (source.agentId !== capturedSource.agentId ||
              source.databaseIdentity !== capturedSource.databaseIdentity ||
              source.databaseBirthtime !== capturedSource.databaseBirthtime)
          ) {
            throw changed(expected.sessionKey);
          }
          transaction = {
            source,
            agentId: durableRoute.agentId,
            sessionKey: expected.resolved?.storeKey ?? durableRoute.canonicalKey,
            assertCurrent(facts) {
              assertLifetimeCurrent();
              const preparedFacts = prepareAuthorizedSessionMutationFacts({
                expected,
                source,
                facts,
                targetChanged: () => changed(expected.sessionKey),
              });
              const cfg = params.request.context.getRuntimeConfig();
              if (provided && params.authorizesAgentRun) {
                const policyConfig = params.request.context.getCommittedRuntimeConfig?.() ?? cfg;
                const sharing = prepareProjectedSessionSharing({
                  cfg: policyConfig,
                  client: params.request.client,
                  profiles,
                  isMember: (_target, id) =>
                    facts.members.some((member) => member.identityId === id),
                });
                const error = authorizeGatewaySessionCreation(
                  {
                    cfg: policyConfig,
                    client: params.request.client,
                    agentId: durableRoute.agentId,
                  },
                  { policy: sharing.policy },
                );
                if (error) {
                  throw new SessionMutationAuthorizationChangedError(error);
                }
              }
              params.consume(
                expected,
                cfg,
                {
                  ...preparedFacts,
                  members: facts.members,
                  isMember: (id) => facts.members.some((member) => member.identityId === id),
                  assertCurrent: assertLifetimeCurrent,
                },
                profiles,
              );
            },
          };
        }
        reads.push((profiles) =>
          params.consume(expected, params.request.context.getRuntimeConfig(), read(), profiles),
        );
        continue;
      }
      const route = expected.resolved ?? expected.absentTarget;
      const provided = params.transactionSource;
      if (
        provided &&
        (provided.agentId !== route?.agentId || provided.sessionKey !== route.canonicalKey)
      ) {
        throw changed(expected.sessionKey);
      }
      const source = provided?.source ?? route?.readSource;
      if (!route || !source) {
        throw changed(expected.sessionKey);
      }
      const originalSource = route.readSource;
      if (
        originalSource &&
        (source.agentId !== originalSource.agentId ||
          source.databaseIdentity !== originalSource.databaseIdentity ||
          source.databaseBirthtime !== originalSource.databaseBirthtime)
      ) {
        throw changed(expected.sessionKey);
      }
      const target = {
        ...route,
        storeKey: expected.resolved?.storeKey ?? route.canonicalKey,
        readSource: source,
      };
      const locators =
        typeof source.databaseIdentity === "string"
          ? captureSessionStoreReadCandidates(target.storePath)
          : [];
      const captured = locators.map((candidate) => {
        const identity = readDatabasePathIdentitySync(candidate.path);
        return { candidate, identity: identity.key, birthtime: identity.birthtime };
      });
      if (
        locators.length &&
        !locators.some((locator) =>
          matchesAgentDatabaseReadCandidatePath(
            { ...locator, path: locator.physicalPath },
            source.path,
          ),
        )
      ) {
        throw changed(expected.sessionKey);
      }
      const registry = prepareOpenClawAgentDatabaseRegistrySnapshotRead(
        {},
        createSessionStoreRegistryMutationFilter({ captured, preparedSources: [] }),
      );
      const retained = retainOpenClawAgentDatabaseReadOnly(source);
      if (!retained.found) {
        throw changed(expected.sessionKey);
      }
      releases.push({ release: retained.claim.release });
      const assertAdmission = captureOpenClawAgentReadOnlyAdmission(retained.database);
      const assertSource = () => {
        retained.claim.assertCurrent();
        assertCapturedSessionEntryReadSource(source, retained.database);
        registry.assertCurrent();
        for (const locator of locators) {
          if (
            captureSessionStoreReadCandidate(locator.path, locator.scope).physicalPath !==
            locator.physicalPath
          ) {
            throw changed(expected.sessionKey);
          }
        }
      };
      assertSource();
      sourceChecks.push(assertSource);
      reads.push((profiles) => {
        const cfg = params.request.context.getRuntimeConfig();
        assertSource();
        if (retained.database.db.isTransaction) {
          throw changed(expected.sessionKey);
        }
        runSqliteReadOperationSync(retained.database.db, () => {
          assertAdmission();
          const entry = readExactSessionEntryRow(
            retained.database,
            target.storeKey,
            "list",
            "canonical",
          )?.entry;
          params.consume(
            expected,
            cfg,
            {
              target: entry ? { ...target, storeKeys: [target.storeKey], entry } : null,
              storageTarget: target,
              members: [],
              isMember: (id) => hasSessionMemberInDatabase(retained.database, target.storeKey, id),
              assertCurrent: assertSource,
            },
            profiles,
          );
        });
        assertSource();
      });
    }
    const profiles =
      params.request.preparedProfiles ??
      (await prepareSessionSharingProfiles(params.request.client));
    const assertLifetimeCurrent = () => {
      if (!active) {
        throw changed();
      }
      assertRouting(params.request.context.getRuntimeConfig());
      if (
        params.transactionFacts &&
        params.request.context.getRuntimeConfig().talk?.agentId !== talkAgentId
      ) {
        throw changed();
      }
      profiles.readCurrent();
      for (const assertSource of sourceChecks) {
        assertSource();
      }
    };
    const assertCurrent = () => {
      assertLifetimeCurrent();
      for (const read of reads) {
        read(profiles);
      }
    };
    return {
      assertCurrent,
      assertLifetimeCurrent,
      release,
      ...(transaction ? { transaction } : {}),
    };
  } catch (error) {
    active = false;
    await releaseSessionSourceAuthorities(releases.splice(0), [error]);
    throw error;
  }
}
