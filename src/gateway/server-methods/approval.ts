// Unified operator approval lookup and first-answer resolution handlers.
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  isWellFormedApprovalId,
  type ApprovalDecision,
  type ApprovalHistoryParams,
  type ApprovalHistoryResult,
  type ApprovalResolveParams,
  type ApprovalSnapshot,
  validateApprovalGetParams,
  validateApprovalHistoryParams,
  validateApprovalResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfigSnapshotMetadata } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import type {
  ExecApprovalDecision,
  ExecApprovalRequestPayload,
} from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { prepareApprovalChannelCustody } from "../approval-channel-custody.js";
import { normalizeControlUiBasePath } from "../control-ui-shared.js";
import type { ExecApprovalManager, ExecApprovalRecord } from "../exec-approval-manager.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import {
  canAccessOperatorApproval,
  canResolveOperatorApproval,
  canReviewOperatorApproval,
} from "../operator-approval-authorization.js";
import { projectOperatorApprovalSnapshot } from "../operator-approval-snapshot.js";
import {
  getOperatorApprovalDetailedAsync,
  listTerminalOperatorApprovalsAsync,
  OperatorApprovalHistoryCursorError,
} from "../operator-approval-store.async.js";
import type {
  OperatorApprovalRecord,
  OperatorApprovalResolver,
} from "../operator-approval-store.js";
import { resolveGatewayOperatorRoleActor } from "../operator-role-policy.js";
import {
  publishAppliedApprovalResolution,
  type ExecApprovalIosPushDelivery,
  type PluginApprovalIosPushDelivery,
} from "./approval-publication.js";
import { canAccessApprovalSession } from "./approval-record-lookup.js";
import { respondApprovalStorageUnavailable } from "./approval-shared.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";

type CreateApprovalHandlersParams = {
  execApprovalManager: ExecApprovalManager;
  pluginApprovalManager: ExecApprovalManager<PluginApprovalRequestPayload>;
  systemAgentApprovalManager?: ExecApprovalManager<SystemAgentApprovalRequestPayload>;
  forwarder?: ExecApprovalForwarder;
  iosPushDelivery?: ExecApprovalIosPushDelivery;
  pluginIosPushDelivery?: PluginApprovalIosPushDelivery;
  databaseOptions?: OpenClawStateDatabaseOptions;
};

function buildApprovalSnapshot(
  record: OperatorApprovalRecord,
  controlUiBasePath: string,
): ApprovalSnapshot | null {
  const snapshot = projectOperatorApprovalSnapshot(record, controlUiBasePath);
  if (!snapshot || snapshot.status === "pending") {
    return snapshot;
  }
  // Terminal attribution belongs to RPC readers; session events omit it.
  return {
    ...snapshot,
    source: {
      ...(record.source.agentId ? { agentId: record.source.agentId } : {}),
      ...(record.source.sessionKey ? { sessionKey: record.source.sessionKey } : {}),
    },
    ...(record.resolver
      ? {
          resolver: {
            kind: record.resolver.kind,
            ...(record.resolver.id ? { id: record.resolver.id } : {}),
          },
        }
      : {}),
  };
}

function resolveApprovalResolver(client: GatewayClient | null): OperatorApprovalResolver {
  const deviceId = normalizeOptionalString(client?.connect?.device?.id);
  if (deviceId) {
    return { kind: "device", id: deviceId };
  }
  const clientId = normalizeOptionalString(client?.connect?.client?.id);
  return { kind: "runtime", id: clientId ?? null };
}

function resolveLegacyApprovalLabel(client: GatewayClient | null): string | null {
  return (
    normalizeOptionalString(client?.connect?.client?.displayName) ??
    normalizeOptionalString(client?.connect?.client?.id) ??
    null
  );
}

function respondApprovalNotFound(respond: RespondFn): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "approval not found", {
      details: { reason: ErrorCodes.APPROVAL_NOT_FOUND },
    }),
  );
}

function readExactApprovalId(params: unknown): string | null {
  if (!isRecord(params) || typeof params.id !== "string") {
    return null;
  }
  const id = params.id;
  return isWellFormedApprovalId(id) ? id : null;
}

