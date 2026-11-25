import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/schema/error-codes.js";
import type { ErrorShape, HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import type { SessionsDispatchParams } from "../../packages/gateway-protocol/src/schema/session-placement.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import type { SessionCreatedActor } from "../config/sessions/session-entry-provenance.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isDeeplyFrozenPlainData,
  memoizeFrozenPlainDataProjection,
} from "../shared/immutable-data.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";
import { bumpGatewayAccessRevision } from "./gateway-access-revision.js";
import {
  isOpenClawIdTunnelPrincipalCurrent,
  OpenClawIdPrincipalChangedError,
  openclawIdTunnelRolePolicy,
  openclawIdSubjectRolePolicy,
} from "./openclaw-id/tunnel-principal.js";
import {
  isNamedOperatorRoleEnforcementEnabled,
  isOperatorRoleEnforcedFor,
  operatorRoleSubject,
  type OperatorRoleSubject,
} from "./operator-role-enforcement.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import type { GatewayClient, GatewayOperatorRoleActor } from "./server-methods/shared-types.js";
import { prepareSessionCreatorProfile } from "./session-creator.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";

const operatorRoleLog = createSubsystemLogger("gateway/operator-roles");
const reportedUnknownAssignments = new Set<string>();
const githubAssignmentKeys = memoizeFrozenPlainDataProjection(
  (assignments: Record<string, string>) => {
    const keys: Record<string, string> = Object.create(null);
    for (const key of Object.keys(assignments)) {
      keys[key.trim().toLowerCase()] ??= key;
    }
    return keys;
  },
);
type OperatorRolePolicyChange =
  | { kind: "assignment"; profileId: string; roleOnly: boolean }
  | { kind: "config"; context: object };
const policyListeners = new Set<(change: OperatorRolePolicyChange) => void>();
let assignmentRevision = 0;
const deniedOperatorRole: GatewayOperatorRoleDefinition = {
  sessions: { others: "none" },
  agents: [],
  scopes: [],
};

type GatewaySessionAgentAuthorization = {
  cfg: OpenClawConfig;
  agentId: string;
} & (
  | { authority: AdmittedRunOperatorAuthority; actor?: never; profileId?: never; client?: never }
  | { authority?: never; actor: GatewayOperatorRoleActor; profileId?: never; client?: never }
  | { authority?: never; actor?: never; profileId: string | undefined; client?: never }
  | {
      authority?: never;
      actor?: never;
      profileId?: never;
      client: GatewayClient | null | undefined;
    }
);

/**
 * Publishes a committed assignment change to retained authorization consumers. `roleOnly`
 * marks a change to the profile's named role alone, with the person behind it unchanged.
 */
export function invalidateOperatorRolePolicy(
  profileId: string,
  opts?: { roleOnly?: boolean },
): void {
  assignmentRevision += 1;
  bumpGatewayAccessRevision();
  for (const reported of reportedUnknownAssignments) {
    if (reported.startsWith(`${profileId}:`)) {
      reportedUnknownAssignments.delete(reported);
    }
  }
  notifyListeners([...policyListeners], {
    kind: "assignment",
    profileId,
    roleOnly: opts?.roleOnly === true,
  });
}

export function onOperatorRolePolicyChanged(
  listener: (change: OperatorRolePolicyChange) => void,
): () => void {
  return registerListener(policyListeners, listener);
}

/** Called after this Gateway's committed runtime reader advances, never at tentative activation. */
export function publishOperatorRoleConfigChange(context: object | undefined): void {
  if (context) {
    notifyListeners([...policyListeners], { kind: "config", context });
  }
}

export function readOperatorRolePolicyRevision(): number {
  return assignmentRevision;
}

/** Resolve names once for both authorization and the administrative profile projection. */
export function resolveOperatorRoleSelection(
  profileId: string | undefined,
  assignedRole: string | null,
  cfg: OpenClawConfig,
  githubLogin: string | null,
  subject: OperatorRoleSubject = { profileId, openclawIdMember: false },
): { effectiveRole?: string; roleSource: "assigned" | "githubLogin" | "default" } {
  const roles = cfg.gateway?.roles;
  if (
    !roles ||
    !isOperatorRoleEnforcedFor(cfg, subject) ||
    !profileId ||
    profileId === GATEWAY_OWNER_PROFILE_ID
  ) {
    return { roleSource: "default" };
  }
  if (assignedRole && Object.hasOwn(roles.definitions, assignedRole)) {
    return { effectiveRole: assignedRole, roleSource: "assigned" };
  }
  const login = githubLogin?.toLowerCase();
  const assignments = roles.assignments?.byGithubLogin;
  if (login && assignments) {
    // Config validation rejects duplicate normalized logins; exact keys need no roster scan.
    const key = Object.hasOwn(assignments, login)
      ? login
      : isDeeplyFrozenPlainData(assignments)
        ? githubAssignmentKeys(assignments)[login]
        : Object.keys(assignments).find((candidate) => candidate.trim().toLowerCase() === login);
    const role = key === undefined ? undefined : assignments[key];
    if (role && Object.hasOwn(roles.definitions, role)) {
      return { effectiveRole: role, roleSource: "githubLogin" };
    }
  }
  return { effectiveRole: roles.default, roleSource: "default" };
}

