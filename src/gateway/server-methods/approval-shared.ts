// Approval shared helpers normalize pending exec/plugin approval lookups,
// decision payloads, turn-source routing, and gateway error responses.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type {
  ApprovalChannelReviewer,
  ValidationError,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasApprovalTurnSourceRoute } from "../../infra/approval-turn-source.js";
import type { ChannelApprovalKind } from "../../infra/approval-types.js";
import type {
  ExecApprovalDecision,
  ExecApprovalRequestPayload,
} from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { prepareApprovalChannelCustody } from "../approval-channel-custody.js";
import type { ExecApprovalManager, ExecApprovalRecord } from "../exec-approval-manager.js";
import type { OperatorApprovalStoreGuard } from "../operator-approval-store.types.js";
import {
  type ApprovalRecordLookupResult,
  isApprovalRecordVisibleToClient,
  normalizeApprovalIdentities,
  resolvePendingApprovalRecord,
  resolveResolvedApprovalRecord,
  respondPendingApprovalLookupError,
  respondUnknownOrExpiredApproval,
} from "./approval-record-lookup.js";
import type { ApprovalRequestAuthority } from "./approval-request-authority.js";
import { buildWaitResponse, type WaitReasonResolver } from "./approval-wait-response.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

export {
  isApprovalRecordVisibleToClient,
  listVisiblePendingApprovalRequests,
  resolvePendingApprovalRecord,
  respondPendingApprovalLookupError,
} from "./approval-record-lookup.js";

const APPROVAL_ALREADY_RESOLVED_DETAILS = {
  reason: "APPROVAL_ALREADY_RESOLVED",
} as const;

function resolveRecordedApprovalDecision<TPayload>(
  record: ExecApprovalRecord<TPayload>,
): ExecApprovalDecision | undefined {
  return record.decision ?? record.consumedDecision;
}

type ApprovalTurnSourceFields = {
  turnSourceChannel?: string | null;
  turnSourceAccountId?: string | null;
};

type RequestedApprovalEvent<
  TPayload extends ApprovalTurnSourceFields,
  TKind extends ChannelApprovalKind = ChannelApprovalKind,
> = {
  approvalKind?: TKind;
  id: string;
  request: TPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

type ResolvedApprovalEvent<TPayload> = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy: string | null;
  ts: number;
  request: TPayload;
};

type ApprovalRequestDeliveryRoute = "approval-client" | "forwarder" | "turn-source" | "none";

type ApprovalResolveParams = {
  id: string;
  decision: string;
  reviewer?: ApprovalChannelReviewer;
};

type ApprovalResolveParamsValidator<TParams extends ApprovalResolveParams> = ((
  params: unknown,
) => params is TParams) & {
  errors?: ValidationError[] | null;
};

function isApprovalDecision(value: string): value is ExecApprovalDecision {
  return value === "allow-once" || value === "allow-always" || value === "deny";
}

/** Binds the current gateway client identity onto a newly-created approval record. */
export function bindApprovalRequesterMetadata<TPayload>(params: {
  record: ExecApprovalRecord<TPayload>;
  client?: GatewayClient | null;
}): void {
  params.record.requestedByConnId = params.client?.connId ?? null;
  params.record.requestedByDeviceId = params.client?.connect?.device?.id ?? null;
  params.record.requestedByClientId = params.client?.connect?.client?.id ?? null;
  params.record.requestedByDeviceTokenAuth = params.client?.isDeviceTokenAuth === true;
}

export function bindApprovalReviewerDeviceIds<TPayload>(params: {
  record: ExecApprovalRecord<TPayload>;
  deviceIds?: readonly string[] | null;
}): void {
  const deviceIds = normalizeApprovalIdentities(params.deviceIds);
  if (deviceIds.length > 0) {
    params.record.approvalReviewerDeviceIds = deviceIds;
  }
}

