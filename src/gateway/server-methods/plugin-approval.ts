// Gateway RPC handlers for plugin approval requests and decisions.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validatePluginApprovalRequestParams,
  validatePluginApprovalResolveParams,
  validatePluginApprovalResolveVerifiedParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import {
  buildPluginApprovalExternalResolution,
  resolvePluginApprovalRequestAllowedDecisions,
  resolvePluginApprovalTimeoutMs,
  type PluginApprovalExternalResolutionDecision,
  type PluginApprovalExternalResolutionTemplate,
} from "../../infra/plugin-approvals.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import {
  bindApprovalRequesterMetadata,
  buildRequestedApprovalEvent,
  handleApprovalResolve,
  handleApprovalWaitDecision,
  handlePendingApprovalRequest,
  listVisiblePendingApprovalRequests,
  registerPendingApprovalRecord,
  resolveApprovalDecisionParams,
} from "./approval-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

function resolveVerifiedPluginApprovalDecisionSet(
  request: PluginApprovalRequestPayload,
): ReadonlySet<PluginApprovalExternalResolutionDecision> {
  const decisions = new Set<PluginApprovalExternalResolutionDecision>();
  for (const command of request.externalResolution?.commands ?? []) {
    decisions.add(command.decision);
  }
  return decisions;
}

function resolvePluginApprovalCoreDecisions(params: {
  allowedDecisions?: string[] | null;
  externalResolution: PluginApprovalRequestPayload["externalResolution"];
}): readonly ExecApprovalDecision[] | { error: string } | null {
  const explicitAllowedDecisions = Array.isArray(params.allowedDecisions)
    ? resolvePluginApprovalRequestAllowedDecisions({
        allowedDecisions: params.allowedDecisions,
      })
    : null;
  if (!params.externalResolution) {
    return explicitAllowedDecisions;
  }
  const requested = explicitAllowedDecisions ?? (["deny"] as const);
  const coreBypassDecisions = requested.filter((decision) => decision !== "deny");
  if (coreBypassDecisions.length > 0) {
    return {
      error:
        'externalResolution approvals must route allow decisions through external verification; use allowedDecisions: ["deny"]',
    };
  }
  return ["deny"];
}

