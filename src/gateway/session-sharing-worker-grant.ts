import {
  releaseSessionSourceAuthorities,
  type SessionSourceTransactionGrant,
} from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import { captureSessionSharingMemoryFacts } from "./session-sharing-incognito.js";
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
  const changed = (key = params.targets[0]?.sessionKey ?? "") =>
    sessionMutationTargetChanged(params.request.method, key);
  if (params.transactionSource && (!params.transactionFacts || params.targets.length !== 1)) {
    throw changed();
  }
  const assertRouting = captureSessionMutationRouting(params.sourceConfig, changed, params.targets);
  let active = true;
  const targets = params.targets.map((target) => ({
    ...target,
    resolved: target.resolved && { ...target.resolved },
    memoryFacts: captureSessionSharingMemoryFacts(target, () => {
      if (!active) {
        throw sessionMutationTargetChanged(params.request.method, target.sessionKey);
      }
      assertRouting(params.request.context.getRuntimeConfig());
    }),
  }));
  const talkAgentId = params.sourceConfig.talk?.agentId;
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
      if (expected.memoryFacts) {
        const target = expected.resolved;
        if (!target) {
          throw changed(expected.sessionKey);
        }
        const source = await prepareSessionSharingSource(
          target,
          () => assertRouting(params.request.context.getRuntimeConfig()),
          expected.memoryFacts,
        );
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
      const fallbackSource = sourceFacts?.readSource ?? durableRoute.readSource;
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
        const capturedSource = initial.target?.readSource ?? prepared?.readSource ?? fallbackSource;
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
                isMember: (_target, id) => facts.members.some((member) => member.identityId === id),
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