export function respondApprovalStorageUnavailable(params: {
  context: GatewayRequestContext;
  respond: RespondFn;
  operation: "request" | "resolve" | "history" | "lookup";
  error: unknown;
}): void {
  params.context.logGateway?.error?.(
    `approval ${params.operation} storage failure: ${String(params.error)}`,
  );
  params.respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, `approval ${params.operation} unavailable`),
  );
}

/** Registers an approval record and converts manager registration errors to gateway errors. */
export async function registerPendingApprovalRecord<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  record: ExecApprovalRecord<TPayload>;
  timeoutMs: number;
  respond: RespondFn;
  context: GatewayRequestContext;
}): Promise<{ decision: Promise<ExecApprovalDecision | null> } | undefined> {
  try {
    return await params.manager.register(params.record, params.timeoutMs);
  } catch (err) {
    respondApprovalStorageUnavailable({ ...params, operation: "request", error: err });
    return undefined;
  }
}

/** Builds the gateway event payload broadcast when an approval starts waiting. */
export function buildRequestedApprovalEvent<
  TPayload extends ApprovalTurnSourceFields,
  TKind extends ChannelApprovalKind,
>(
  record: ExecApprovalRecord<TPayload>,
  approvalKind?: TKind,
): RequestedApprovalEvent<TPayload, TKind> {
  return {
    ...(approvalKind ? { approvalKind } : {}),
    id: record.id,
    request: record.request,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
  };
}

/** Validates approval resolve params and narrows the decision to the supported enum. */
export function resolveApprovalDecisionParams<TParams extends ApprovalResolveParams>(params: {
  rawParams: unknown;
  validate: ApprovalResolveParamsValidator<TParams>;
  methodName: string;
  respond: RespondFn;
}): {
  inputId: string;
  decision: ExecApprovalDecision;
  reviewer?: ApprovalChannelReviewer;
} | null {
  const rawParams = params.rawParams;
  if (!assertValidParams(rawParams, params.validate, params.methodName, params.respond)) {
    return null;
  }
  if (!isApprovalDecision(rawParams.decision)) {
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid decision"));
    return null;
  }
  return {
    inputId: rawParams.id,
    decision: rawParams.decision,
    ...(rawParams.reviewer ? { reviewer: rawParams.reviewer } : {}),
  };
}

/** Resolves the approval clients that should receive request or resolution events. */
function resolveApprovalRequestRecipientConnIds<TPayload>(params: {
  approvalKind: "exec" | "plugin" | "system-agent";
  context: GatewayRequestContext;
  record: ExecApprovalRecord<TPayload>;
  excludeConnId?: string;
}): ReadonlySet<string> | null {
  return (
    params.context.getApprovalClientConnIds?.({
      approvalKind: params.approvalKind,
      excludeConnId: params.excludeConnId,
      record: params.record,
      filter: (client) =>
        isApprovalRecordVisibleToClient({
          record: params.record,
          client,
        }),
    }) ?? null
  );
}

/** Sends a resolved approval only to clients authorized for its live binding. */
export function broadcastApprovalResolvedEvent<TPayload>(params: {
  approvalKind: "exec" | "plugin" | "system-agent";
  context: GatewayRequestContext;
  record: ExecApprovalRecord<TPayload>;
  event: ResolvedApprovalEvent<TPayload>;
}): void {
  const eventName =
    params.approvalKind === "system-agent"
      ? "openclaw.approval.resolved"
      : `${params.approvalKind}.approval.resolved`;
  const recipientConnIds = resolveApprovalRequestRecipientConnIds({
    approvalKind: params.approvalKind,
    context: params.context,
    record: params.record,
  });
  if (recipientConnIds) {
    params.context.broadcastToConnIds(eventName, params.event, recipientConnIds, {
      dropIfSlow: true,
    });
    return;
  }
  params.context.broadcast(eventName, params.event, { dropIfSlow: true });
}

