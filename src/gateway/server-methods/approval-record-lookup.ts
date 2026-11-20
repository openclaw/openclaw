import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeNullableString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelApprovalKind } from "../../infra/approval-types.js";
import type { ExecApprovalManager, ExecApprovalRecord } from "../exec-approval-manager.js";
import {
  canResolveParticipationExecApproval,
  participationApprovalTurnActor,
} from "../exec-approval-participation.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "../method-scopes.js";
import type { OperatorApprovalRecord } from "../operator-approval-store.types.js";
import { operatorSessionCap, resolveGatewayOperatorRoleActor } from "../operator-role-policy.js";
import { prepareSessionCreatorProfile } from "../session-creator.js";
import { resolveSessionEventAgentScope } from "../session-request-agent.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import type {
  PreparedSessionMutationFacts,
  SessionSharingTarget,
} from "../session-sharing-policy.js";
import {
  prepareSessionMutationFacts,
  type SessionFactsRead,
} from "../session-sharing-preparation.js";
import { prepareProjectedSessionSharing } from "../session-sharing-read.js";
import { createSessionListEntryFilter, type prepareSessionSharing } from "../session-sharing.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import type { ApprovalRequestAuthority } from "./approval-request-authority.js";
import type { GatewayClient, RespondFn } from "./types.js";

const APPROVAL_NOT_FOUND_DETAILS = {
  reason: ErrorCodes.APPROVAL_NOT_FOUND,
  remediation: "Re-request the action; pending approvals are cleared after expiry or restart.",
} as const;

type PendingApprovalLookupError =
  | "missing"
  | { code: (typeof ErrorCodes)["INVALID_REQUEST"]; message: string };

export type ApprovalRecordLookupResult<TPayload> =
  | { ok: true; approvalId: string; snapshot: ExecApprovalRecord<TPayload> }
  | { ok: false; response: PendingApprovalLookupError };

type ApprovalSessionAccessParams = {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  sessionKey?: string | null;
  agentId?: string | null;
  requestedByProfileId?: string | null;
  prepared?: {
    sharing: ReturnType<typeof prepareSessionSharing>;
    target: (sessionKey: string, agentId?: string) => SessionSharingTarget | null;
  };
  readFacts?: (sessionKey: string, agentId?: string) => PreparedSessionMutationFacts | undefined;
};

/** Display-profile readers retain their policy; delegated invitees carry the same deny filter. */
export function approvalReaderSessionPolicy(
  client: GatewayClient | null,
  getCfg: () => OpenClawConfig,
): { getCfg?: () => OpenClawConfig } {
  return client?.authenticatedUserProfile || operatorSessionCap(client, getCfg()) === "invited"
    ? { getCfg }
    : {};
}

/** Existing session visibility remains independent of approval requester ownership. */
function canReadApprovalSession(params: ApprovalSessionAccessParams): boolean {
  const cap = operatorSessionCap(params.client, params.cfg);
  if (cap !== "none" && cap !== "invited") {
    return true;
  }
  const visibilityFilter = params.prepared
    ? params.prepared.sharing.entryFilter
    : createSessionListEntryFilter({ client: params.client, cfg: params.cfg });
  if (!visibilityFilter) {
    return true;
  }
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return false;
  }
  const agentId = normalizeOptionalString(params.agentId);
  const facts = params.readFacts?.(sessionKey, agentId);
  const target = params.prepared ? params.prepared.target(sessionKey, agentId) : facts?.target;
  return Boolean(
    target &&
    (params.prepared
      ? params.prepared.sharing.canReadTarget(target)
      : createSessionListEntryFilter({
          client: params.client,
          cfg: params.cfg,
          membership: facts?.membership,
        })?.(target.storeKey, target.entry) !== false),
  );
}

