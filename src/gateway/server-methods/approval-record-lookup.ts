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
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "../method-scopes.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import {
  createSessionListEntryFilter,
  resolveSessionSharingTarget,
  type canReceiveSessionEvent,
} from "../session-sharing.js";
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

export function canAccessApprovalSession(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  sessionKey?: string | null;
  agentId?: string | null;
  prepared?: Parameters<typeof canReceiveSessionEvent>[0]["prepared"];
}): boolean {
  if (operatorSessionCap(params.client, params.cfg) !== "none") {
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
  const target = params.prepared
    ? params.prepared.target(sessionKey, agentId)
    : resolveSessionSharingTarget({
        cfg: params.cfg,
        sessionKey,
        ...(agentId ? { agentId } : {}),
      });
  return Boolean(target && visibilityFilter(target.storeKey, target.entry));
}

/** Payloads are kind-specific; every approval kind carries its source session in the same fields. */
export function readApprovalRequestSource<TPayload>(record: ExecApprovalRecord<TPayload>) {
  const source = isRecord(record.request) ? record.request : undefined;
  return {
    sessionKey: normalizeOptionalString(source?.sessionKey),
    agentId: normalizeOptionalString(source?.agentId),
  };
}

export function isApprovalRecordVisibleToClient<TPayload>(params: {
  record: ExecApprovalRecord<TPayload>;
  client: GatewayClient | null;
  cfg?: OpenClawConfig;
  prepared?: Parameters<typeof canAccessApprovalSession>[0]["prepared"];
}): boolean {
  const scopes = Array.isArray(params.client?.connect?.scopes) ? params.client.connect.scopes : [];
  if (scopes.includes(ADMIN_SCOPE)) {
    return true;
  }
  if (
    params.cfg &&
    !canAccessApprovalSession({
      cfg: params.cfg,
      client: params.client,
      ...readApprovalRequestSource(params.record),
      prepared: params.prepared,
    })
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
    request: TPayload;
    createdAtMs: number;
    expiresAtMs: number;
  }>
> {
  const records = await params.manager.listPendingRecords(params.authority);
  params.authority?.assertCurrent();
  const cfg = params.getCfg?.() ?? params.cfg;
  return records
    .filter(
      (record) =>
        !params.client?.invalidated &&
        isApprovalRecordVisibleToClient({
          record,
          client: params.client ?? null,
          ...(cfg ? { cfg } : {}),
        }),
    )
    .map(({ id, request, createdAtMs, expiresAtMs }) => {
      const approval = { id, request, createdAtMs, expiresAtMs };
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
    recordFilter?: (record: ExecApprovalRecord<TPayload>) => boolean;
  },
  expectedState: "pending" | "resolved",
): Promise<ApprovalRecordLookupResult<TPayload>> {
  const visible = (record: ExecApprovalRecord<TPayload>) => {
    const cfg = params.getCfg?.() ?? params.cfg;
    return (
      !params.client?.invalidated &&
      isApprovalRecordVisibleToClient({
        record,
        client: params.client ?? null,
        ...(cfg ? { cfg } : {}),
      }) &&
      (params.recordFilter?.(record) ?? true)
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
  if (!snapshot || isResolved !== (expectedState === "resolved") || !visible(snapshot)) {
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