export async function handleApprovalWaitDecision<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  authority?: ApprovalRequestAuthority;
  inputId: unknown;
  client?: GatewayClient | null;
  cfg?: OpenClawConfig;
  getCfg?: () => OpenClawConfig;
  respond: RespondFn;
  resolveTerminalReason?: WaitReasonResolver<TPayload>;
}): Promise<void> {
  const id = normalizeOptionalString(params.inputId) ?? "";
  if (!id) {
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
    return;
  }
  const snapshot = await params.manager.getSnapshot(id, params.authority);
  params.authority?.assertCurrent();
  const visible = (record: ExecApprovalRecord<TPayload>) => {
    const cfg = params.getCfg?.() ?? params.cfg;
    return (
      !params.client?.invalidated &&
      isApprovalRecordVisibleToClient({
        record,
        client: params.client ?? null,
        ...(cfg ? { cfg } : {}),
      })
    );
  };
  if (!snapshot || !visible(snapshot)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "approval expired or not found"),
    );
    return;
  }
  const decisionPromise = params.manager.awaitDecision(id);
  if (!decisionPromise) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "approval expired or not found"),
    );
    return;
  }
  const recordedDecision = await decisionPromise;
  params.authority?.assertCurrent();
  const terminalSnapshot = (await params.manager.getSnapshot(id, params.authority)) ?? snapshot;
  params.authority?.assertCurrent();
  if (!visible(terminalSnapshot)) {
    respondUnknownOrExpiredApproval(params.respond);
    return;
  }
  const decision = params.manager.projectDecisionIfActive(id, recordedDecision);
  const terminalReason = params.resolveTerminalReason?.(terminalSnapshot);
  params.respond(
    true,
    buildWaitResponse(id, decision, terminalSnapshot, terminalReason),
    undefined,
  );
}

/** Broadcasts or routes a pending approval request, then responds after acceptance/decision. */
export async function handlePendingApprovalRequest<
  TPayload extends ApprovalTurnSourceFields,
