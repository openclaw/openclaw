import { randomUUID } from "node:crypto";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import type {
  PluginApprovalActionTemplate,
  PluginApprovalRequestPayload,
  PluginApprovalResolved,
} from "../../infra/plugin-approvals.js";
import {
  DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
  MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
  expandPluginApprovalActionTemplates,
  resolvePluginApprovalRequestAllowedDecisions,
} from "../../infra/plugin-approvals.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validatePluginApprovalRequestParams,
  validatePluginApprovalResolveParams,
  validatePluginApprovalResolveVerifiedParams,
} from "../protocol/index.js";
import {
  handleApprovalResolve,
  handleApprovalWaitDecision,
  handlePendingApprovalRequest,
  isApprovalDecision,
  isApprovalRecordVisibleToClient,
} from "./approval-shared.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";

const PLUGIN_APPROVAL_DECISION_UNAVAILABLE_DETAILS = {
  reason: "PLUGIN_APPROVAL_DECISION_UNAVAILABLE",
} as const;
const PLUGIN_APPROVAL_PLUGIN_MISMATCH_DETAILS = {
  reason: "PLUGIN_APPROVAL_PLUGIN_MISMATCH",
} as const;

type PluginApprovalHandlersOptions = { forwarder?: ExecApprovalForwarder };

function resolveStoredPluginApprovalAllowedDecisions(
  request: PluginApprovalRequestPayload,
): readonly ExecApprovalDecision[] {
  return resolvePluginApprovalRequestAllowedDecisions(request);
}

function resolveCustomActionAllowedDecisions(
  actionTemplates: readonly PluginApprovalActionTemplate[],
): ExecApprovalDecision[] {
  return Array.from(
    new Set(
      actionTemplates.flatMap((action) => {
        const decision = action.decision;
        return action.kind === "decision" &&
          typeof decision === "string" &&
          isApprovalDecision(decision)
          ? [decision]
          : [];
      }),
    ),
  );
}

function buildResolvedEvent(params: {
  approvalId: string;
  decision: ExecApprovalDecision;
  resolvedBy: string | null;
  snapshot: { request: PluginApprovalRequestPayload };
  nowMs: number;
}): PluginApprovalResolved {
  return {
    id: params.approvalId,
    decision: params.decision,
    resolvedBy: params.resolvedBy,
    ts: params.nowMs,
    request: params.snapshot.request,
  };
}

async function resolvePluginApproval(params: {
  manager: ExecApprovalManager<PluginApprovalRequestPayload>;
  opts?: PluginApprovalHandlersOptions;
  inputId: string;
  decision: ExecApprovalDecision;
  verifiedPluginId?: string;
  respond: RespondFn;
  context: GatewayRequestContext;
  client: GatewayClient | null;
}): Promise<void> {
  await handleApprovalResolve({
    manager: params.manager,
    inputId: params.inputId,
    decision: params.decision,
    respond: params.respond,
    context: params.context,
    client: params.client,
    exposeAmbiguousPrefixError: false,
    validateDecision: (snapshot) => {
      if (params.verifiedPluginId) {
        return snapshot.request.pluginId === params.verifiedPluginId
          ? null
          : {
              message: "verified plugin approval resolver does not match pending approval plugin",
              details: PLUGIN_APPROVAL_PLUGIN_MISMATCH_DETAILS,
            };
      }
      const allowedDecisions = resolveStoredPluginApprovalAllowedDecisions(snapshot.request);
      return allowedDecisions.includes(params.decision)
        ? null
        : {
            message: `${params.decision} is unavailable for this plugin approval`,
            details: {
              ...PLUGIN_APPROVAL_DECISION_UNAVAILABLE_DETAILS,
              allowedDecisions,
            },
          };
    },
    resolvedEventName: "plugin.approval.resolved",
    buildResolvedEvent,
    forwardResolved: (resolvedEvent) =>
      params.opts?.forwarder?.handlePluginApprovalResolved?.(resolvedEvent),
    forwardResolvedErrorLabel: "plugin approvals: forward resolve failed",
  });
}