/** An enabled role boundary denies missing identity and unresolvable assignments. */
export function resolveOperatorRolePolicyForProfile(
  profileId: string | undefined,
  cfg: OpenClawConfig,
): GatewayOperatorRoleDefinition | undefined {
  // The owner attributes the shared-secret system actor; roles govern identified people only.
  if (
    profileId === GATEWAY_OWNER_PROFILE_ID ||
    (!isNamedOperatorRoleEnforcementEnabled(cfg) && !cfg.gateway?.openclawId?.enabled)
  ) {
    return undefined;
  }
  const profile = profileId
    ? captureResidentUserProfileAccess(profileId).assertCurrent()
    : undefined;
  return resolveOperatorRolePolicyForAssignment(
    profileId,
    profile?.role ?? null,
    cfg,
    profile?.githubLogin ?? null,
    operatorRoleSubject(profile),
  );
}

/** Transaction and prepared-profile owners supply the current assignment. */
export function resolveOperatorRolePolicyForAssignment(
  profileId: string | undefined,
  assignedRole: string | null,
  cfg: OpenClawConfig,
  githubLogin: string | null,
  subject: OperatorRoleSubject = { profileId, openclawIdMember: false },
): GatewayOperatorRoleDefinition | undefined {
  const roles = cfg.gateway?.roles;
  if (profileId === GATEWAY_OWNER_PROFILE_ID) {
    return undefined;
  }
  if (subject.openclawIdMember && !roles) {
    return deniedOperatorRole;
  }
  if (!isOperatorRoleEnforcedFor(cfg, subject)) {
    return undefined;
  }
  if (!profileId || !roles) {
    return deniedOperatorRole;
  }
  const selection = resolveOperatorRoleSelection(
    profileId,
    assignedRole,
    cfg,
    githubLogin,
    subject,
  );
  if (assignedRole && selection.roleSource !== "assigned") {
    const reportKey = `${profileId}:${assignedRole}`;
    if (!reportedUnknownAssignments.has(reportKey)) {
      if (reportedUnknownAssignments.size >= 1_024) {
        reportedUnknownAssignments.clear();
      }
      reportedUnknownAssignments.add(reportKey);
      operatorRoleLog.warn(
        `User profile ${profileId} references unknown Gateway role "${assignedRole}"; ${
          selection.effectiveRole
            ? `applying ${selection.roleSource} role "${selection.effectiveRole}"`
            : "denying access"
        }. Update gateway.roles.definitions or clear the assignment with users.setRole.`,
      );
    }
  }
  return (
    (selection.effectiveRole ? roles.definitions[selection.effectiveRole] : undefined) ??
    deniedOperatorRole
  );
}

/** Resolve sandbox requirements through the creator's profile; owner devices keep owner authority. */
export function resolveCreatorSandbox(
  cfg: OpenClawConfig,
  creation:
    | {
        actor?: SessionCreatedActor;
        openclawIdPrincipal?: import("./openclaw-id/tunnel-principal.js").OpenClawIdTunnelPrincipal;
      }
    | undefined,
): "required" | undefined {
  const principal = creation?.openclawIdPrincipal;
  if (principal?.kind === "member") {
    if (!isOpenClawIdTunnelPrincipalCurrent(principal)) {
      throw new OpenClawIdPrincipalChangedError();
    }
  }
  if (principal?.kind === "owner") {
    return undefined;
  }
  const actor = creation?.actor;
  return actor?.type === "human" &&
    actor.id &&
    resolveOperatorRolePolicyForProfile(actor.id, cfg)?.sandbox === "required"
    ? "required"
    : undefined;
}

/** Resolves the current named policy from the connection's verified profile identity. */
export function resolveGatewayOperatorRoleActor(
  client: GatewayClient | null | undefined,
): GatewayOperatorRoleActor | undefined {
  const actor = client?.internal?.operatorRoleActor;
  if (actor) {
    return actor;
  }
  const profileId = client?.authenticatedUserProfile?.profileId;
  return profileId && profileId !== GATEWAY_OWNER_PROFILE_ID
    ? { kind: "operator", profileId }
    : undefined;
}