/** Create plugin approval handlers backed by the shared approval manager. */
export function createPluginApprovalHandlers(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
  opts?: { forwarder?: ExecApprovalForwarder },
): GatewayRequestHandlers {
  return {
    "plugin.approval.list": async ({ respond, client }) => {
      respond(true, listVisiblePendingApprovalRequests({ manager, client }), undefined);
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
        pluginId?: string | null;
        title: string;
        description: string;
        severity?: string | null;
        toolName?: string | null;
        toolCallId?: string | null;
        allowedDecisions?: string[] | null;
        externalResolution?: PluginApprovalExternalResolutionTemplate | null;
        agentId?: string | null;
        sessionKey?: string | null;
        turnSourceChannel?: string | null;
        turnSourceTo?: string | null;
        turnSourceAccountId?: string | null;
        turnSourceThreadId?: string | number | null;
        timeoutMs?: number;
        twoPhase?: boolean;
      };
      const twoPhase = p.twoPhase === true;
      const timeoutMs = resolvePluginApprovalTimeoutMs(p.timeoutMs);

      const normalizeTrimmedString = (value?: string | null): string | null =>
        normalizeOptionalString(value) || null;

      const pluginId = normalizeTrimmedString(p.pluginId);
      // Always server-generate the ID — never accept plugin-provided IDs.
      // Kind-prefix so /approve routing can distinguish plugin vs exec IDs deterministically.
      const approvalId = `plugin:${randomUUID()}`;
      let externalResolution: PluginApprovalRequestPayload["externalResolution"];
      try {
        externalResolution = buildPluginApprovalExternalResolution({
          approvalId,
          externalResolution: p.externalResolution,
        });
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
        );
        return;
      }
      if (externalResolution && !pluginId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "externalResolution requires pluginId"),
        );
        return;
      }
      const allowedDecisions = resolvePluginApprovalCoreDecisions({
        allowedDecisions: p.allowedDecisions,
        externalResolution,
      });
      if (allowedDecisions && "error" in allowedDecisions) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, allowedDecisions.error));
        return;
      }

      const request: PluginApprovalRequestPayload = {
        pluginId,
        title: p.title,
        description: p.description,
        severity: (p.severity as PluginApprovalRequestPayload["severity"]) ?? null,
        toolName: p.toolName ?? null,
        toolCallId: p.toolCallId ?? null,
        ...(allowedDecisions ? { allowedDecisions } : {}),
        ...(externalResolution ? { externalResolution } : {}),
        agentId: p.agentId ?? null,
        sessionKey: p.sessionKey ?? null,
        turnSourceChannel: normalizeTrimmedString(p.turnSourceChannel),
        turnSourceTo: normalizeTrimmedString(p.turnSourceTo),
        turnSourceAccountId: normalizeTrimmedString(p.turnSourceAccountId),
        turnSourceThreadId: p.turnSourceThreadId ?? null,
      };

      const record = manager.create(request, timeoutMs, approvalId);
      bindApprovalRequesterMetadata({ record, client });

      const decisionPromise = registerPendingApprovalRecord({
        manager,
        record,
        timeoutMs,
        respond,
      });
      if (!decisionPromise) {
        return;
      }

      const requestEvent = buildRequestedApprovalEvent(record);

      await handlePendingApprovalRequest({
        manager,
        record,
        decisionPromise,
        respond,
        context,
        clientConnId: client?.connId,
        requestEventName: "plugin.approval.requested",
        requestEvent,
        twoPhase,
        approvalKind: "plugin",
        deliverRequest: () => {
          if (!opts?.forwarder?.handlePluginApprovalRequested) {
            return false;
          }
          return opts.forwarder
            .handlePluginApprovalRequested(requestEvent)
            .catch((err: unknown) => {
              context.logGateway?.error?.(
                `plugin approvals: forward request failed: ${String(err)}`,
              );
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
      const resolveParams = resolveApprovalDecisionParams({
        rawParams: params,
        validate: validatePluginApprovalResolveParams,
        methodName: "plugin.approval.resolve",
        respond,
      });
      if (!resolveParams) {
        return;
      }
      const { inputId, decision } = resolveParams;
      await handleApprovalResolve({
        manager,
        inputId,
        decision,
        respond,
        context,
        client,
        exposeAmbiguousPrefixError: false,
        validateDecision: (snapshot) =>
          resolvePluginApprovalRequestAllowedDecisions(snapshot.request).includes(decision)
            ? null
            : {
                message: `${decision} is unavailable for this plugin approval`,
                details: {
                  allowedDecisions: resolvePluginApprovalRequestAllowedDecisions(snapshot.request),
                },
              },
        resolvedEventName: "plugin.approval.resolved",
        buildResolvedEvent: ({
          approvalId,
          decision: decisionLocal,
          resolvedBy,
          snapshot,
          nowMs,
        }) => ({
          id: approvalId,
          decision: decisionLocal,
          resolvedBy,
          ts: nowMs,
          request: snapshot.request,
        }),
        forwardResolved: (resolvedEvent) =>
          opts?.forwarder?.handlePluginApprovalResolved?.(resolvedEvent),
        forwardResolvedErrorLabel: "plugin approvals: forward resolve failed",
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
      const p = params as {
        id: string;
        decision: PluginApprovalExternalResolutionDecision;
        pluginId: string;
      };
      const pluginId = normalizeOptionalString(p.pluginId);
      if (!pluginId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "pluginId is required"));
        return;
      }
      const decision = p.decision;
      await handleApprovalResolve({
        manager,
        inputId: p.id,
        decision,
        respond,
        context,
        client,
        exposeAmbiguousPrefixError: false,
        // Verified plugin resolution is authorized by plugin ownership, not by
        // the original reviewer connection that saw the pending approval.
        enforceClientVisibility: false,
        validateDecision: (snapshot) => {
          if (normalizeOptionalString(snapshot.request.pluginId) !== pluginId) {
            return {
              message: "plugin approval is not owned by the requested plugin",
              details: { pluginId },
            };
          }
          const allowedDecisions = resolveVerifiedPluginApprovalDecisionSet(snapshot.request);
          if (!allowedDecisions.has(decision)) {
            return {
              message: `${decision} is unavailable for this verified plugin approval`,
              details: { allowedDecisions: [...allowedDecisions] },
            };
          }
          return null;
        },
        resolvedEventName: "plugin.approval.resolved",
        buildResolvedEvent: ({
          approvalId,
          decision: resolvedDecision,
          resolvedBy,
          snapshot,
          nowMs,
        }) => ({
          id: approvalId,
          decision: resolvedDecision,
          resolvedBy,
          ts: nowMs,
          request: snapshot.request,
        }),
        forwardResolved: (resolvedEvent) =>
          opts?.forwarder?.handlePluginApprovalResolved?.(resolvedEvent),
        forwardResolvedErrorLabel: "plugin approvals: forward resolve failed",
      });
    },
  };
}