export function createPluginApprovalHandlers(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
  opts?: PluginApprovalHandlersOptions,
): GatewayRequestHandlers {
  return {
    "plugin.approval.list": async ({ respond, client }) => {
      respond(
        true,
        manager
          .listPendingRecords()
          .filter((record) => isApprovalRecordVisibleToClient({ record, client }))
          .map((record) => ({
            id: record.id,
            request: record.request,
            createdAtMs: record.createdAtMs,
            expiresAtMs: record.expiresAtMs,
          })),
        undefined,
      );
    },
    "plugin.approval.request": async ({ params, client, respond, context }) => {
      if (!validatePluginApprovalRequestParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid plugin.approval.request params: ${formatValidationErrors(
              validatePluginApprovalRequestParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as {
        actions?: PluginApprovalActionTemplate[];
        allowedDecisions?: string[] | null;
        pluginId?: string | null;
        title: string;
        description: string;
        severity?: string | null;
        toolName?: string | null;
        toolCallId?: string | null;
        agentId?: string | null;
        sessionKey?: string | null;
        turnSourceChannel?: string | null;
        turnSourceTo?: string | null;
        turnSourceAccountId?: string | null;
        turnSourceThreadId?: string | number | null;
        timeoutMs?: number;
        keepPendingWithoutRoute?: boolean;
        twoPhase?: boolean;
      };
      const twoPhase = p.twoPhase === true;
      const timeoutMs = Math.min(
        typeof p.timeoutMs === "number" ? p.timeoutMs : DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
        MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
      );

      const normalizeTrimmedString = (value?: string | null): string | null =>
        normalizeOptionalString(value) || null;
      const actionTemplates = Array.isArray(p.actions) ? p.actions : [];
      for (const action of actionTemplates) {
        if (action.kind === "decision" && !isApprovalDecision(action.decision ?? "")) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `invalid plugin approval action decision: ${String(action.decision)}`,
            ),
          );
          return;
        }
      }

      const approvalId = `plugin:${randomUUID()}`;
      const explicitAllowedDecisions = Array.isArray(p.allowedDecisions)
        ? resolvePluginApprovalRequestAllowedDecisions({
            allowedDecisions: p.allowedDecisions,
          })
        : null;
      const allowedDecisions =
        explicitAllowedDecisions ??
        (actionTemplates.length > 0 ? resolveCustomActionAllowedDecisions(actionTemplates) : null);
      const request: PluginApprovalRequestPayload = {
        ...(actionTemplates.length > 0
          ? {
              actions: expandPluginApprovalActionTemplates({
                approvalId,
                actions: actionTemplates,
              }),
            }
          : {}),
        ...(allowedDecisions !== null ? { allowedDecisions } : {}),
        pluginId: p.pluginId ?? null,
        title: p.title,
        description: p.description,
        severity: (p.severity as PluginApprovalRequestPayload["severity"]) ?? null,
        toolName: p.toolName ?? null,
        toolCallId: p.toolCallId ?? null,
        agentId: p.agentId ?? null,
        sessionKey: p.sessionKey ?? null,
        turnSourceChannel: normalizeTrimmedString(p.turnSourceChannel),
        turnSourceTo: normalizeTrimmedString(p.turnSourceTo),
        turnSourceAccountId: normalizeTrimmedString(p.turnSourceAccountId),
        turnSourceThreadId: p.turnSourceThreadId ?? null,
      };

      // Always server-generate the ID — never accept plugin-provided IDs.
      // Kind-prefix so /approve routing can distinguish plugin vs exec IDs deterministically.
      const record = manager.create(request, timeoutMs, approvalId);
      record.requestedByConnId = client?.connId ?? null;
      record.requestedByDeviceId = client?.connect?.device?.id ?? null;
      record.requestedByClientId = client?.connect?.client?.id ?? null;
      record.requestedByDeviceTokenAuth = client?.isDeviceTokenAuth === true;

      let decisionPromise: Promise<ExecApprovalDecision | null>;
      try {
        decisionPromise = manager.register(record, timeoutMs);
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `registration failed: ${String(err)}`),
        );
        return;
      }

      const requestEvent = {
        id: record.id,
        request: record.request,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      };

      await handlePendingApprovalRequest({
        manager,
        record,
        decisionPromise,
        respond,
        context,
        clientConnId: client?.connId,
        requestEventName: "plugin.approval.requested",
        requestEvent,
        keepPendingWithoutRoute: p.keepPendingWithoutRoute === true,
        twoPhase,
        deliverRequest: () => {
          if (!opts?.forwarder?.handlePluginApprovalRequested) {
            return false;
          }
          return opts.forwarder.handlePluginApprovalRequested(requestEvent).catch((err) => {
            context.logGateway?.error?.(`plugin approvals: forward request failed: ${String(err)}`);
            return false;
          });
        },
      });
    },

    "plugin.approval.waitDecision": async ({ params, respond, client }) => {
      await handleApprovalWaitDecision({
        manager,
        inputId: (params as { id?: string }).id,
        client,
        respond,
      });
    },

    "plugin.approval.resolve": async ({ params, respond, client, context }) => {
      if (!validatePluginApprovalResolveParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid plugin.approval.resolve params: ${formatValidationErrors(
              validatePluginApprovalResolveParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as { id: string; decision: string };
      if (!isApprovalDecision(p.decision)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid decision"));
        return;
      }
      await resolvePluginApproval({
        manager,
        inputId: p.id,
        decision: p.decision,
        respond,
        context,
        client,
        opts,
      });
    },

    "plugin.approval.resolveVerified": async ({ params, respond, client, context }) => {
      if (!validatePluginApprovalResolveVerifiedParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid plugin.approval.resolveVerified params: ${formatValidationErrors(
              validatePluginApprovalResolveVerifiedParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as { id: string; decision: string; pluginId: string };
      if (!isApprovalDecision(p.decision)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid decision"));
        return;
      }
      await resolvePluginApproval({
        manager,
        inputId: p.id,
        decision: p.decision,
        verifiedPluginId: p.pluginId,
        respond,
        context,
        client,
        opts,
      });
    },
  };
}