/** Resolves the current named policy from an authoritative operator or system actor. */
export function resolveOperatorRolePolicy(
  client: GatewayClient | null,
  cfg: OpenClawConfig,
): GatewayOperatorRoleDefinition | undefined {
  const actor = resolveGatewayOperatorRoleActor(client);
  const authority = client?.internal?.operatorRunAuthority;
  const principal = client?.internal?.openclawIdPrincipal;
  if (principal) {
    if (!authority && !isOpenClawIdTunnelPrincipalCurrent(principal)) {
      throw new Error("OpenClaw ID membership changed. Reconnect before starting a request.");
    }
    if (principal.kind !== "member") {
      return openclawIdTunnelRolePolicy(principal);
    }
  }
  if (actor?.kind === "system") {
    return undefined;
  }
  if (actor?.kind === "operator" && authority) {
    assertAdmittedRunOperatorAuthority(authority);
    const roleFacts = authority.readCurrentRoleFacts?.();
    if (authority.profileId !== actor.profileId) {
      throw new Error("Gateway requester profile changed");
    }
    // A linked owner device's run keeps the owner's authority under its person's profile.
    if (authority.openclawIdPrincipal?.kind === "owner") {
      return undefined;
    }
    if (roleFacts && Object.hasOwn(roleFacts, "policy")) {
      return roleFacts.policy;
    }
    if (
      !isOperatorRoleEnforcedFor(
        cfg,
        operatorRoleSubject({
          profileId: authority.profileId,
          openclawIdAccountIds: roleFacts?.openclawIdAccountIds,
        }),
      ) ||
      authority.profileId === GATEWAY_OWNER_PROFILE_ID
    ) {
      return undefined;
    }
    if (!roleFacts) {
      throw new Error("Operator role assignment was not prepared");
    }
    return openclawIdSubjectRolePolicy(principal, () =>
      resolveOperatorRolePolicyForAssignment(
        authority.profileId,
        roleFacts.assignedRole,
        cfg,
        roleFacts.githubLogin ?? null,
        operatorRoleSubject(roleFacts),
      ),
    );
  }
  const prepared = client?.preparedSessionProfile;
  if (actor?.kind === "operator" && prepared?.aliases.has(actor.profileId)) {
    return openclawIdSubjectRolePolicy(principal, () =>
      resolveOperatorRolePolicyForAssignment(
        prepared.profileId,
        prepared.role,
        cfg,
        prepared.githubLogin ?? null,
        operatorRoleSubject(prepared),
      ),
    );
  }
  return openclawIdSubjectRolePolicy(principal, () =>
    resolveOperatorRolePolicyForProfile(
      actor?.profileId ?? client?.authenticatedUserProfile?.profileId,
      cfg,
    ),
  );
}

type ProjectGrantSubject =
  | { client: GatewayClient | null | undefined }
  | {
      profileId: string | undefined;
      openclawIdPrincipal?: import("./openclaw-id/tunnel-principal.js").OpenClawIdTunnelPrincipal;
    };

/**
 * Project grants are never admission facts. Retained clients and run authorities pass the
 * ordinary role boundary, then read their canonical profile's current role from live config.
 * A profile merged away since admission resolves to another person's role, so it grants nothing.
 */
export function resolveCurrentProjectGrant(
  cfg: OpenClawConfig,
  subject: ProjectGrantSubject,
): GatewayOperatorRoleDefinition["projects"] {
  if ("profileId" in subject) {
    const { profileId } = subject;
    return openclawIdSubjectRolePolicy(subject.openclawIdPrincipal, () => {
      const policy = resolveOperatorRolePolicyForProfile(profileId, cfg);
      return policy &&
        profileId &&
        captureResidentUserProfileAccess(profileId).assertCurrent().id !== profileId
        ? undefined
        : policy;
    })?.projects;
  }
  const { client } = subject;
  if (!resolveOperatorRolePolicy(client ?? null, cfg)) {
    return undefined;
  }
  const actor = resolveGatewayOperatorRoleActor(client);
  const actorProfileId = actor?.kind === "operator" ? actor.profileId : undefined;
  const authority = client?.internal?.operatorRunAuthority;
  const prepared = client?.preparedSessionProfile;
  const profileId =
    (actorProfileId && authority?.profileId) ||
    (actorProfileId && prepared?.aliases.has(actorProfileId) ? prepared.profileId : undefined) ||
    actorProfileId ||
    client?.authenticatedUserProfile?.profileId;
  return resolveCurrentProjectGrant(cfg, {
    profileId,
    openclawIdPrincipal: client?.internal?.openclawIdPrincipal ?? authority?.openclawIdPrincipal,
  });
}