async function loadVisibleApproval(params: {
  id: string;
  client: GatewayClient | null;
  getConfig: () => OpenClawConfig;
  allowApprovalRuntime?: boolean;
  allowTransportRef?: boolean;
  execApprovalManager: ExecApprovalManager;
  pluginApprovalManager: ExecApprovalManager<PluginApprovalRequestPayload>;
  systemAgentApprovalManager?: ExecApprovalManager<SystemAgentApprovalRequestPayload>;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): Promise<OperatorApprovalRecord | null> {
  // Reconciliation can settle a live waiter, so authorization must precede
  // every durable read and no unauthorized lookup may reach the bridge.
  const isAuthorized = () =>
    !params.client?.invalidated &&
    (params.allowApprovalRuntime
      ? canResolveOperatorApproval(params.client)
      : canReviewOperatorApproval(params.client));
  if (!isAuthorized()) {
    return null;
  }
  const readLiveRecord = () =>
    params.execApprovalManager.getLiveSnapshot(params.id) ??
    params.pluginApprovalManager.getLiveSnapshot(params.id) ??
    params.systemAgentApprovalManager?.getLiveSnapshot(params.id);
  const canAccessLiveRecord = () => {
    const liveRecord = readLiveRecord();
    return (
      !liveRecord ||
      (canAccessApprovalSession({
        cfg: params.getConfig(),
        client: params.client,
        sessionKey: liveRecord.request.sessionKey,
        agentId: liveRecord.request.agentId,
      }) &&
        canAccessOperatorApproval({
          client: params.client,
          allowApprovalRuntime: params.allowApprovalRuntime,
          binding: { reviewerDeviceIds: liveRecord.approvalReviewerDeviceIds },
        }))
    );
  };
  if (!canAccessLiveRecord()) {
    return null;
  }
  const cfg = params.getConfig();
  const configMetadata = getRuntimeConfigSnapshotMetadata();
  const accessRevision = readGatewayAccessRevision();
  const profileId = params.client?.authenticatedUserProfile?.profileId;
  const userId = params.client?.authenticatedUserId;
  const actor = resolveGatewayOperatorRoleActor(params.client);
  const actorKind = actor?.kind;
  const actorProfileId = actor?.kind === "operator" ? actor.profileId : undefined;
  const admittedRecord = readLiveRecord();
  const admittedManager = admittedRecord
    ? [
        params.execApprovalManager,
        params.pluginApprovalManager,
        params.systemAgentApprovalManager,
      ].find((manager) => manager?.getLiveSnapshot(params.id) === admittedRecord)
    : undefined;
  const sourceSessionKey = admittedRecord?.request.sessionKey;
  const sourceAgentId = admittedRecord?.request.agentId;
  // Access owners invalidate prepared authorization; admission cannot query their
  // stores while the SQLite worker holds the shared-state write transaction.
  const isLookupCurrent = () => {
    const currentActor = resolveGatewayOperatorRoleActor(params.client);
    return (
      isAuthorized() &&
      readGatewayAccessRevision() === accessRevision &&
      getRuntimeConfigSnapshotMetadata() === configMetadata &&
      params.getConfig() === cfg &&
      params.client?.authenticatedUserProfile?.profileId === profileId &&
      params.client?.authenticatedUserId === userId &&
      currentActor?.kind === actorKind &&
      (currentActor?.kind === "operator" ? currentActor.profileId : undefined) === actorProfileId &&
      (!admittedRecord ||
        (admittedManager?.hasRegisteredRecord(admittedRecord) === true &&
          admittedRecord.request.sessionKey === sourceSessionKey &&
          admittedRecord.request.agentId === sourceAgentId &&
          canAccessOperatorApproval({
            client: params.client,
            allowApprovalRuntime: params.allowApprovalRuntime,
            binding: { reviewerDeviceIds: admittedRecord.approvalReviewerDeviceIds },
          })))
    );
  };
  let lookup: Awaited<ReturnType<typeof getOperatorApprovalDetailedAsync>>;
  try {
    lookup = await getOperatorApprovalDetailedAsync({
      id: params.id,
      allowTransportRef: params.allowTransportRef,
      assertCurrent: () => {
        if (!isLookupCurrent()) {
          throw new Error("Approval lookup authority is no longer active");
        }
      },
      databaseOptions: params.databaseOptions,
    });
  } catch (error) {
    if (!isLookupCurrent() || !canAccessLiveRecord()) {
      return null;
    }
    if (
      collectNestedErrorCandidates(error).some((cause) => {
        const code = extractErrorCode(cause);
        return (
          code === "closed" ||
          code === "overloaded" ||
          code === "unavailable" ||
          code === "outcome-unknown"
        );
      })
    ) {
      throw error;
    }
    const corrupt = { outcome: "corrupt", id: params.id } as const;
    params.execApprovalManager.reconcileDurableLookup(corrupt);
    params.pluginApprovalManager.reconcileDurableLookup(corrupt);
    params.systemAgentApprovalManager?.reconcileDurableLookup(corrupt);
    throw error;
  }
  if (!isLookupCurrent() || !canAccessLiveRecord()) {
    return null;
  }
  if (lookup.outcome === "found") {
    if (
      !canAccessApprovalSession({
        cfg: params.getConfig(),
        client: params.client,
        sessionKey: lookup.record.source.sessionKey,
        agentId: lookup.record.source.agentId,
      })
    ) {
      return null;
    }
    if (
      !canAccessOperatorApproval({
        client: params.client,
        allowApprovalRuntime: params.allowApprovalRuntime,
        binding: { reviewerDeviceIds: lookup.record.reviewerDeviceIds },
      })
    ) {
      return null;
    }
    const manager =
      lookup.record.kind === "exec"
        ? params.execApprovalManager
        : lookup.record.kind === "plugin"
          ? params.pluginApprovalManager
          : params.systemAgentApprovalManager;
    // Durable truth can advance outside this manager. Settle only an existing
    // same-kind waiter; reconcileDurableLookup never recreates executable state.
    return manager?.reconcileDurableLookup(lookup) ?? null;
  }
  const missing = {
    outcome: lookup.outcome === "corrupt" ? "corrupt" : "missing",
    id: lookup.outcome === "corrupt" ? (lookup.id ?? params.id) : params.id,
  } as const;
  params.execApprovalManager.reconcileDurableLookup(missing);
  params.pluginApprovalManager.reconcileDurableLookup(missing);
  params.systemAgentApprovalManager?.reconcileDurableLookup(missing);
  return null;
}

type ApplyApprovalDecisionResult<TPayload> =
  | {
      ok: true;
      applied: boolean;
      record: OperatorApprovalRecord;
      liveRecord?: ExecApprovalRecord<TPayload>;
    }
  | { ok: false };

function resolveLiveRecord<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  id: string;
  liveRecord?: ExecApprovalRecord<TPayload>;
}): ExecApprovalRecord<TPayload> | undefined {
  return params.liveRecord ?? params.manager.getLiveSnapshot(params.id) ?? undefined;
}