>(params: {
  manager: ExecApprovalManager<TPayload>;
  record: ExecApprovalRecord<TPayload>;
  respond: RespondFn;
  context: GatewayRequestContext;
  clientConnId?: string;
  requestEventName: string;
  requestEvent: RequestedApprovalEvent<TPayload>;
  twoPhase: boolean;
  approvalKind?: ChannelApprovalKind;
  deliverRequest: () => boolean | Promise<boolean>;
  afterDecision?: (
    decision: ExecApprovalDecision | null,
    requestEvent: RequestedApprovalEvent<TPayload>,
  ) => Promise<void> | void;
  afterDecisionErrorLabel?: string;
  keepPendingWithoutRoute?: boolean;
  requireDeliveryRoute?: boolean;
  suppressDelivery?: boolean;
  deliverToApprovalClientsOnly?: boolean;
}): Promise<void> {
  const deliveryReady = createDeferredCore<boolean>();
  let noRouteWon = false;
  const handoff = params.manager.registerDecisionHandoff(params.record.id, async (decision) => {
    if (!(await deliveryReady.promise)) {
      return;
    }
    let projectedDecision = params.manager.projectDecisionIfActive(params.record.id, decision);
    if (!noRouteWon && params.afterDecision) {
      try {
        await params.afterDecision(projectedDecision, params.requestEvent);
      } catch (err) {
        params.context.logGateway?.error?.(
          `${params.afterDecisionErrorLabel ?? "approval follow-up failed"}: ${String(err)}`,
        );
      }
    }
    projectedDecision = params.manager.projectDecisionIfActive(params.record.id, projectedDecision);
    params.respond(
      true,
      {
        id: params.record.id,
        decision: projectedDecision,
        createdAtMs: params.record.createdAtMs,
        expiresAtMs: params.record.expiresAtMs,
      },
      undefined,
    );
  });
  // Observation can close while delivery is preparing; the registered genuine
  // handoff remains manager-owned and is joined independently of this observer.
  void handoff.observation.catch(() => {});
  try {
    const suppressDelivery = params.suppressDelivery === true;
    // Cron/automation cards go only to connected approval surfaces (Control
    // UI, TUI): chat runtimes and turn-source routes would recreate the
    // per-occurrence spam #128031 removed, while an approval client can end
    // the recurrence with one allow-always (standing grant).
    const approvalClientsOnly = !suppressDelivery && params.deliverToApprovalClientsOnly === true;
    const approvalClientConnIds = suppressDelivery
      ? null
      : resolveApprovalRequestRecipientConnIds({
          approvalKind: params.approvalKind ?? "exec",
          context: params.context,
          record: params.record,
          excludeConnId: params.clientConnId,
        });
    if (!suppressDelivery) {
      if (approvalClientConnIds) {
        params.context.broadcastToConnIds(
          params.requestEventName,
          params.requestEvent,
          approvalClientConnIds,
          {
            dropIfSlow: true,
          },
        );
      } else {
        params.context.broadcast(params.requestEventName, params.requestEvent, {
          dropIfSlow: true,
        });
      }
    }
    const internalApprovalSubscriberCount =
      suppressDelivery || approvalClientsOnly
        ? 0
        : (params.context.approvalEvents?.publishRequested(
            params.approvalKind ?? "exec",
            params.requestEvent,
          ) ?? 0);

    const hasApprovalClients = suppressDelivery
      ? false
      : approvalClientConnIds !== null
        ? approvalClientConnIds.size > 0 || internalApprovalSubscriberCount > 0
        : (params.context.hasExecApprovalClients?.(params.clientConnId) ?? false) ||
          internalApprovalSubscriberCount > 0;
    const delivered =
      suppressDelivery || approvalClientsOnly
        ? false
        : await params.manager.trackActiveWork(params.deliverRequest);
    // A turn-source route can approve without an active approval client, so keep
    // the record alive when the originating channel/account can still receive it.
    const hasTurnSourceRoute =
      !suppressDelivery &&
      !approvalClientsOnly &&
      !hasApprovalClients &&
      !delivered &&
      hasApprovalTurnSourceRoute({
        turnSourceChannel: params.record.request.turnSourceChannel,
        turnSourceAccountId: params.record.request.turnSourceAccountId,
        approvalKind: params.approvalKind ?? "exec",
      });
    const deliveryRoute: ApprovalRequestDeliveryRoute = delivered
      ? "forwarder"
      : hasApprovalClients
        ? "approval-client"
        : hasTurnSourceRoute
          ? "turn-source"
          : "none";

    if (
      params.requireDeliveryRoute !== false &&
      !params.keepPendingWithoutRoute &&
      !hasApprovalClients &&
      !hasTurnSourceRoute &&
      !delivered
    ) {
      try {
        noRouteWon = await params.manager.expire(params.record.id, "no-approval-route");
      } catch (err) {
        deliveryReady.resolve(false);
        handoff.abandon();
        respondApprovalStorageUnavailable({ ...params, operation: "request", error: err });
        return;
      }
    } else if (params.twoPhase) {
      params.respond(
        true,
        {
          status: "accepted",
          id: params.record.id,
          // Agent-side timeouts use this to distinguish delivered prompts from
          // requests kept pending only because manual /approve routing may work.
          deliveryRoute,
          createdAtMs: params.record.createdAtMs,
          expiresAtMs: params.record.expiresAtMs,
        },
        undefined,
      );
    }
  } catch (error) {
    deliveryReady.resolve(false);
    handoff.abandon();
    throw error;
  }
  deliveryReady.resolve(true);
  await handoff.observation;
}

function respondRepeatedApprovalResolution<TPayload>(
  record: ExecApprovalRecord<TPayload>,
  decision: ExecApprovalDecision,
  respond: RespondFn,
): void {
  // Identical retries are idempotent; a conflicting retry must never replace
  // or obscure the first durable operator decision.
  if (resolveRecordedApprovalDecision(record) === decision) {
    respond(true, { ok: true }, undefined);
    return;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "approval already resolved", {
      details: APPROVAL_ALREADY_RESOLVED_DETAILS,
    }),
  );
}

/** Resolves a pending approval and broadcasts the final decision exactly once. */
export async function handleApprovalResolve<
  TPayload extends ExecApprovalRequestPayload | PluginApprovalRequestPayload,
