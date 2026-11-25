import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { GitHubCredentialReader } from "../agents/github-credential-reader.js";
import { intersectParticipationCeilings } from "../agents/participation-ceiling.js";
import {
  getGatewayToolCallerIdentity,
  resolveGatewayToolOperatorSelection,
} from "../agents/tools/gateway-caller-context.js";
import { matchesSessionParticipationTarget } from "../config/sessions/session-participation-source.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  decodeGitHubPublicationRequester,
  immutableGitHubPublicationParticipation,
  type GitHubPublicationOrigin,
  type GitHubPublicationRequesterSnapshot,
} from "../state/github-publication-requester.js";
import type { GitHubPublicationSourceSelector } from "../state/github-publication-source.types.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import {
  capturePublicationParticipation,
  prepareRequesterPolicy,
  publicationParticipationTarget,
} from "./github-publication-requester-policy.js";
import {
  prepareGitHubPublicationSource,
  type GitHubPublicationSourceCapability,
} from "./github-publication-source.js";
import { openClawIdRecoveryPrincipalSchema } from "./openclaw-id/tunnel-principal-schema.js";
import {
  OpenClawIdPrincipalChangedError,
  prepareOpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import { OperatorRefusalError } from "./operator-refusal.js";
import { operatorRoleSubject } from "./operator-role-enforcement.js";
import {
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import { prepareGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { repositoryDispatchCredentialReader } from "./repository-dispatch.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { prepareSessionCreatorProfile } from "./session-creator.js";
import { authorizeIncognitoSessionTarget } from "./session-sharing-policy.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";

type PublicationSession = { sessionKey: string; agentId: string };
type PreparedProfileIdentity = Awaited<ReturnType<typeof prepareUserProfileIdentity>>;
type PreparedPublicationSession = Awaited<ReturnType<typeof prepareSessionMutationFacts>>;

function assertPublicationIncognitoAccess(
  profileId: string,
  scopes: readonly string[],
  sessionKey: string,
): void {
  const client = createSyntheticPluginRuntimeClient({
    operatorRoleActor: { kind: "operator", profileId },
    scopes: [...scopes],
  });
  if (authorizeIncognitoSessionTarget({ client, sessionKey, target: null })) {
    throw new GitHubPublicationRequesterUnavailableError();
  }
}

async function preparePublicationSession(
  session: PublicationSession,
  config: OpenClawConfig,
): Promise<PreparedPublicationSession> {
  try {
    return await prepareSessionMutationFacts({ cfg: config, ...session });
  } catch (error) {
    throw new GitHubPublicationRecoveryPendingError(
      "GitHub publication session authorization is unavailable; retry after session storage is ready.",
      { cause: error },
    );
  }
}

/** @deprecated Use GitHubPublicationRequesterPolicyV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
export type GitHubPublicationRequesterPolicy = Readonly<{
  snapshot: GitHubPublicationRequesterSnapshot;
  assertCurrent: () => void;
}>;

/** @deprecated Use GitHubPublicationRequesterV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
export type GitHubPublicationRequester = GitHubPublicationRequesterPolicy &
  Readonly<{
    /** An accepted row keeps its own policy while the current invocation retains its fences. */
    assertInvocationCurrent: () => void;
  }>;

/** Prepared host policy and a required live source capability for worker-owned writes. */
export type GitHubPublicationRequesterPolicyV2 = GitHubPublicationRequesterPolicy &
  Readonly<{
    version: 2;
    /** Live invocation only; durable requester snapshots cannot recreate repository admission. */
    prepareDispatchCredential?(input: {
      sessionId: string;
      requestDigest: string;
      assertCurrent: () => void;
    }): GitHubCredentialReader | undefined;
    signal: AbortSignal;
    prepareSource(
      selector: GitHubPublicationSourceSelector,
    ): Promise<GitHubPublicationSourceCapability>;
  }>;
export type GitHubPublicationRequesterV2 = GitHubPublicationRequesterPolicyV2 &
  Pick<GitHubPublicationRequester, "assertInvocationCurrent">;

/** PR rights are the tool caller's turn grant, or the direct request's admitted scopes. */
export function captureGitHubPublicationActionAuthority(
  requester: GitHubPublicationRequesterPolicyV2,
) {
  // A tool turn without an operator principal reaches here as System and holds no PR rights.
  const scopes =
    getGatewayToolCallerIdentity() && requester.snapshot.actor.kind === "system"
      ? []
      : requester.snapshot.scopes;
  // Participation never lends operator write over other people's PRs.
  const operatorWrite =
    !requester.snapshot.participation &&
    roleScopesAllow({
      role: "operator",
      requestedScopes: ["operator.write"],
      allowedScopes: scopes,
    });
  requester.assertCurrent();
  return {
    scopes,
    operatorWrite,
    assertCurrent: requester.assertCurrent,
    assertOperatorWrite: () => {
      requester.assertCurrent();
      if (!operatorWrite) {
        throw new OperatorRefusalError("role-denies", { action: "work on another person's PR" });
      }
    },
  };
}

const workerRequesters = resolveGlobalSingleton(
  Symbol.for("openclaw.githubPublicationWorkerRequesters"),
  () => new WeakMap<GitHubPublicationRequesterPolicy, PublicationSession>(),
);

/** Classify before invoking any released assertion; a failed worker command never selects legacy. */
export function isGitHubPublicationRequesterV2(
  requester: GitHubPublicationRequesterPolicy,
): requester is GitHubPublicationRequesterPolicyV2 {
  return workerRequesters.has(requester);
}

function prepareRequesterSource(
  requester: GitHubPublicationRequesterPolicyV2,
  selector: GitHubPublicationSourceSelector,
  sourcePath: string | undefined,
): Promise<GitHubPublicationSourceCapability> {
  if (!sourcePath) {
    throw new GitHubPublicationRecoveryPendingError(
      "GitHub publication source is unavailable; retry after session storage is ready.",
    );
  }
  const { snapshot, signal } = requester;
  return prepareGitHubPublicationSource({
    sourcePath,
    selector: {
      ...selector,
      ...(snapshot.actor.kind === "operator"
        ? {
            profileId: snapshot.actor.profileId,
            aliasBindingIds: snapshot.grant?.aliasBindingIds,
          }
        : {}),
    },
    signal,
    assertCurrent: requester.assertCurrent,
  });
}

/** A tool call acts with its turn's admitted grant; a direct request is admitted here, once. */
export async function prepareGitHubPublicationRequesterV2(
  options: Parameters<typeof prepareGatewayOperatorRunAuthority>[0] &
    Pick<GatewayRequestHandlerOptions, "signal" | "sessionMutationAuthorization">,
  session: PublicationSession,
): Promise<{
  requester: GitHubPublicationRequesterV2;
  release: () => void;
  authority: AdmittedRunOperatorAuthority | undefined;
}> {
  options.signal?.throwIfAborted();
  // A tool call acts with its turn's grant; a direct request is admitted here, once. (An
  // in-process tool call without a turn grant reaches here as the System client: no authority.)
  const caller = getGatewayToolCallerIdentity();
  const turn = caller ? resolveGatewayToolOperatorSelection().operatorAuthority : undefined;
  const source = turn
    ? { authority: turn, release: () => {} }
    : await prepareGatewayOperatorRunAuthority(options);
  let identity: PreparedProfileIdentity | undefined;
  let sessionFacts: PreparedPublicationSession | undefined;
  let participationFacts: PreparedPublicationSession | undefined;
  const lifetime = new AbortController();
  const release = () => {
    lifetime.abort(new GitHubPublicationRequesterUnavailableError());
    sessionFacts?.release();
    if (participationFacts !== sessionFacts) {
      participationFacts?.release();
    }
    identity?.release();
    source?.release();
  };
  try {
    const inherited = source?.authority.participationCeiling;
    const ceiling = intersectParticipationCeilings(
      options.sessionMutationAuthorization?.participationCeiling,
      inherited,
    );
    // The request's host-resolved ceiling only narrows the admitted grant; it never replaces it.
    const participantCaller =
      options.client?.internal?.agentToolCaller ??
      options.client?.internal?.agentRuntimeIdentity ??
      caller;
    if (
      ceiling &&
      (!source ||
        source.authority.profileId !== ceiling.profileId ||
        (inherited && !participantCaller) ||
        (participantCaller &&
          (participantCaller.agentId !== session.agentId ||
            participantCaller.sessionKey !== session.sessionKey)))
    ) {
      throw new GitHubPublicationRequesterUnavailableError();
    }
    const actor = source
      ? { kind: "operator" as const, profileId: source.authority.profileId }
      : resolveGatewayOperatorRoleActor(options.client);
    const system =
      actor?.kind === "system" ||
      options.client?.authenticatedUserProfile?.profileId === GATEWAY_OWNER_PROFILE_ID;
    if (
      (!source && !system) ||
      options.client?.connect.role !== "operator" ||
      (source && source.authority.gatewayAccessGrant === undefined)
    ) {
      throw new GitHubPublicationRequesterUnavailableError();
    }
    let grant: GitHubPublicationRequesterSnapshot["grant"] = null;
    if (source) {
      assertPublicationIncognitoAccess(
        source.authority.profileId,
        source.authority.scopes,
        session.sessionKey,
      );
      identity = await prepareUserProfileIdentity(source.authority.profileId);
      sessionFacts = await preparePublicationSession(
        session,
        (options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig)(),
      );
      if (source.authority.gatewayAccessGrant) {
        grant = Object.freeze({
          ...source.authority.gatewayAccessGrant,
          aliasBindingIds: identity.emailBindingIds,
        });
      }
    }
    const getConfig = options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig;
    const participation =
      ceiling && sessionFacts
        ? capturePublicationParticipation(
            ceiling,
            sessionFacts.readCurrent(getConfig()),
            getConfig(),
          )
        : undefined;
    if (participation) {
      const { ceiling: retained } = participation;
      assertPublicationIncognitoAccess(
        retained.profileId,
        source!.authority.scopes,
        retained.sessionKey,
      );
      participationFacts =
        retained.source.agentId === session.agentId && retained.sessionKey === session.sessionKey
          ? sessionFacts
          : await preparePublicationSession(
              { agentId: retained.source.agentId, sessionKey: retained.sessionKey },
              getConfig(),
            );
    }
    const principal =
      source?.authority.openclawIdPrincipal?.kind === "member" ||
      source?.authority.openclawIdPrincipal?.kind === "owner"
        ? openClawIdRecoveryPrincipalSchema.parse(source.authority.openclawIdPrincipal)
        : undefined;
    const snapshot: GitHubPublicationRequesterSnapshot = Object.freeze({
      version: 1,
      authenticationSource: principal?.kind === "member" ? "openclaw-id-member" : "non-member",
      actor: Object.freeze(
        source
          ? { kind: "operator" as const, profileId: source.authority.profileId }
          : { kind: "system" as const },
      ),
      scopes: Object.freeze([...(source?.authority.scopes ?? options.client.connect.scopes ?? [])]),
      ...(principal
        ? {
            openclawIdPrincipal: Object.freeze({
              ...principal,
              authority: Object.freeze(principal.authority),
            }),
          }
        : {}),
      grant,
      ...(participation ? { participation } : {}),
    });
    const policy = prepareRequesterPolicy(
      snapshot,
      session,
      options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig,
      identity,
      (profile, config) =>
        resolveOperatorRolePolicyForAssignment(
          profile.profileId,
          profile.assignedRole,
          config,
          profile.githubLogin ?? null,
          operatorRoleSubject(profile),
        ),
      sessionFacts,
      undefined,
      participationFacts,
    );
    const signal = AbortSignal.any([
      lifetime.signal,
      ...(options.signal ? [options.signal] : []),
      ...(source?.authority.signal ? [source.authority.signal] : []),
    ]);
    const assertInvocationCurrent = () => {
      try {
        signal.throwIfAborted();
      } catch {
        throw new GitHubPublicationRequesterUnavailableError();
      }
    };
    const requester: GitHubPublicationRequesterV2 = Object.freeze({
      version: 2 as const,
      prepareDispatchCredential: (input: {
        sessionId: string;
        requestDigest: string;
        assertCurrent: () => void;
      }) =>
        repositoryDispatchCredentialReader({
          client: options.client,
          agentId: session.agentId,
          sessionKey: session.sessionKey,
          sessionId: input.sessionId,
          requestDigest: input.requestDigest,
          hasCurrentClientAuthority: options.hasCurrentClientAuthority,
          assertCurrent: () => {
            requester.assertCurrent();
            input.assertCurrent();
          },
        }),
      signal,
      snapshot: policy.snapshot,
      assertInvocationCurrent,
      assertCurrent: () => {
        assertInvocationCurrent();
        policy.assertCurrent();
        assertInvocationCurrent();
      },
      async prepareSource(selector: GitHubPublicationSourceSelector) {
        requester.assertCurrent();
        if (selector.agentId !== session.agentId || selector.sessionKey !== session.sessionKey) {
          throw new GitHubPublicationRequesterUnavailableError();
        }
        sessionFacts ??= await preparePublicationSession(
          session,
          (options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig)(),
        );
        requester.assertCurrent();
        const { sourcePath } = sessionFacts.readCurrent(
          (options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig)(),
        );
        return await prepareRequesterSource(requester, selector, sourcePath);
      },
    });
    workerRequesters.set(requester, Object.freeze({ ...session }));
    requester.assertCurrent();
    return { requester, release, authority: source?.authority };
  } catch (error) {
    release();
    throw error;
  }
}

/** Host-owned source custody retains the initiating conversation's admitted authority. */
export async function prepareGitHubPublicationTaskRequester(
  original: GitHubPublicationRequesterV2,
  sourceSession: PublicationSession,
  origin: GitHubPublicationOrigin,
  getCommittedRuntimeConfig: () => OpenClawConfig,
): Promise<{ requester: GitHubPublicationRequesterV2; release: () => void }> {
  original.assertCurrent();
  const bound = workerRequesters.get(original);
  if (
    !bound ||
    bound.agentId !== origin.agentId ||
    bound.sessionKey !== origin.sessionKey ||
    sourceSession.agentId !== origin.agentId
  ) {
    throw new GitHubPublicationRequesterUnavailableError();
  }
  let snapshot = Object.freeze({ ...original.snapshot, origin });
  let identity: PreparedProfileIdentity | undefined;
  let sessionFacts: PreparedPublicationSession | undefined;
  const lifetime = new AbortController();
  const release = () => {
    lifetime.abort(new GitHubPublicationRequesterUnavailableError());
    sessionFacts?.release();
    identity?.release();
  };
  try {
    if (snapshot.actor.kind === "operator") {
      assertPublicationIncognitoAccess(
        snapshot.actor.profileId,
        snapshot.scopes,
        sourceSession.sessionKey,
      );
      identity = await prepareUserProfileIdentity(snapshot.actor.profileId);
    }
    const preparedSession = await preparePublicationSession(
      sourceSession,
      getCommittedRuntimeConfig(),
    );
    sessionFacts = preparedSession;
    original.assertCurrent();
    const current = identity?.readCurrentFacts(snapshot.grant?.aliasBindingIds);
    const entry = preparedSession.readCurrent(getCommittedRuntimeConfig()).target.entry;
    if (
      entry.archivedAt !== undefined ||
      (current &&
        !snapshot.participation &&
        snapshot.actor.kind === "operator" &&
        !roleScopesAllow({
          role: "operator",
          requestedScopes: ["operator.write"],
          allowedScopes: snapshot.scopes,
        }) &&
        !prepareSessionCreatorProfile(
          snapshot.actor.profileId,
          current.aliases,
        )(entry.createdActor))
    ) {
      throw new GitHubPublicationRequesterUnavailableError();
    }
    if (snapshot.participation) {
      const target = snapshot.participation.target;
      if (!matchesSessionParticipationTarget(target, origin)) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
      snapshot = Object.freeze({
        ...snapshot,
        participation: immutableGitHubPublicationParticipation({
          ...snapshot.participation,
          target: publicationParticipationTarget(
            preparedSession.readCurrent(getCommittedRuntimeConfig()),
          ),
        }),
      });
    }
    // Transfer admitted policy; the prepared session owns physical/incarnation fences.
    const signal = AbortSignal.any([lifetime.signal, original.signal]);
    const requester: GitHubPublicationRequesterV2 = Object.freeze({
      version: 2,
      snapshot,
      signal,
      assertInvocationCurrent: original.assertInvocationCurrent,
      assertCurrent() {
        signal.throwIfAborted();
        original.assertCurrent();
        preparedSession.readCurrent(getCommittedRuntimeConfig());
      },
      async prepareSource(selector: GitHubPublicationSourceSelector) {
        requester.assertCurrent();
        if (
          selector.agentId !== sourceSession.agentId ||
          selector.sessionKey !== sourceSession.sessionKey
        ) {
          throw new GitHubPublicationRequesterUnavailableError();
        }
        const { sourcePath } = preparedSession.readCurrent(getCommittedRuntimeConfig());
        return await prepareRequesterSource(requester, selector, sourcePath);
      },
    });
    workerRequesters.set(requester, Object.freeze({ ...sourceSession }));
    requester.assertCurrent();
    return { requester, release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Restoration rechecks the original immutable basis; a new role or invitation cannot replace it. */
export async function restoreGitHubPublicationRequester(
  json: string | null | undefined,
  session: PublicationSession,
  getCommittedRuntimeConfig: () => OpenClawConfig,
  invocation?: Pick<GitHubPublicationRequesterV2, "signal" | "assertInvocationCurrent">,
): Promise<GitHubPublicationRequesterPolicyV2 & { release: () => void }> {
  const snapshot = decodeGitHubPublicationRequester(json);
  if (!snapshot) {
    throw new GitHubPublicationRequesterUnavailableError();
  }
  if (snapshot.openclawIdPrincipal) {
    try {
      await prepareOpenClawIdTunnelPrincipal(snapshot.openclawIdPrincipal);
    } catch (error) {
      if (error instanceof OpenClawIdPrincipalChangedError) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
      throw new GitHubPublicationRecoveryPendingError(
        "GitHub publication membership is unavailable; retry recovery after membership storage is ready.",
        { cause: error },
      );
    }
  }
  let identity: PreparedProfileIdentity | undefined;
  let sessionFacts: PreparedPublicationSession | undefined;
  let participationFacts: PreparedPublicationSession | undefined;
  let originFacts: PreparedPublicationSession | undefined;
  const lifetime = new AbortController();
  if (snapshot.actor.kind === "operator") {
    assertPublicationIncognitoAccess(snapshot.actor.profileId, snapshot.scopes, session.sessionKey);
    if (snapshot.origin) {
      assertPublicationIncognitoAccess(
        snapshot.actor.profileId,
        snapshot.scopes,
        snapshot.origin.sessionKey,
      );
    }
    try {
      identity = await prepareUserProfileIdentity(snapshot.actor.profileId);
      sessionFacts = await preparePublicationSession(session, getCommittedRuntimeConfig());
    } catch (error) {
      identity?.release();
      if (error instanceof GitHubPublicationRecoveryPendingError) {
        throw error;
      }
      throw new GitHubPublicationRecoveryPendingError(
        "GitHub publication requester identity is unavailable; retry recovery after profile storage is ready.",
        { cause: error },
      );
    }
  }
  const release = () => {
    lifetime.abort(new GitHubPublicationRequesterUnavailableError());
    sessionFacts?.release();
    originFacts?.release();
    if (participationFacts !== sessionFacts && participationFacts !== originFacts) {
      participationFacts?.release();
    }
    identity?.release();
  };
  try {
    if (snapshot.origin) {
      originFacts = await preparePublicationSession(snapshot.origin, getCommittedRuntimeConfig());
    }
    if (snapshot.participation) {
      const { ceiling } = snapshot.participation;
      assertPublicationIncognitoAccess(ceiling.profileId, snapshot.scopes, ceiling.sessionKey);
      participationFacts =
        ceiling.source.agentId === session.agentId && ceiling.sessionKey === session.sessionKey
          ? sessionFacts
          : ceiling.source.agentId === snapshot.origin?.agentId &&
              ceiling.sessionKey === snapshot.origin.sessionKey
            ? originFacts
            : await preparePublicationSession(
                { agentId: ceiling.source.agentId, sessionKey: ceiling.sessionKey },
                getCommittedRuntimeConfig(),
              );
    }
    const policy = prepareRequesterPolicy(
      snapshot,
      session,
      getCommittedRuntimeConfig,
      identity,
      (profile, config) =>
        resolveOperatorRolePolicyForAssignment(
          profile.profileId,
          profile.assignedRole,
          config,
          profile.githubLogin ?? null,
          operatorRoleSubject(profile),
        ),
      sessionFacts,
      originFacts,
      participationFacts,
    );
    const signal = AbortSignal.any([lifetime.signal, ...(invocation ? [invocation.signal] : [])]);
    const requester: GitHubPublicationRequesterPolicyV2 & { release: () => void } = Object.freeze({
      version: 2 as const,
      signal,
      snapshot: policy.snapshot,
      assertCurrent() {
        signal.throwIfAborted();
        invocation?.assertInvocationCurrent();
        policy.assertCurrent();
        invocation?.assertInvocationCurrent();
      },
      async prepareSource(selector: GitHubPublicationSourceSelector) {
        requester.assertCurrent();
        if (selector.agentId !== session.agentId || selector.sessionKey !== session.sessionKey) {
          throw new GitHubPublicationRequesterUnavailableError();
        }
        sessionFacts ??= await preparePublicationSession(session, getCommittedRuntimeConfig());
        requester.assertCurrent();
        const { sourcePath } = sessionFacts.readCurrent(getCommittedRuntimeConfig());
        return await prepareRequesterSource(requester, selector, sourcePath);
      },
      release,
    });
    workerRequesters.set(requester, Object.freeze({ ...session }));
    requester.assertCurrent();
    return requester;
  } catch (error) {
    release();
    throw error;
  }
}