function applyApprovalDecision<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  id: string;
  decision: ApprovalDecision | null;
  forceMalformedDeny: boolean;
  resolver: OperatorApprovalResolver;
  localResolvedBy: string | null;
  grantExpiresAtMs?: number;
}): ApplyApprovalDecisionResult<TPayload> {
  const result = params.forceMalformedDeny
    ? params.manager.forceDenyDetailed(
        params.id,
        "malformed-verdict",
        params.resolver,
        "denied",
        undefined,
        false,
        params.localResolvedBy,
      )
    : params.manager.resolveDetailed(
        params.id,
        params.decision as ExecApprovalDecision,
        params.resolver,
        params.localResolvedBy,
        "operator",
        params.grantExpiresAtMs !== undefined ? { grantExpiresAtMs: params.grantExpiresAtMs } : {},
      );
  if (result.outcome === "decision-not-allowed") {
    return applyApprovalDecision({ ...params, forceMalformedDeny: true });
  }
  if (result.outcome === "not-found" || result.outcome === "corrupt") {
    return { ok: false };
  }
  const applied = result.outcome === "resolved" || result.outcome === "denied";
  return {
    ok: true,
    applied,
    record: result.record,
    liveRecord: applied
      ? resolveLiveRecord({ manager: params.manager, id: params.id, liveRecord: result.liveRecord })
      : result.liveRecord,
  };
}