/** Admit the request against its prepared role or the connection's current named role. */
export function authorizeCurrentOperatorRoleScopes(
  client: GatewayClient | null,
  cfg: OpenClawConfig,
): ErrorShape | undefined {
  const policy = resolveOperatorRolePolicy(client, cfg);
  if (
    policy &&
    !roleScopesAllow({
      role: "operator",
      requestedScopes: client?.connect.scopes ?? [],
      allowedScopes: policy.scopes,
    })
  ) {
    return errorShape(
      ErrorCodes.FORBIDDEN,
      "Your operator role changed; reconnect before continuing.",
    );
  }
  return undefined;
}

export function operatorSessionCap(
  client: GatewayClient | null,
  cfg: OpenClawConfig,
): HelloOk["auth"]["sessionCap"] {
  return resolveOperatorRolePolicy(client, cfg)?.sessions.others;
}

export function hasOperatorBoundary(
  client: GatewayClient | null,
  cfg: OpenClawConfig,
  prepared?: { sessionCap: ReturnType<typeof operatorSessionCap> },
): boolean {
  if ((prepared ? prepared.sessionCap : operatorSessionCap(client, cfg)) !== undefined) {
    return true;
  }
  if (resolveGatewayOperatorRoleActor(client)?.kind === "system") {
    return false;
  }
  const scopes = client?.connect?.scopes ?? [];
  return (
    roleScopesAllow({
      role: "operator",
      requestedScopes: ["operator.sessions.read"],
      allowedScopes: scopes,
    }) &&
    !roleScopesAllow({
      role: "operator",
      requestedScopes: ["operator.read"],
      allowedScopes: scopes,
    })
  );
}

/** Enforces the owning agent ceiling for session creation and run-start targets. */
export function authorizeGatewaySessionCreation(
  params: GatewaySessionAgentAuthorization,
  prepared?: { policy: GatewayOperatorRoleDefinition | undefined },
): ErrorShape | undefined {
  if (params.authority) {
    assertAdmittedRunOperatorAuthority(params.authority);
  }
  const actor =
    params.actor ??
    ("client" in params ? resolveGatewayOperatorRoleActor(params.client) : undefined);
  if (!params.authority && actor?.kind === "system") {
    return undefined;
  }
  const profileId = actor?.kind === "operator" ? actor.profileId : params.profileId;
  const role = params.authority
    ? params.authority.rolePolicy
    : prepared
      ? prepared.policy
      : "client" in params
        ? resolveOperatorRolePolicy(params.client ?? null, params.cfg)
        : resolveOperatorRolePolicyForProfile(profileId, params.cfg);
  if (!role || role.agents === "*" || role.agents.includes(params.agentId)) {
    return undefined;
  }
  return errorShape(
    ErrorCodes.FORBIDDEN,
    `Your operator role cannot create sessions for agent "${params.agentId}"; choose an allowed agent or ask a gateway administrator to update your role.`,
  );
}

/** Agents the caller's named operator role allows, or undefined when the role does not restrict agents. */
export function resolveOperatorRoleAgents(
  client: GatewayClient | null,
  cfg: OpenClawConfig,
): readonly string[] | undefined {
  const role = resolveOperatorRolePolicy(client, cfg);
  return role && role.agents !== "*" ? role.agents : undefined;
}

/** Named roles may dispatch only their own sessions to explicitly granted cloud profiles. */
export function assertOperatorCloudProfileDispatchAllowed(params: {
  config: OpenClawConfig;
  client: GatewayClient | null | undefined;
  target: Pick<SessionsDispatchParams, "deviceId" | "autoDevice" | "profileId">;
  createdActor: SessionCreatedActor | undefined;
  runSetupScript: boolean;
}): void {
  const role = resolveOperatorRolePolicy(params.client ?? null, params.config);
  const administrator =
    (!isNamedOperatorRoleEnforcementEnabled(params.config) && !params.client) ||
    (params.client?.connect?.scopes?.includes(ADMIN_SCOPE) === true &&
      (!role || role.scopes.includes(ADMIN_SCOPE)));
  if (administrator) {
    return;
  }
  if (!params.runSetupScript) {
    if (params.target.deviceId !== undefined || params.target.autoDevice === true) {
      return;
    }
    const actor = resolveGatewayOperatorRoleActor(params.client);
    if (
      actor?.kind === "operator" &&
      params.target.profileId &&
      role?.workerProfiles?.includes(params.target.profileId) &&
      prepareSessionCreatorProfile(
        actor.profileId,
        params.client?.preparedSessionProfile?.aliases,
      )(params.createdActor)
    ) {
      return;
    }
  }
  throw new SessionMutationAuthorizationChangedError(
    errorShape(
      ErrorCodes.FORBIDDEN,
      "Your operator role cannot dispatch to this cloud profile; choose your own session and an allowed profile, or ask a gateway administrator to update your role.",
    ),
  );
}