/** Invitation access adds a requester restriction; it never replaces reviewer binding. */
export function canAccessApprovalSession(params: ApprovalSessionAccessParams): boolean {
  if (!canReadApprovalSession(params)) {
    return false;
  }
  if (
    operatorSessionCap(params.client, params.cfg) !== "invited" ||
    params.client?.connect.scopes?.includes(ADMIN_SCOPE)
  ) {
    return true;
  }
  const actor = resolveGatewayOperatorRoleActor(params.client);
  const profileId =
    params.client?.authenticatedUserProfile?.profileId ??
    (actor?.kind === "operator" ? actor.profileId : undefined);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const agentId = normalizeOptionalString(params.agentId);
  const facts = sessionKey ? params.readFacts?.(sessionKey, agentId) : undefined;
  const target =
    sessionKey && (params.prepared ? params.prepared.target(sessionKey, agentId) : facts?.target);
  if (!target || !profileId) {
    return false;
  }
  const isProfile = prepareSessionCreatorProfile(
    profileId,
    params.client?.preparedSessionProfile?.aliases,
  );
  if (isProfile(target.entry.createdActor)) {
    return true;
  }
  const isMember = params.prepared
    ? params.prepared.sharing.roleForTarget(target) === "member"
    : facts?.membership.has(profileId) === true;
  return (
    !isMember ||
    Boolean(
      params.requestedByProfileId &&
      isProfile({ type: "human", source: "profile", id: params.requestedByProfileId }),
    )
  );
}

/** New event filtering applies only to invitation access; other audiences retain their owners. */
export function canAccessInvitedApprovalSession(params: ApprovalSessionAccessParams): boolean {
  return (
    operatorSessionCap(params.client, params.cfg) !== "invited" || canAccessApprovalSession(params)
  );
}

/** Synchronous event audiences consume the resident sharing owner, never fresh SQL. */
export function prepareProjectedApprovalSessionAccess(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  projection?: SessionRowProjection;
}): Parameters<typeof canAccessApprovalSession>[0]["prepared"] {
  const { cfg, client, projection } = params;
  if (!projection) {
    return undefined;
  }
  return {
    sharing: prepareProjectedSessionSharing({
      cfg: projection.getPolicyConfig() ?? cfg,
      client,
      isMember: (target, identity) =>
        projection.hasMembership(target.storePath, target.storeKey, identity),
    }),
    target: (key, owner) => {
      const scope = resolveSessionEventAgentScope(cfg, key, owner);
      return scope?.[1] ? projection.sharingTarget({ key, agentId: scope[1] }) : null;
    },
  };
}

type ApprovalSessionSource = {
  sessionKey?: string | null;
  agentId?: string | null;
  requestedByProfileId?: string | null;
};

