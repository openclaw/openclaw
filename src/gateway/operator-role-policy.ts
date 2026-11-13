import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/schema/error-codes.js";
import type { ErrorShape, HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import type { SessionsDispatchParams } from "../../packages/gateway-protocol/src/schema/session-placement.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { assertAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { SessionCreatedActor } from "../config/sessions/session-entry-provenance.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { intersectOperatorScopes, roleScopesAllow } from "../shared/operator-scope-compat.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";
import { bumpGatewayAccessRevision } from "./gateway-access-revision.js";
import {
  isOpenClawIdTunnelPrincipalCurrent,
  openclawIdTunnelRolePolicy,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import type { OperatorProfileEnrollment } from "./operator-device-profile.types.js";
import { isNamedOperatorRoleEnforcementEnabled } from "./operator-role-enforcement.js";
import { ADMIN_SCOPE, isOperatorScope } from "./operator-scopes.js";
import type { GatewayClient, GatewayOperatorRoleActor } from "./server-methods/shared-types.js";
import { prepareSessionCreatorProfile } from "./session-creator.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";

const operatorRoleLog = createSubsystemLogger("gateway/operator-roles");
const reportedUnknownAssignments = new Set<string>();
type OperatorRolePolicyChange =
  | { kind: "assignment"; profileId: string; roleOnly: boolean }
  | { kind: "config"; context: object };
const policyListeners = new Set<(change: OperatorRolePolicyChange) => void>();
const configRevisions = new WeakMap<object, object>();
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
  | { actor: GatewayOperatorRoleActor; profileId?: never; client?: never }
  | { actor?: never; profileId: string | undefined; client?: never }
  | { actor?: never; profileId?: never; client: GatewayClient | null | undefined }
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
    configRevisions.set(context, {});
    notifyListeners([...policyListeners], { kind: "config", context });
  }
}