>(params: {
  approvalKind: ChannelApprovalKind;
  authority: ApprovalRequestAuthority;
  manager: ExecApprovalManager<TPayload>;
  inputId: string;
  decision: ExecApprovalDecision;
  respond: RespondFn;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  reviewer?: ApprovalChannelReviewer;
  exposeAmbiguousPrefixError?: boolean;
  validateDecision?: (snapshot: ExecApprovalRecord<TPayload>) =>
    | {
        message: string;
        details?: Record<string, unknown>;
      }
    | null
    | undefined;
  resolveRecord?: (params: {
    approvalId: string;
    decision: ExecApprovalDecision;
    resolvedBy: string | null;
    snapshot: ExecApprovalRecord<TPayload>;
    resolver?: { kind: "channel"; id: string };
    guard: OperatorApprovalStoreGuard;
  }) => Promise<boolean>;
  forwardResolved?: (event: ResolvedApprovalEvent<TPayload>) => Promise<void> | void;
  forwardResolvedErrorLabel?: string;
  extraResolvedHandlers?: Array<{
    run: (event: ResolvedApprovalEvent<TPayload>) => Promise<void> | void;
    errorLabel: string;
  }>;
}): Promise<void> {
  if (!params.authority.isCurrent()) {
    respondUnknownOrExpiredApproval(params.respond);
    return;
  }
  const respondFailure = (error: unknown) => {
    if (!params.authority.isCurrent()) {
      respondUnknownOrExpiredApproval(params.respond);
    } else {
      respondApprovalStorageUnavailable({ ...params, operation: "resolve", error });
    }
  };
  const custody = params.reviewer
    ? prepareApprovalChannelCustody({
        cfg: params.context.getRuntimeConfig(),
        approvalKind: params.approvalKind,
        reviewer: params.reviewer,
      })
    : null;
  if (params.reviewer && !custody) {
    respondUnknownOrExpiredApproval(params.respond);
    return;
  }
  const recordFilter = custody
    ? (record: ExecApprovalRecord<TPayload>) => custody.authorizes(record)
    : undefined;
  let resolved: ApprovalRecordLookupResult<TPayload>;
  try {
    resolved = await resolvePendingApprovalRecord({
      manager: params.manager,
      authority: params.authority,
      getCfg: params.context.getRuntimeConfig,
      inputId: params.inputId,
      client: params.client,
      exposeAmbiguousPrefixError: params.exposeAmbiguousPrefixError,
      recordFilter,
    });
  } catch (err) {
    respondFailure(err);
    return;
  }
  if (!params.authority.isCurrent()) {
    respondUnknownOrExpiredApproval(params.respond);
    return;
  }
  if (!resolved.ok) {
    let resolvedRepeat: ApprovalRecordLookupResult<TPayload>;
    try {
      resolvedRepeat = await resolveResolvedApprovalRecord({
        manager: params.manager,
        authority: params.authority,
        getCfg: params.context.getRuntimeConfig,
        inputId: params.inputId,
        client: params.client,
        exposeAmbiguousPrefixError: params.exposeAmbiguousPrefixError,
        recordFilter,
      });
    } catch (err) {
      respondFailure(err);
      return;
    }
    if (!params.authority.isCurrent()) {
      respondUnknownOrExpiredApproval(params.respond);
      return;
    }
    if (resolvedRepeat.ok) {
      respondRepeatedApprovalResolution(resolvedRepeat.snapshot, params.decision, params.respond);
      return;
    }
    respondPendingApprovalLookupError({ respond: params.respond, response: resolved.response });
    return;
  }

  const validationError = params.validateDecision?.(resolved.snapshot);
  if (validationError) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        validationError.message,
        validationError.details ? { details: validationError.details } : undefined,
      ),
    );
    return;
  }

  const resolvedBy =
    params.client?.connect?.client?.displayName ?? params.client?.connect?.client?.id ?? null;
  const resolver = custody ? ({ kind: "channel", id: custody.resolverId } as const) : undefined;
  const sourceSessionKey = resolved.snapshot.request.sessionKey;
  const sourceAgentId = resolved.snapshot.request.agentId;
  const guard: OperatorApprovalStoreGuard = {
    family: params.authority.guard.family,
    assertCurrent: () => {
      params.authority.assertCommitCurrent();
      const currentCustody = params.reviewer
        ? prepareApprovalChannelCustody({
            cfg: params.context.getRuntimeConfig(),
            approvalKind: params.approvalKind,
            reviewer: params.reviewer,
          })
        : null;
      if (
        params.manager.getLocalSnapshot(resolved.approvalId) !== resolved.snapshot ||
        resolved.snapshot.request.sessionKey !== sourceSessionKey ||
        resolved.snapshot.request.agentId !== sourceAgentId ||
        params.client?.invalidated ||
        !isApprovalRecordVisibleToClient({
          record: resolved.snapshot,
          client: params.client,
          ...(params.authority.guard.family === "native-compatibility"
            ? { cfg: params.context.getRuntimeConfig() }
            : {}),
        }) ||
        (params.reviewer && !currentCustody?.authorizes(resolved.snapshot))
      ) {
        throw new Error("approval resolver authority is no longer active");
      }
    },
  };
  let ok: boolean;
  try {
    ok = params.resolveRecord
      ? await params.resolveRecord({
          approvalId: resolved.approvalId,
          decision: params.decision,
          resolvedBy,
          snapshot: resolved.snapshot,
          resolver,
          guard,
        })
      : resolver
        ? (
            await params.manager.resolveDetailed(
              resolved.approvalId,
              params.decision,
              resolver,
              resolvedBy,
              "operator",
              { guard },
            )
          ).outcome === "resolved"
        : await params.manager.resolve(resolved.approvalId, params.decision, resolvedBy, {
            guard,
          });
  } catch (err) {
    respondFailure(err);
    return;
  }
  if (!ok) {
    // A concurrent surface can win between the pending lookup and this
    // resolve; report the recorded conflict, not a missing approval.
    const raced = await params.manager.getSnapshot(resolved.approvalId, params.authority);
    params.authority.assertCurrent();
    if (raced && raced.resolvedAtMs !== undefined) {
      respondRepeatedApprovalResolution(raced, params.decision, params.respond);
      return;
    }
    respondUnknownOrExpiredApproval(params.respond);
    return;
  }

  const resolvedEvent: ResolvedApprovalEvent<TPayload> = {
    id: resolved.approvalId,
    decision: params.decision,
    resolvedBy,
    ts: Date.now(),
    request: resolved.snapshot.request,
  };
  broadcastApprovalResolvedEvent({
    approvalKind: params.approvalKind,
    context: params.context,
    record: resolved.snapshot,
    event: resolvedEvent,
  });
  if (params.approvalKind !== "system-agent") {
    params.context.approvalEvents?.publishResolved(params.approvalKind, resolvedEvent as never);
  }

  const followUps = [
    params.forwardResolved
      ? {
          run: params.forwardResolved,
          errorLabel: params.forwardResolvedErrorLabel ?? "approval resolve follow-up failed",
        }
      : null,
    ...(params.extraResolvedHandlers ?? []),
    params.context.approvalWebPushDelivery
      ? {
          run: params.context.approvalWebPushDelivery.handleResolved,
          errorLabel: `${params.approvalKind} approvals: Web Push resolve failed`,
        }
      : null,
  ].filter(
    (
      entry,
    ): entry is {
      run: (event: ResolvedApprovalEvent<TPayload>) => Promise<void> | void;
      errorLabel: string;
    } => Boolean(entry),
  );

  // Resolution has already been recorded and broadcast; follow-up hooks are
  // best-effort so a plugin/channel forwarding failure cannot reopen it.
  for (const followUp of followUps) {
    try {
      await followUp.run(resolvedEvent);
    } catch (err) {
      params.context.logGateway?.error?.(`${followUp.errorLabel}: ${String(err)}`);
    }
  }

  if (params.authority.isCurrent()) {
    params.respond(true, { ok: true }, undefined);
  } else {
    respondUnknownOrExpiredApproval(params.respond);
  }
}
