// Unified operator approval lookup and first-answer resolution handlers.
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
import {
  canAccessOperatorApproval,
  canResolveOperatorApproval,
  canReviewOperatorApproval,
} from "../operator-approval-authorization.js";
import { projectOperatorApprovalSnapshot } from "../operator-approval-snapshot.js";
import {
  getOperatorApprovalDetailed,
  listTerminalOperatorApprovals,
  OperatorApprovalHistoryCursorError,
  type OperatorApprovalRecord,
  type OperatorApprovalResolver,
} from "../operator-approval-store.js";
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
  getCfg: () => OpenClawConfig;
  allowApprovalRuntime?: boolean;
  allowTransportRef?: boolean;
  execApprovalManager: ExecApprovalManager;
  pluginApprovalManager: ExecApprovalManager<PluginApprovalRequestPayload>;
  systemAgentApprovalManager?: ExecApprovalManager<SystemAgentApprovalRequestPayload>;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): Promise<OperatorApprovalRecord | null> {
  // Reconciliation can settle a live waiter, so authorization must precede
  // every durable read and no unauthorized lookup may reach the bridge.
  const authorized = params.allowApprovalRuntime
    ? canResolveOperatorApproval(params.client)
    : canReviewOperatorApproval(params.client);
  if (!authorized || params.client?.invalidated) {
    return null;
  }
  const liveRecord =
    params.execApprovalManager.getLiveSnapshot(params.id) ??
    params.pluginApprovalManager.getLiveSnapshot(params.id) ??
    params.systemAgentApprovalManager?.getLiveSnapshot(params.id);
  if (
    liveRecord &&
    !canAccessApprovalSession({
      cfg: params.getCfg(),
      client: params.client,
      sessionKey: liveRecord.request.sessionKey,
      agentId: liveRecord.request.agentId,
    })
  ) {
    return null;
  }
  if (
    liveRecord &&
    !canAccessOperatorApproval({
      client: params.client,
      allowApprovalRuntime: params.allowApprovalRuntime,
      binding: { reviewerDeviceIds: liveRecord.approvalReviewerDeviceIds },
    })
  ) {
    return null;
  }
  let lookup: Awaited<ReturnType<typeof getOperatorApprovalDetailed>>;
  try {
    lookup = await getOperatorApprovalDetailed({
      id: params.id,
      allowTransportRef: params.allowTransportRef,
      databaseOptions: params.databaseOptions,
    });
  } catch (error) {
    const corrupt = { outcome: "corrupt", id: params.id } as const;
    await params.execApprovalManager.reconcileDurableLookup(corrupt);
    await params.pluginApprovalManager.reconcileDurableLookup(corrupt);
    await params.systemAgentApprovalManager?.reconcileDurableLookup(corrupt);
    throw error;
  }
  if (
    params.client?.invalidated ||
    !(params.allowApprovalRuntime
      ? canResolveOperatorApproval(params.client)
      : canReviewOperatorApproval(params.client))
  ) {
    return null;
  }
  if (lookup.outcome === "found") {
    if (
      !canAccessApprovalSession({
        cfg: params.getCfg(),
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
    const reconciled = await manager?.reconcileDurableLookup(lookup);
    return reconciled &&
      !params.client?.invalidated &&
      canAccessApprovalSession({
        cfg: params.getCfg(),
        client: params.client,
        sessionKey: reconciled.source.sessionKey,
        agentId: reconciled.source.agentId,
      }) &&
      canAccessOperatorApproval({
        client: params.client,
        allowApprovalRuntime: params.allowApprovalRuntime,
        binding: { reviewerDeviceIds: reconciled.reviewerDeviceIds },
      })
      ? reconciled
      : null;
  }
  const missing = {
    outcome: lookup.outcome === "corrupt" ? "corrupt" : "missing",
    id: lookup.outcome === "corrupt" ? (lookup.id ?? params.id) : params.id,
  } as const;
  await params.execApprovalManager.reconcileDurableLookup(missing);
  await params.pluginApprovalManager.reconcileDurableLookup(missing);
  await params.systemAgentApprovalManager?.reconcileDurableLookup(missing);
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

async function applyApprovalDecision<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  id: string;
  decision: ApprovalDecision | null;
  forceMalformedDeny: boolean;
  resolver: OperatorApprovalResolver;
  localResolvedBy: string | null;
  grantExpiresAtMs?: number;
  assertCurrent: () => void;
}): Promise<ApplyApprovalDecisionResult<TPayload>> {
  const result = params.forceMalformedDeny
    ? await params.manager.forceDenyDetailed(
        params.id,
        "malformed-verdict",
        params.resolver,
        "denied",
        undefined,
        false,
        params.localResolvedBy,
        params.assertCurrent,
      )
    : await params.manager.resolveDetailed(
        params.id,
        params.decision as ExecApprovalDecision,
        params.resolver,
        params.localResolvedBy,
        "operator",
        {
          assertCurrent: params.assertCurrent,
          ...(params.grantExpiresAtMs !== undefined
            ? { grantExpiresAtMs: params.grantExpiresAtMs }
            : {}),
        },
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
      const historyParams = rawParams as ApprovalHistoryParams;
      let history: Awaited<ReturnType<typeof listTerminalOperatorApprovals>>;
      try {
        history = await listTerminalOperatorApprovals({
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
              getCfg: context.getRuntimeConfig,
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
              getCfg: context.getRuntimeConfig,
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
      const assertCurrent = () => {
        const currentCfg = context.getRuntimeConfig();
        const currentCustody = resolveParams?.reviewer
          ? prepareApprovalChannelCustody({
              cfg: currentCfg,
              approvalKind: record.kind,
              reviewer: resolveParams.reviewer,
            })
          : null;
        if (
          client?.invalidated ||
          !canAccessOperatorApproval({
            client,
            allowApprovalRuntime: true,
            binding: { reviewerDeviceIds: record.reviewerDeviceIds },
          }) ||
          !canAccessApprovalSession({
            cfg: currentCfg,
            client,
            sessionKey: record.source.sessionKey,
            agentId: record.source.agentId,
          }) ||
          (resolveParams?.reviewer && (!liveRecord || !currentCustody?.authorizes(liveRecord)))
        ) {
          throw new Error("approval resolver authority is no longer active");
        }
      };
      let resolution:
        | ApplyApprovalDecisionResult<ExecApprovalRequestPayload>
        | ApplyApprovalDecisionResult<PluginApprovalRequestPayload>
        | ApplyApprovalDecisionResult<SystemAgentApprovalRequestPayload>;
      try {
        resolution =
          record.kind === "exec"
            ? await applyApprovalDecision({
                manager: params.execApprovalManager,
                id: record.id,
                decision: requestedDecision,
                forceMalformedDeny,
                resolver,
                localResolvedBy,
                assertCurrent,
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
              ? await applyApprovalDecision({
                  manager: params.pluginApprovalManager,
                  id: record.id,
                  decision: requestedDecision,
                  forceMalformedDeny,
                  resolver,
                  localResolvedBy,
                  assertCurrent,
                })
              : await applyApprovalDecision({
                  manager: params.systemAgentApprovalManager!,
                  id: record.id,
                  decision: requestedDecision,
                  forceMalformedDeny,
                  resolver,
                  localResolvedBy,
                  assertCurrent,
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