/** Committed publications invalidate prepared policy even when config identity is retained. */
export function readOperatorRoleConfigRevision(context: object): object | undefined {
  return configRevisions.get(context);
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
): { effectiveRole?: string; roleSource: "assigned" | "githubLogin" | "default" } {
  const roles = cfg.gateway?.roles;
  if (
    !roles ||
    !isNamedOperatorRoleEnforcementEnabled(cfg) ||
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
    for (const configuredLogin of Object.keys(assignments)) {
      if (
        configuredLogin.trim().toLowerCase() === login &&
        // SAFETY: Object.keys enumerates the validated string-valued assignment map.
        Object.hasOwn(roles.definitions, assignments[configuredLogin]!)
      ) {
        return { effectiveRole: assignments[configuredLogin], roleSource: "githubLogin" };
      }
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
  if (!isNamedOperatorRoleEnforcementEnabled(cfg) || profileId === GATEWAY_OWNER_PROFILE_ID) {
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
  );
}

/** Transaction and prepared-profile owners supply the current assignment. */
export function resolveOperatorRolePolicyForAssignment(
  profileId: string | undefined,
  assignedRole: string | null,
  cfg: OpenClawConfig,
  githubLogin: string | null,
): GatewayOperatorRoleDefinition | undefined {
  const roles = cfg.gateway?.roles;
  if (
    !roles ||
    !isNamedOperatorRoleEnforcementEnabled(cfg) ||
    profileId === GATEWAY_OWNER_PROFILE_ID
  ) {
    return undefined;
  }
  if (!profileId) {
    return deniedOperatorRole;
  }
  const selection = resolveOperatorRoleSelection(profileId, assignedRole, cfg, githubLogin);
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

/** ID attribution alone uses membership policy; enrolled sources also retain personal limits. */
export function resolveOperatorRolePolicyForPrincipal(
  profileId: string | undefined,
  assignedRole: string | null,
  cfg: OpenClawConfig,
  githubLogin: string | null,
  principal: OpenClawIdTunnelPrincipal | undefined,
  enrollment: Readonly<OperatorProfileEnrollment> | undefined,
): GatewayOperatorRoleDefinition | undefined {
  const membership = openclawIdTunnelRolePolicy(principal);
  if (principal && !enrollment) {
    return membership;
  }
  const personal = resolveOperatorRolePolicyForAssignment(
    profileId,
    assignedRole,
    cfg,
    githubLogin,
  );
  if (!personal || !membership) {
    return personal ?? membership;
  }
  const caps = ["none", "view", "suggest", "write"] as const;
  const others =
    caps.indexOf(personal.sessions.others) < caps.indexOf(membership.sessions.others)
      ? personal.sessions.others
      : membership.sessions.others;
  const scopes = intersectOperatorScopes(personal.scopes, membership.scopes).filter(
    isOperatorScope,
  );
  return {
    ...personal,
    sessions: { others },
    agents:
      membership.agents === "*"
        ? personal.agents
        : personal.agents === "*"
          ? membership.agents
          : personal.agents.filter((agent) => membership.agents.includes(agent)),
    scopes,
  };
}

/** Preserve human-derived restrictions, including ambiguous historical actors; this is not identity proof. */
export function resolveCreatorSandbox(
  cfg: OpenClawConfig,
  creation: { actor?: SessionCreatedActor } | undefined,
): "required" | undefined {
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
  const profileId = client?.authenticatedUserProfile?.profileId;
  const actor =
    client?.internal?.operatorRoleActor ??
    (profileId && profileId !== GATEWAY_OWNER_PROFILE_ID
      ? { kind: "operator" as const, profileId }
      : undefined);
  const enrollment =
    client?.internal?.operatorProfileEnrollment ??
    client?.internal?.operatorRunAuthority?.operatorProfileEnrollment;
  if (enrollment && actor?.kind !== "operator") {
    throw new Error(
      "Personal operator device requires a person principal; reconnect before continuing.",
    );
  }
  return actor;
}

/** Resolves the current named policy from an authoritative operator or system actor. */
export function resolveOperatorRolePolicy(
  client: GatewayClient | null,
  cfg: OpenClawConfig,
): GatewayOperatorRoleDefinition | undefined {
  const actor = resolveGatewayOperatorRoleActor(client);
  // An OpenClaw ID member's membership role caps its connection, independently of named roles.
  const authority = client?.internal?.operatorRunAuthority;
  const principal = client?.internal?.openclawIdPrincipal ?? authority?.openclawIdPrincipal;
  const enrollment =
    client?.internal?.operatorProfileEnrollment ?? authority?.operatorProfileEnrollment;
  if (principal) {
    if (!isOpenClawIdTunnelPrincipalCurrent(principal)) {
      throw new Error("OpenClaw ID membership authority changed");
    }
    client?.internal?.operatorRunAuthority?.assertCurrent();
  }
  if (actor?.kind === "system" && !principal) {
    return undefined;
  }
  if (actor?.kind === "operator" && authority) {
    assertAdmittedRunOperatorAuthority(authority);
    const roleFacts = authority.readCurrentRoleFacts?.();
    if (!roleFacts) {
      authority.assertCurrent();
    }
    if (authority.profileId !== actor.profileId) {
      throw new Error("Gateway requester profile changed");
    }
    // An unenrolled linked owner keeps certificate authority under its person's profile.
    if (!enrollment && authority.openclawIdPrincipal?.kind === "owner") {
      if (!isOpenClawIdTunnelPrincipalCurrent(authority.openclawIdPrincipal)) {
        throw new Error("OpenClaw ID membership authority changed");
      }
      authority.assertCurrent();
      return undefined;
    }
    if (roleFacts?.policy) {
      return roleFacts.policy;
    }
    if (
      !roleFacts &&
      isNamedOperatorRoleEnforcementEnabled(cfg) &&
      authority.profileId !== GATEWAY_OWNER_PROFILE_ID &&
      !(principal && !enrollment)
    ) {
      throw new Error("Operator role assignment was not prepared");
    }
    return resolveOperatorRolePolicyForPrincipal(
      authority.profileId,
      roleFacts?.assignedRole ?? null,
      cfg,
      roleFacts?.githubLogin ?? null,
      principal,
      enrollment,
    );
  }
  // An ID profile alone is attribution, not personal-device enrollment.
  if (principal && !enrollment) {
    return resolveOperatorRolePolicyForPrincipal(undefined, null, cfg, null, principal, enrollment);
  }
  const prepared = client?.preparedSessionProfile;
  if (actor?.kind === "operator" && prepared?.aliases.has(actor.profileId)) {
    return resolveOperatorRolePolicyForPrincipal(
      prepared.profileId,
      prepared.role,
      cfg,
      prepared.githubLogin ?? null,
      principal,
      enrollment,
    );
  }
  const profileId =
    actor?.kind === "operator"
      ? actor.profileId
      : principal?.kind === "owner"
        ? GATEWAY_OWNER_PROFILE_ID
        : undefined;
  const profile =
    isNamedOperatorRoleEnforcementEnabled(cfg) &&
    profileId &&
    profileId !== GATEWAY_OWNER_PROFILE_ID
      ? captureResidentUserProfileAccess(profileId).assertCurrent()
      : undefined;
  return resolveOperatorRolePolicyForPrincipal(
    profileId,
    profile?.role ?? null,
    cfg,
    profile?.githubLogin ?? null,
    principal,
    enrollment,
  );
}

/** A retained caller cannot keep grants removed by the current named role. */
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
  const actor =
    params.actor ??
    ("client" in params ? resolveGatewayOperatorRoleActor(params.client) : undefined);
  if (actor?.kind === "system") {
    return undefined;
  }
  const profileId = actor?.profileId ?? params.profileId;
  // Keep the client's prepared identity and live run authority at this boundary.
  const role = prepared
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
