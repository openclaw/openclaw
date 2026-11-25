import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  assertAdmittedRunOperatorAuthority,
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import type {
  AdmittedRunOperatorRoleFacts,
  TurnGrant,
} from "../agents/admitted-run-operator-authority.types.js";
import {
  prepareOperatorModelPolicy,
  readOperatorModelPolicyMembership,
  restoreOperatorModelPolicySnapshot,
  type PreparedOperatorModelPolicy,
} from "../agents/operator-model-policy.js";
import {
  isConfiguredCommandOwner,
  prepareCommandOwnerAuthority,
} from "../auto-reply/command-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isAbortError } from "../infra/abort-signal.js";
import {
  isPairedDeviceTokenIdentityCurrent,
  listApprovedPairedDeviceRoles,
} from "../infra/device-pairing-identity.js";
import { loadPairedDevicePairingStoreRecordReadOnly } from "../infra/device-pairing-store-readonly.js";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import { GatewayOperatorAccessUnavailableError } from "../infra/operator-authority-error.js";
import { GatewayDispatchUnavailableError } from "../infra/restart-recovery-errors.js";
import { getProcessGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { getCanonicalGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import {
  intersectOperatorScopes,
  operatorScopeSatisfied,
} from "../shared/operator-scope-compat.js";
import { resolveUserChannelAuthorizationPolicy } from "../state/user-channel-identities.js";
import { prepareUserChannelIdentityAuthority } from "../state/user-channel-identity-operations.js";
import { UserProfileMutationUnsettledError } from "../state/user-profile-events.js";
import { profileCatalogPath } from "../state/user-profile-identity.read.js";
import {
  captureResidentUserProfileAccess,
  prepareUserProfileIdentity,
  projectUserProfileDisplay,
  readResidentUserProfileRevision,
} from "../state/user-profile-list.js";
import { UserProfileNotFoundError } from "../state/user-profiles-schema.js";
import type {
  PreparedUserProfileIdentity,
  UserChannelIdentity,
} from "../state/user-profiles.types.js";
import { resolveGatewayAuthPolicyGrant } from "./auth-policy.js";
import { resolveGatewayAuthForConfig } from "./auth-resolve.js";
import { gatewayPersonPrincipalAuthError, type ResolvedGatewayAuth } from "./auth.js";
import {
  prepareChannelOperatorAdmin,
  prepareChannelOperatorAuthority,
} from "./channel-operator-authority.js";
import type { CronAuthenticatedChannelRequester } from "./cron-creator-authority-grant.types.js";
import {
  isOpenClawIdTunnelPrincipalCurrent,
  readOpenClawIdTunnelPrincipal,
  openclawIdSubjectRolePolicy,
  prepareOpenClawIdTunnelPrincipalLookup,
} from "./openclaw-id/tunnel-principal.js";
import {
  GatewayOperatorAccessDeniedError,
  resolvePreparedGatewayOperatorAccessAuthority,
} from "./operator-access-policy.js";
import { OperatorRefusalError } from "./operator-refusal.js";
import { isOperatorRoleEnforcedFor, operatorRoleSubject } from "./operator-role-enforcement.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";
import type { QueuedOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import { getGatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import { restoreIngressPrincipalRecovery } from "./remote-ingress-principal-recovery.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/shared-types.js";
import type { GatewayAuthenticatedUserProfile } from "./server/client-identity-types.js";

export type OperatorAdmissionContext = Pick<
  GatewayRequestContext,
  | "getRuntimeConfig"
  | "getCommittedRuntimeConfig"
  | "resolveGatewayContext"
  | "sharedGatewaySessionGenerationState"
>;

type Facts = (
  | Extract<QueuedOperatorRecoverySource, { kind: "gateway" }>
  | Extract<QueuedOperatorRecoverySource, { kind: "channel" }>
  | {
      kind: "recorded";
      snapshot: Pick<
        AdmittedRunOperatorAuthority,
        "profileId" | "openclawIdPrincipal" | "scopes" | "gatewayAccessGrant"
      > & { assignedRole: string | null; githubLogin?: string | null };
    }
  | { kind: "live"; authority: AdmittedRunOperatorAuthority }
  // A session's person with no recorded source: a background turn admits only their role.
  | { kind: "person"; snapshot: { profileId: string } }
) & { agentId?: string };
type PreparedOperatorAdmission = {
  config: OpenClawConfig;
  context: OperatorAdmissionContext;
  identity: PreparedUserProfileIdentity | undefined;
  paired: PairedDevice | null | undefined;
  ingress:
    | { assertCurrent: () => void; release: () => void; scopes: readonly string[] }
    | undefined;
  channel:
    | {
        isCurrent: (config: OpenClawConfig) => boolean;
        operatorProfile: {
          profileId: string;
          scopes: readonly string[];
          gatewayAccessGrant: AdmittedRunOperatorAuthority["gatewayAccessGrant"];
        };
      }
    | undefined;
  ingressAuth: ResolvedGatewayAuth;
};

function admissionError(error: unknown, facts: Facts): never {
  if (
    error instanceof UserProfileMutationUnsettledError ||
    (error instanceof GatewayDispatchUnavailableError && error.retryable) ||
    (error instanceof GatewayOperatorAccessDeniedError &&
      error.accessCause === "policy-unavailable")
  ) {
    throw new GatewayOperatorAccessUnavailableError();
  }
  if (
    isAbortError(error) &&
    ((facts.kind === "gateway" && facts.snapshot.sourceIngress === "principal") ||
      (facts.kind === "live" && facts.authority.ingress?.signal.aborted))
  ) {
    throw new OperatorRefusalError("sign-in-ended", { cause: error });
  }
  if (
    error instanceof GatewayOperatorAccessDeniedError ||
    error instanceof UserProfileNotFoundError
  ) {
    throw new OperatorRefusalError("access-ended", { cause: error });
  }
  throw error;
}

/** Load the owners needed for one start; no authority escapes this preparation. */
export async function prepareOperatorAdmission(
  facts: Facts,
  context: OperatorAdmissionContext,
): Promise<PreparedOperatorAdmission> {
  let identity: PreparedUserProfileIdentity | undefined;
  let ingress: PreparedOperatorAdmission["ingress"];
  try {
    const snapshot = facts.kind === "live" ? facts.authority : facts.snapshot;
    const readConfig = context.getCommittedRuntimeConfig ?? context.getRuntimeConfig;
    const native =
      facts.kind === "channel"
        ? await prepareUserChannelIdentityAuthority({
            authorizationId: facts.snapshot.reference.id,
            policy: resolveUserChannelAuthorizationPolicy(readConfig().gateway),
          })
        : undefined;
    const channelIdentity = native?.linked.identity;
    const channel =
      native && channelIdentity
        ? await prepareChannelOperatorAuthority(readConfig(), {
            identity: channelIdentity,
            prepared: native,
          })
        : undefined;
    if (facts.kind !== "live" || facts.authority.canonicalIdentity) {
      if (readResidentUserProfileRevision(snapshot.profileId, profileCatalogPath({}))) {
        captureResidentUserProfileAccess(snapshot.profileId).assertCurrent();
      }
      identity = await prepareUserProfileIdentity(snapshot.profileId);
    }
    const gateway = facts.kind === "gateway" ? facts.snapshot : undefined;
    const principal =
      facts.kind === "live"
        ? facts.authority.openclawIdPrincipal
        : facts.kind === "recorded"
          ? facts.snapshot.openclawIdPrincipal
          : gateway?.openclawIdPrincipal;
    if (principal) {
      await prepareOpenClawIdTunnelPrincipalLookup().catch(() => {
        throw new GatewayOperatorAccessUnavailableError();
      });
    }
    const device = gateway?.device ?? (facts.kind === "live" ? facts.authority.device : undefined);
    const paired = device
      ? await loadPairedDevicePairingStoreRecordReadOnly(device.deviceId).catch(() => {
          throw new GatewayOperatorAccessUnavailableError();
        })
      : undefined;
    if (gateway?.sourceIngress === "principal") {
      ingress = await restoreIngressPrincipalRecovery(
        context,
        gateway.ingress,
        gateway.profileId,
        gateway.scopes,
      );
    }
    const config = readConfig();
    const resolver = context.resolveGatewayContext
      ? getCanonicalGatewayContextResolver(context.resolveGatewayContext)
      : undefined;
    const ingressAuth =
      (resolver && getGatewayControlUiIngressHost(resolver)?.getResolvedAuth()) ||
      resolveGatewayAuthForConfig({ config });
    return {
      config,
      context,
      identity,
      ingress,
      paired,
      channel,
      ingressAuth,
    };
  } catch (error) {
    ingress?.release();
    identity?.release();
    return admissionError(error, facts);
  }
}

/** The only producer of what a turn may do; every entry kind reaches it through admission. */
export function decideTurnGrant(scopes: readonly string[]): TurnGrant {
  const owner = operatorScopeSatisfied("operator.admin", scopes);
  const sessionsWrite = operatorScopeSatisfied("operator.sessions.write", scopes);
  return Object.freeze({
    owner,
    automations: owner
      ? "manage"
      : operatorScopeSatisfied("operator.cron", scopes)
        ? "self"
        : "none",
    skillAuthoring: sessionsWrite,
    questionReplace: sessionsWrite,
    commands: owner ? "all" : "none",
  });
}

/** A process the operator runs on this host (CLI, standalone MCP, MCP owner token) is the owner. */
export const LOCAL_HOST = Object.freeze({ grant: decideTurnGrant(["operator.admin"]) });

/** A request may do what its admitted run may; a bare connection gets what its scopes decide. */
export const readGatewayRequestAdmission = (client?: GatewayClient | null) => ({
  grant:
    client?.internal?.operatorRunAuthority?.grant ?? decideTurnGrant(client?.connect?.scopes ?? []),
});

/** What channel ingress knows about a sender; admission decides what it may do. */
export type ChannelSenderFacts = Readonly<
  UserChannelIdentity & { authentication: "verified" | "asserted" }
>;

const isChannelOwner = (config: OpenClawConfig, sender: UserChannelIdentity) =>
  isConfiguredCommandOwner(config, { ...sender, channel: sender.channelId });

/** Gather a channel sender's link, operator profile and command-owner policy once, at ingress. */
export async function prepareChannelSenderAdmission(
  { authentication, ...principal }: ChannelSenderFacts,
  getConfig: () => OpenClawConfig,
) {
  const verified = authentication === "verified";
  const requester = verified ? await prepareUserChannelIdentityAuthority(principal) : undefined;
  // An asserted identifier can match a configured owner, never a personal link.
  const owner = verified || isChannelOwner(getConfig(), principal) ? principal : undefined;
  const prepared = { identity: principal, prepared: requester };
  return {
    requester,
    operatorAuthority: verified
      ? await prepareChannelOperatorAuthority(getConfig(), prepared)
      : undefined,
    commandOwnerPrincipal: owner,
    commandOwnerAuthority: owner && (await prepareCommandOwnerAuthority(getConfig(), prepared)),
  };
}

/** A verified sender in the global `commands.ownerAllowFrom` is the owner principal. */
export function decideChannelOwnerPrincipal(config: OpenClawConfig, sender: UserChannelIdentity) {
  return isChannelOwner(config, sender)
    ? {
        profileId: GATEWAY_OWNER_PROFILE_ID,
        canonicalIdentity: null,
        assignedRole: null,
        scopes: ["operator.admin"],
        gatewayAccessGrant: null,
        channelOwner: { ...sender },
      }
    : undefined;
}

/** A plugin-run ingress turn gets the grant of its sender's channel owner principal, if any. */
export const readIngressSenderAdmission = (
  config: OpenClawConfig,
  opts: { messageChannel?: string; accountId?: string; senderId?: string | null },
) => ({
  grant: decideTurnGrant(
    decideChannelOwnerPrincipal(config, {
      channelId: opts.messageChannel ?? "",
      accountId: opts.accountId ?? "",
      senderId: opts.senderId ?? "",
    })?.scopes ?? [],
  ),
});

function intersectOperatorRunModelPolicy(
  original: PreparedOperatorModelPolicy | undefined,
  current: PreparedOperatorModelPolicy | undefined,
): PreparedOperatorModelPolicy | undefined {
  return original &&
    current &&
    readOperatorModelPolicyMembership(original) !== readOperatorModelPolicyMembership(current)
    ? Object.freeze({
        models: Object.freeze(current.models.filter(original.allows)),
        allows: (ref: Parameters<typeof original.allows>[0]) =>
          original.allows(ref) && current.allows(ref),
      })
    : (current ?? original);
}

type OperatorAdmissionDecision = {
  authority: AdmittedRunOperatorAuthority;
  authenticatedUserProfile?: GatewayAuthenticatedUserProfile;
  release: () => void;
};

export function decideOperatorAdmission(
  facts: Extract<Facts, { kind: "gateway" }>,
  prepared: PreparedOperatorAdmission,
): OperatorAdmissionDecision & { authenticatedUserProfile: GatewayAuthenticatedUserProfile };
export function decideOperatorAdmission(
  facts: Facts,
  prepared: PreparedOperatorAdmission,
): OperatorAdmissionDecision;
/** Decide once from prepared owners and committed config; the run keeps only frozen facts. */
export function decideOperatorAdmission(facts: Facts, prepared: PreparedOperatorAdmission) {
  const { config, identity, ingress, paired, channel, context } = prepared;
  const live = facts.kind === "live" ? facts.authority : undefined;
  const snapshot = facts.kind === "live" ? facts.authority : facts.snapshot;
  const gateway = facts.kind === "gateway" ? facts.snapshot : undefined;
  const principal =
    live?.openclawIdPrincipal ??
    (facts.kind === "recorded" ? facts.snapshot.openclawIdPrincipal : gateway?.openclawIdPrincipal);
  const device = gateway?.device ?? live?.device;
  const publicKey = paired && sha256Hex(paired.publicKey);
  const capturedSharedGeneration = gateway?.sharedGeneration ?? live?.sharedGeneration;
  let issuedFacts: AdmittedRunOperatorRoleFacts | undefined;
  try {
    if (live) {
      assertAdmittedRunOperatorAuthority(live);
      if (!identity) {
        issuedFacts = live.readCurrentRoleFacts?.();
      }
    }
    if (principal) {
      if (config.gateway?.openclawId?.enabled === false) {
        throw new OperatorRefusalError("sign-in-ended");
      }
      try {
        if (readOpenClawIdTunnelPrincipal(principal.peerKey) === null) {
          if (config.gateway?.openclawId?.enabled) {
            throw new GatewayOperatorAccessUnavailableError();
          }
          throw new OperatorRefusalError("sign-in-ended");
        }
        if (!isOpenClawIdTunnelPrincipalCurrent(principal)) {
          throw new OperatorRefusalError("sign-in-ended");
        }
      } catch (error) {
        if (
          error instanceof OperatorRefusalError ||
          error instanceof GatewayOperatorAccessUnavailableError
        ) {
          throw error;
        }
        // A failed membership read is not evidence that the principal was revoked.
        throw new GatewayOperatorAccessUnavailableError();
      }
    }
    const binding = live?.canonicalIdentity;
    const profile = identity?.readCurrentFacts(gateway?.aliasBindingIds).profile;
    const profileId = profile?.profileId ?? snapshot.profileId;
    const refuse = () => {
      throw new OperatorRefusalError("sign-in-ended");
    };
    if (live?.channelOwner && !isChannelOwner(config, live.channelOwner)) {
      throw new OperatorRefusalError("owner-removed");
    }
    if (profileId !== snapshot.profileId || (binding && binding.profileId !== profileId)) {
      refuse();
    }
    let scopes =
      facts.kind === "person"
        ? ["operator.admin"]
        : facts.kind === "live"
          ? facts.authority.scopes
          : facts.snapshot.scopes;
    let grant = channel
      ? channel.operatorProfile.gatewayAccessGrant
      : live
        ? live.gatewayAccessGrant
        : facts.kind === "recorded"
          ? facts.snapshot.gatewayAccessGrant
          : null;
    if (facts.kind === "channel") {
      if (
        !channel ||
        channel.operatorProfile.profileId !== snapshot.profileId ||
        !channel.isCurrent(config)
      ) {
        throw new OperatorRefusalError("access-ended");
      }
      scopes = intersectOperatorScopes(scopes, channel.operatorProfile.scopes);
    }
    const source = gateway?.authPolicy ?? live?.authPolicy;
    // Browser origin is checked at connect; saved work follows its person's access,
    // not the submitting browser (owner decision, 2026-11-20).
    const policy = source
      ? resolveGatewayAuthPolicyGrant(config, { ...source, browserOrigin: undefined })
      : undefined;
    // Proxy policy generations do not describe either ambient identity or local fallback secrets.
    const sharedGeneration =
      !principal &&
      (source?.authMethod === "trusted-proxy" ||
        (source?.authMethod === "password" &&
          (source.fallbackCredentialGeneration !== undefined ||
            policy?.methodEnabled !== undefined)))
        ? undefined
        : capturedSharedGeneration;
    if (sharedGeneration !== undefined) {
      if (!context.sharedGatewaySessionGenerationState) {
        throw new GatewayOperatorAccessUnavailableError();
      }
      if (context.sharedGatewaySessionGenerationState.requiredGeneration !== sharedGeneration) {
        refuse();
      }
    }
    if (
      !principal &&
      policy &&
      (policy.methodEnabled === false || policy.proxyUserAllowed === false)
    ) {
      refuse();
    }
    if (source?.authMethod === "password" && !principal) {
      if (
        source.fallbackCredentialGeneration !== undefined
          ? source.fallbackCredentialGeneration !== policy?.fallbackCredentialGeneration
          : policy?.fallbackCredentialGeneration !== undefined &&
            source.grantGeneration !==
              stableStringify(resolveGatewayAuthPolicyGrant(config, source))
      ) {
        refuse();
      }
    }
    if (device && live) {
      // Token sources keep their accepted token generation; tokenless pairing keeps its key.
      if (
        !isPairedDeviceTokenIdentityCurrent(paired ?? null, "operator", device, []) &&
        (!paired ||
          paired.deviceId !== device.deviceId ||
          device.key !== publicKey ||
          paired.tokens?.operator?.revokedAtMs)
      ) {
        refuse();
      }
    } else if (device && gateway) {
      const tokenCurrent = isPairedDeviceTokenIdentityCurrent(
        paired ?? null,
        "operator",
        device,
        [],
      );
      const tokenlessIdentityCurrent =
        !principal &&
        (source?.authMethod === "trusted-proxy" || source?.authMethod === "tailscale") &&
        paired &&
        paired.deviceId === device.deviceId &&
        device.key === publicKey &&
        listApprovedPairedDeviceRoles(paired).includes("operator") &&
        !paired.tokens?.operator?.revokedAtMs;
      if (!tokenCurrent && !tokenlessIdentityCurrent) {
        refuse();
      }
      scopes = intersectOperatorScopes(scopes, [
        ...(tokenCurrent
          ? (paired?.tokens?.operator?.scopes ?? [])
          : (paired?.approvedScopes ?? paired?.scopes ?? [])),
        ...(policy?.grant ?? []),
      ]);
    } else if (gateway && source?.authMethod === "tailscale") {
      // Older rows omitted tokenless device facts. An unchanged grant preserves their
      // hidden device scopes; changed grants can only narrow until these rows age out.
      if (
        source.grantGeneration !== stableStringify(resolveGatewayAuthPolicyGrant(config, source))
      ) {
        scopes = intersectOperatorScopes(scopes, policy?.grant ?? []);
      }
    } else if (gateway && source?.authMethod === "trusted-proxy" && !principal) {
      scopes = intersectOperatorScopes(scopes, policy?.grant ?? []);
    }
    if (live?.deviceScopeCeiling) {
      scopes = intersectOperatorScopes(scopes, [
        ...live.deviceScopeCeiling,
        ...(policy?.grant ?? []),
      ]);
    } else if (
      live &&
      !principal &&
      (source?.authMethod === "trusted-proxy" || source?.authMethod === "tailscale")
    ) {
      scopes = intersectOperatorScopes(scopes, policy?.grant ?? []);
    }
    if (gateway?.sourceIngress === "principal") {
      ingress?.assertCurrent();
      scopes = intersectOperatorScopes(scopes, ingress?.scopes ?? []);
    }
    if (live?.ingress) {
      const bound = live.ingress;
      const boundProfileId =
        bound.principal.kind === "owner" ? GATEWAY_OWNER_PROFILE_ID : bound.principal.profileId;
      if (bound.signal.aborted || boundProfileId !== snapshot.profileId) {
        refuse();
      }
      scopes = intersectOperatorScopes(scopes, bound.scopeCeiling);
    }
    if (
      profile &&
      (gateway?.sourceIngress === "principal" || live?.ingress) &&
      !principal &&
      profileId !== GATEWAY_OWNER_PROFILE_ID &&
      gatewayPersonPrincipalAuthError(
        prepared.ingressAuth,
        config,
        profile.emails,
        operatorRoleSubject(profile),
      )
    ) {
      throw new OperatorRefusalError("access-ended");
    }
    if (profile && facts.kind !== "channel") {
      const access =
        principal?.kind === "owner"
          ? null
          : resolvePreparedGatewayOperatorAccessAuthority(
              { ...profile, role: profile.assignedRole, isCurrent: () => true },
              config,
              { openclawIdPrincipal: principal, grant: gateway ? gateway.grant : grant },
            );
      access?.assertCurrent();
      if (access) {
        grant = access.gatewayAccessGrant;
      }
    }
    const role = structuredClone(
      profile
        ? openclawIdSubjectRolePolicy(principal, () =>
            resolveOperatorRolePolicyForAssignment(
              profileId,
              profile.assignedRole,
              config,
              profile.githubLogin ?? null,
              operatorRoleSubject(profile),
            ),
          )
        : issuedFacts?.policy,
    );
    if (role) {
      scopes = intersectOperatorScopes(scopes, role.scopes);
    } else if (facts.kind === "person" && profileId !== GATEWAY_OWNER_PROFILE_ID) {
      // Without a recorded source, a person has only what a named role gives them.
      scopes = [];
    }
    const agents = role?.agents ?? (!identity ? live?.rolePolicy?.agents : undefined);
    if (facts.agentId && agents && agents !== "*" && !agents.includes(facts.agentId)) {
      throw new OperatorRefusalError("role-denies", {
        action: `start a session for agent "${facts.agentId}"`,
      });
    }
    if (scopes.length === 0) {
      throw new OperatorRefusalError("role-denies");
    }
    const originalModels =
      live?.modelPolicy ??
      ((facts.kind === "gateway" || facts.kind === "channel") && facts.snapshot.modelPolicy
        ? restoreOperatorModelPolicySnapshot(facts.snapshot.modelPolicy)
        : undefined);
    const modelPolicy = intersectOperatorRunModelPolicy(
      originalModels,
      prepareOperatorModelPolicy({
        cfg: config,
        policy: role?.modelPolicy,
        manifestPlugins: getProcessGatewayPluginMetadataSnapshot() ?? [],
      }),
    );
    const authority = createAdmittedRunOperatorAuthority({
      profileId,
      canonicalIdentity: identity ? { profileId } : null,
      openclawIdPrincipal: principal,
      device:
        live?.device ??
        (device && paired && publicKey ? { deviceId: device.deviceId, key: publicKey } : undefined),
      deviceScopeCeiling: live?.deviceScopeCeiling,
      authPolicy: source,
      sharedGeneration: capturedSharedGeneration,
      ingress: live?.ingress,
      scopes,
      gatewayAccessGrant: grant,
      recoverySnapshot: gateway ?? live?.recoverySnapshot,
      recoverySnapshotUnavailableReason: live?.recoverySnapshotUnavailableReason,
      source: live?.source,
      channelRecoverySource:
        facts.kind === "channel"
          ? { reference: facts.snapshot.reference, modelPolicy: originalModels }
          : undefined,
      channelOwner: live?.channelOwner,
      grant: decideTurnGrant(scopes),
      modelPolicy,
      rolePolicy: role
        ? {
            sessionAccessCap: role.sessions.others,
            sandboxRequired: role.sandbox === "required",
            agents: role.agents,
            accessPrograms: role.accessPrograms,
          }
        : live?.rolePolicy,
      readCurrentRoleFacts: () => ({
        assignedRole: profile?.assignedRole ?? issuedFacts?.assignedRole ?? null,
        githubLogin: profile?.githubLogin ?? issuedFacts?.githubLogin ?? null,
        openclawIdAccountIds: profile?.openclawIdAccountIds ?? issuedFacts?.openclawIdAccountIds,
        policy: role,
      }),
    });
    const row = gateway
      ? readResidentUserProfileRevision(profileId, profileCatalogPath({}))
      : undefined;
    if (gateway && !row) {
      throw new GatewayOperatorAccessUnavailableError();
    }
    let authenticatedUserProfile: GatewayAuthenticatedUserProfile | undefined;
    if (row) {
      const { id, ...display } = projectUserProfileDisplay(row);
      authenticatedUserProfile = { profileId: id, ...display, updatedAt: row.updated_at };
    }
    return {
      authority,
      authenticatedUserProfile,
      release: () => identity?.release(),
    };
  } catch (error) {
    identity?.release();
    return admissionError(error, facts);
  } finally {
    ingress?.release();
  }
}

/**
 * A source-less scheduled job's requester grant (configured owner, linked admin, or the profile
 * as a session person); the run takes only this grant. Undefined when admission refuses.
 */
export async function admitScheduledRequesterGrant(
  config: OpenClawConfig,
  agentId: string,
  requester:
    | { kind: "channel"; requester: CronAuthenticatedChannelRequester }
    | { kind: "profile"; profileId: string },
): Promise<TurnGrant | undefined> {
  try {
    if (requester.kind === "channel") {
      const { channel, accountId, senderId } = requester.requester;
      const sender = { channelId: channel, accountId, senderId };
      const scopes =
        decideChannelOwnerPrincipal(config, sender)?.scopes ??
        (await prepareChannelOperatorAdmin(config, sender))?.operatorProfile.scopes;
      return scopes && decideTurnGrant(scopes);
    }
    const { profileId } = requester;
    const subject = operatorRoleSubject(
      captureResidentUserProfileAccess(profileId).readCurrentFacts(),
    );
    // Accepted edge: without named roles, a profile requester has always been the owner.
    if (!isOperatorRoleEnforcedFor(config, subject)) {
      return decideTurnGrant(["operator.admin"]);
    }
    const facts = { kind: "person", snapshot: { profileId }, agentId } as const;
    const admitted = decideOperatorAdmission(
      facts,
      await prepareOperatorAdmission(facts, { getRuntimeConfig: () => config }),
    );
    admitted.release();
    return admitted.authority.grant;
  } catch {
    return undefined;
  }
}