/** Creates kind-agnostic approval lookup and resolution handlers. */
export function createApprovalHandlers(
  params: CreateApprovalHandlersParams,
): GatewayRequestHandlers {
  return {
    "approval.history": async ({ params: rawParams, respond, client, context }) => {
      if (!validateApprovalHistoryParams(rawParams)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid approval.history params"),
        );
        return;
      }
      const canReadHistory = () =>
        !client?.invalidated &&
        authorizeOperatorScopesForMethod("approval.history", client?.connect.scopes ?? []).allowed;
      if (!canReadHistory()) {
        respondApprovalNotFound(respond);
        return;
      }
      const historyParams = rawParams as ApprovalHistoryParams;
      let history: Awaited<ReturnType<typeof listTerminalOperatorApprovalsAsync>>;
      try {
        history = await listTerminalOperatorApprovalsAsync({
          cursor: historyParams.cursor,
          limit: historyParams.limit,
          kind: historyParams.kind,
          databaseOptions: params.databaseOptions,
        });
      } catch (error) {
        if (error instanceof OperatorApprovalHistoryCursorError) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "invalid approval.history cursor"),
          );
          return;
        }
        respondApprovalStorageUnavailable({ context, respond, operation: "history", error });
        return;
      }
      if (!canReadHistory()) {
        respondApprovalNotFound(respond);
        return;
      }
      const cfg = context.getRuntimeConfig();
      const controlUiBasePath = normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath);
      const items = history.records.flatMap((record) => {
        if (
          !canAccessApprovalSession({
            cfg,
            client,
            sessionKey: record.source.sessionKey,
            agentId: record.source.agentId,
          })
        ) {
          return [];
        }
        const snapshot = buildApprovalSnapshot(record, controlUiBasePath);
        return snapshot && snapshot.status !== "pending" ? [snapshot] : [];
      });
      const result: ApprovalHistoryResult = {
        items,
        ...(history.nextCursor ? { nextCursor: history.nextCursor } : {}),
      };
      respond(true, result, undefined);
    },

    "approval.get": async ({ params: rawParams, respond, client, context }) => {
      if (!validateApprovalGetParams(rawParams)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid approval.get params"),
        );
        return;
      }
      const id = readExactApprovalId(rawParams);
      let record: OperatorApprovalRecord | null;
      try {
        record = id
          ? await loadVisibleApproval({
              id,
              client,
              getConfig: () => context.getRuntimeConfig(),
              execApprovalManager: params.execApprovalManager,
              pluginApprovalManager: params.pluginApprovalManager,
              systemAgentApprovalManager: params.systemAgentApprovalManager,
              databaseOptions: params.databaseOptions,
            })
          : null;
      } catch (error) {
        respondApprovalStorageUnavailable({ context, respond, operation: "lookup", error });
        return;
      }
      const controlUiBasePath = normalizeControlUiBasePath(
        context.getRuntimeConfig()?.gateway?.controlUi?.basePath,
      );
      const approval = record ? buildApprovalSnapshot(record, controlUiBasePath) : null;
      if (!approval) {
        respondApprovalNotFound(respond);
        return;
      }
      respond(true, { approval }, undefined);
    },

    "approval.resolve": async ({ params: rawParams, respond, client, context }) => {
      const validParams = validateApprovalResolveParams(rawParams);
      const resolveParams = validParams ? (rawParams as ApprovalResolveParams) : null;
      const hasReviewer = isRecord(rawParams) && "reviewer" in rawParams;
      if (hasReviewer && !resolveParams?.reviewer) {
        respondApprovalNotFound(respond);
        return;
      }
      const id = readExactApprovalId(rawParams);
      let record: OperatorApprovalRecord | null;
      try {
        record = id
          ? await loadVisibleApproval({
              id,
              client,
              getConfig: () => context.getRuntimeConfig(),
              allowApprovalRuntime: true,
              allowTransportRef: true,
              execApprovalManager: params.execApprovalManager,
              pluginApprovalManager: params.pluginApprovalManager,
              systemAgentApprovalManager: params.systemAgentApprovalManager,
              databaseOptions: params.databaseOptions,
            })
          : null;
      } catch (error) {
        respondApprovalStorageUnavailable({ context, respond, operation: "lookup", error });
        return;
      }
      if (!id || !record) {
        respondApprovalNotFound(respond);
        return;
      }
      const custody = resolveParams?.reviewer
        ? prepareApprovalChannelCustody({
            cfg: context.getRuntimeConfig(),
            approvalKind: record.kind,
            reviewer: resolveParams.reviewer,
          })
        : null;
      const liveRecord =
        record.kind === "exec"
          ? params.execApprovalManager.getLiveSnapshot(record.id)
          : record.kind === "plugin"
            ? params.pluginApprovalManager.getLiveSnapshot(record.id)
            : params.systemAgentApprovalManager?.getLiveSnapshot(record.id);
      if (resolveParams?.reviewer && (!custody || !liveRecord || !custody.authorizes(liveRecord))) {
        respondApprovalNotFound(respond);
        return;
      }
      if (record.status !== "pending") {
        // Durable terminal state outlives the process-local waiter. Every later
        // surface receives the same winner without re-opening execution rights.
        const controlUiBasePath = normalizeControlUiBasePath(
          context.getRuntimeConfig()?.gateway?.controlUi?.basePath,
        );
        const approval = buildApprovalSnapshot(record, controlUiBasePath);
        if (!approval || approval.status === "pending") {
          respondApprovalNotFound(respond);
          return;
        }
        respond(true, { applied: false, approval }, undefined);
        return;
      }
      const resolver = custody
        ? ({ kind: "channel", id: custody.resolverId } as const)
        : resolveApprovalResolver(client);
      const localResolvedBy = resolveLegacyApprovalLabel(client);
      const requestedDecision = resolveParams?.decision ?? null;
      const decisionAllowed =
        requestedDecision === "deny" ||
        (requestedDecision !== null &&
          (record.presentation.allowedDecisions as readonly ApprovalDecision[]).includes(
            requestedDecision,
          ));
      const kindMatches = resolveParams?.kind === record.presentation.kind;
      const forceMalformedDeny = !validParams || !kindMatches || !decisionAllowed;
      let resolution:
        | ApplyApprovalDecisionResult<ExecApprovalRequestPayload>
        | ApplyApprovalDecisionResult<PluginApprovalRequestPayload>
        | ApplyApprovalDecisionResult<SystemAgentApprovalRequestPayload>;
      try {
        resolution =
          record.kind === "exec"
            ? applyApprovalDecision({
                manager: params.execApprovalManager,
                id: record.id,
                decision: requestedDecision,
                forceMalformedDeny,
                resolver,
                localResolvedBy,
                // Grant terms freeze at resolve; an explicit per-resolve
                // override (custom operator UIs, CLI) beats the config default.
                ...(requestedDecision === "allow-always" &&
                typeof resolveParams?.grantExpiresInDays === "number"
                  ? {
                      grantExpiresAtMs:
                        Date.now() + Math.floor(resolveParams.grantExpiresInDays) * 86_400_000,
                    }
                  : {}),
              })
            : record.kind === "plugin"
              ? applyApprovalDecision({
                  manager: params.pluginApprovalManager,
                  id: record.id,
                  decision: requestedDecision,
                  forceMalformedDeny,
                  resolver,
                  localResolvedBy,
                })
              : applyApprovalDecision({
                  manager: params.systemAgentApprovalManager!,
                  id: record.id,
                  decision: requestedDecision,
                  forceMalformedDeny,
                  resolver,
                  localResolvedBy,
                });
      } catch (error) {
        respondApprovalStorageUnavailable({ context, respond, operation: "resolve", error });
        return;
      }
      if (!resolution.ok) {
        respondApprovalNotFound(respond);
        return;
      }
      const terminalRecord = resolution.record;
      if (terminalRecord.status === "pending") {
        respondApprovalNotFound(respond);
        return;
      }
      const controlUiBasePath = normalizeControlUiBasePath(
        context.getRuntimeConfig()?.gateway?.controlUi?.basePath,
      );
      const approval = buildApprovalSnapshot(terminalRecord, controlUiBasePath);
      if (!approval) {
        respondApprovalNotFound(respond);
        return;
      }
      respond(true, { applied: resolution.applied, approval }, undefined);
      if (resolution.applied && resolution.liveRecord) {
        // SQLite CAS is canonical. Never make the winning surface wait for
        // best-effort channel, push, or legacy-event reconciliation.
        void publishAppliedApprovalResolution({
          record: terminalRecord,
          liveRecord: resolution.liveRecord,
          context,
          forwarder: params.forwarder,
          iosPushDelivery: params.iosPushDelivery,
          pluginIosPushDelivery: params.pluginIosPushDelivery,
        }).catch((error: unknown) => {
          context.logGateway?.error?.(
            `${terminalRecord.kind} approvals: unified resolve publication failed: ${String(error)}`,
          );
        });
      }
    },
  };
}