/** Retain receipt-updated sharing facts while approval I/O yields. */
export async function prepareApprovalSessionAccess(params: {
  client: GatewayClient | null;
  cfg?: OpenClawConfig;
  getCfg?: () => OpenClawConfig;
  sources: readonly ApprovalSessionSource[];
}) {
  const reads = new Map<string, SessionFactsRead<PreparedSessionMutationFacts>>();
  const sourceKey = (sessionKey: string, agentId?: string | null) =>
    JSON.stringify([sessionKey, agentId ?? null]);
  const release = () => {
    for (const read of reads.values()) {
      read.release();
    }
  };
  try {
    const cfg = params.getCfg?.() ?? params.cfg;
    if (cfg && ["none", "invited"].includes(operatorSessionCap(params.client, cfg) ?? "")) {
      for (const source of params.sources) {
        const sessionKey = normalizeOptionalString(source.sessionKey);
        const requestedAgentId = normalizeOptionalString(source.agentId);
        if (!sessionKey || reads.has(sourceKey(sessionKey, requestedAgentId))) {
          continue;
        }
        const { agentId } = resolveSessionStoreIdentity({
          cfg,
          sessionKey,
          agentId: requestedAgentId,
        });
        reads.set(
          sourceKey(sessionKey, requestedAgentId),
          await prepareSessionMutationFacts({ cfg, sessionKey, agentId, allowMissing: true }),
        );
      }
    }
    const check = (
      source: ApprovalSessionSource,
      mode: "access" | "read" | "invite" = "access",
    ) => {
      const currentCfg = params.getCfg?.() ?? params.cfg;
      return (
        !currentCfg ||
        (mode === "read"
          ? canReadApprovalSession
          : mode === "invite"
            ? canAccessInvitedApprovalSession
            : canAccessApprovalSession)({
          cfg: currentCfg,
          client: params.client,
          ...source,
          readFacts: (sessionKey, agentId) =>
            reads.get(sourceKey(sessionKey, agentId))?.readCurrent(currentCfg),
        })
      );
    };
    return {
      canAccess: (source: ApprovalSessionSource) => check(source),
      canRead: (source: ApprovalSessionSource) => check(source, "read"),
      canAccessInvited: (source: ApprovalSessionSource) => check(source, "invite"),
      [Symbol.dispose]: release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** Payloads are kind-specific; every approval kind carries its source session in the same fields. */
export function readApprovalRequestSource(record: ExecApprovalRecord<unknown>) {
  const source = isRecord(record.request) ? record.request : undefined;
  return {
    sessionKey: normalizeOptionalString(source?.sessionKey),
    agentId: normalizeOptionalString(source?.agentId),
    requestedByProfileId: record.requestedByProfileId,
  };
}

/** Durable reads use the same profile boundary as live pending records. */
export function readOperatorApprovalRequestSource(
  record: OperatorApprovalRecord,
): ApprovalSessionSource {
  return { ...record.source, requestedByProfileId: record.requester.profileId };
}

export function isApprovalRecordVisibleToClient<TPayload>(params: {
  record: ExecApprovalRecord<TPayload>;
  client: GatewayClient | null;
  cfg?: OpenClawConfig;
  prepared?: Parameters<typeof canAccessApprovalSession>[0]["prepared"];
  sessionAccess?: Awaited<ReturnType<typeof prepareApprovalSessionAccess>>;
  resolving?: boolean;
}): boolean {
  if (params.resolving) {
    const participation = canResolveParticipationExecApproval(params.record, params.client);
    if (participation !== undefined) {
      return participation;
    }
  }
  const scopes = params.client?.connect.scopes ?? [];
  if (scopes.includes(ADMIN_SCOPE)) {
    return true;
  }
  if (
    params.cfg &&
    !(
      params.sessionAccess?.canAccess(readApprovalRequestSource(params.record)) ??
      canAccessApprovalSession({
        cfg: params.cfg,
        client: params.client,
        ...readApprovalRequestSource(params.record),
        prepared: params.prepared,
      })
    )
  ) {
    return false;
  }
  const requestedByDeviceId = normalizeNullableString(params.record.requestedByDeviceId);
  const requestedByClientId = normalizeNullableString(params.record.requestedByClientId);
  const hasApprovalsScope = scopes.includes(APPROVALS_SCOPE);
  if (hasApprovalsScope && params.client?.internal?.approvalRuntime === true) {
    return true;
  }
  const approvalReviewerDeviceIds = normalizeUniqueTrimmedStringList(
    params.record.approvalReviewerDeviceIds,
  );
  const clientDeviceId = normalizeNullableString(params.client?.connect?.device?.id);
  if (hasApprovalsScope && clientDeviceId && approvalReviewerDeviceIds.includes(clientDeviceId)) {
    return true;
  }
  // Legacy adapters retain exact requester connection/device authority.
  if (requestedByDeviceId) {
    return requestedByDeviceId === clientDeviceId;
  }
  const requestedByConnId = normalizeNullableString(params.record.requestedByConnId);
  if (requestedByConnId) {
    return requestedByConnId === normalizeNullableString(params.client?.connId);
  }
  // Pre-binding pending approvals remain operable after upgrades and restarts.
  return !requestedByClientId && approvalReviewerDeviceIds.length === 0;
}

export async function listVisiblePendingApprovalRequests<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  authority?: ApprovalRequestAuthority;
  client?: GatewayClient | null;
  cfg?: OpenClawConfig;
  approvalKind?: ChannelApprovalKind;
  getCfg?: () => OpenClawConfig;
}): Promise<
  Array<{
    approvalKind?: ChannelApprovalKind;
    id: string;
    canDecide?: boolean;
    request: TPayload;
    createdAtMs: number;
    expiresAtMs: number;
  }>
> {
  const records = await params.manager.listPendingRecords(params.authority);
  params.authority?.assertCurrent();
  using sessionAccess = await prepareApprovalSessionAccess({
    ...params,
    client: params.client ?? null,
    sources: records.map(readApprovalRequestSource),
  });
  params.authority?.assertCurrent();
  const cfg = params.getCfg?.() ?? params.cfg;
  return records
    .filter(
      (record) =>
        !params.client?.invalidated &&
        (canResolveParticipationExecApproval(record, params.client) ??
          isApprovalRecordVisibleToClient({
            record,
            client: params.client ?? null,
            ...(cfg ? { cfg } : {}),
            sessionAccess,
          })),
    )
    .map((record) => {
      const { id, request, createdAtMs, expiresAtMs } = record;
      const turnActor = participationApprovalTurnActor(record);
      const approval = Object.assign(
        { id, request: turnActor ? { ...request, turnActor } : request, createdAtMs, expiresAtMs },
        record.participation ? { canDecide: true } : {},
      );
      return params.approvalKind
        ? Object.assign(approval, { approvalKind: params.approvalKind })
        : approval;
    });
}

async function resolveApprovalRecordForState<TPayload>(
  params: {
    manager: ExecApprovalManager<TPayload>;
    authority?: ApprovalRequestAuthority;
    inputId: string;
    client?: GatewayClient | null;
    cfg?: OpenClawConfig;
    getCfg?: () => OpenClawConfig;
    exposeAmbiguousPrefixError?: boolean;
    recordFilter?: (record: ExecApprovalRecord<TPayload>) => boolean | Promise<boolean>;
    resolving?: boolean;
  },
  expectedState: "pending" | "resolved",
): Promise<ApprovalRecordLookupResult<TPayload>> {
  await params.manager.listPendingRecords(params.authority);
  params.authority?.assertCurrent();
  const candidates: ExecApprovalRecord<TPayload>[] = [];
  params.manager.lookupLocalApprovalId(params.inputId, {
    includeResolved: expectedState === "resolved",
    filter: (record) => {
      candidates.push(record);
      return true;
    },
  });
  using sessionAccess = await prepareApprovalSessionAccess({
    ...params,
    client: params.client ?? null,
    sources: candidates.map(readApprovalRequestSource),
  });
  params.authority?.assertCurrent();
  const visible = async (record: ExecApprovalRecord<TPayload>) => {
    const cfg = params.getCfg?.() ?? params.cfg;
    return (
      !params.client?.invalidated &&
      isApprovalRecordVisibleToClient({
        record,
        client: params.client ?? null,
        ...(cfg ? { cfg } : {}),
        sessionAccess,
        resolving: params.resolving,
      }) &&
      ((await params.recordFilter?.(record)) ?? true)
    );
  };
  const resolvedId = await params.manager.lookupApprovalId(params.inputId, {
    includeResolved: expectedState === "resolved",
    filter: visible,
    authority: params.authority,
  });
  params.authority?.assertCurrent();
  if (resolvedId.kind !== "exact" && resolvedId.kind !== "prefix") {
    return {
      ok: false,
      response:
        resolvedId.kind === "none" || !params.exposeAmbiguousPrefixError
          ? "missing"
          : {
              code: ErrorCodes.INVALID_REQUEST,
              message: "ambiguous approval id prefix; use the full id",
            },
    };
  }
  const snapshot = await params.manager.getSnapshot(resolvedId.id, params.authority);
  params.authority?.assertCurrent();
  const isResolved = snapshot?.resolvedAtMs !== undefined;
  if (!snapshot || isResolved !== (expectedState === "resolved") || !(await visible(snapshot))) {
    return { ok: false, response: "missing" };
  }
  params.authority?.bindSource(readApprovalRequestSource(snapshot));
  return { ok: true, approvalId: resolvedId.id, snapshot };
}

export function resolvePendingApprovalRecord<TPayload>(
  params: Parameters<typeof resolveApprovalRecordForState<TPayload>>[0],
): Promise<ApprovalRecordLookupResult<TPayload>> {
  return resolveApprovalRecordForState(params, "pending");
}

export function resolveResolvedApprovalRecord<TPayload>(
  params: Parameters<typeof resolvePendingApprovalRecord<TPayload>>[0],
): Promise<ApprovalRecordLookupResult<TPayload>> {
  return resolveApprovalRecordForState(params, "resolved");
}

export function respondUnknownOrExpiredApproval(respond: RespondFn): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "unknown or expired approval id", {
      details: APPROVAL_NOT_FOUND_DETAILS,
    }),
  );
}

export function respondPendingApprovalLookupError(params: {
  respond: RespondFn;
  response: PendingApprovalLookupError;
}): void {
  if (params.response === "missing") {
    respondUnknownOrExpiredApproval(params.respond);
    return;
  }
  params.respond(false, undefined, errorShape(params.response.code, params.response.message));
}
