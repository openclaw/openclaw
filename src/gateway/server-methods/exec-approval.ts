import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateExecApprovalGetParams,
  validateExecApprovalGrantsListParams,
  validateExecApprovalGrantsRevokeParams,
  validateExecApprovalRequestParams,
  validateExecApprovalResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveExecCommandHighlighting } from "../../config/exec-command-highlighting.js";
import { sanitizeApprovalScope, type ApprovalScope } from "../../infra/approval-scope.js";
import { resolveCommandAnalysisSummaryForDisplay } from "../../infra/command-analysis/explain.js";
import { lookupCronRunExecSource } from "../../infra/cron-run-exec-source.js";
import { resolveExecApprovalCommandDisplay } from "../../infra/exec-approval-command-display.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import {
  boundExecApprovalVisibleText,
  sanitizeExecApprovalDisplayText,
  sanitizeExecApprovalDisplayTextWithStatus,
  sanitizeExecApprovalWarningText,
} from "../../infra/exec-approval-text-sanitize.js";
import { normalizeExecAsk, normalizeExecSecurity } from "../../infra/exec-approvals-core.js";
import {
  DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  normalizeExecApprovalUnavailableDecisions,
  resolveExecApprovalRequestAllowedDecisions,
} from "../../infra/exec-approvals.js";
import {
  buildSystemRunApprovalBinding,
  buildSystemRunApprovalEnvBinding,
} from "../../infra/system-run-approval-binding.js";
import { resolveSystemRunApprovalRequestContext } from "../../infra/system-run-approval-context.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { normalizeCommandSpans } from "../../shared/exec-approval-command-spans.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import { InvalidApprovalIdError } from "../exec-approval-registration.js";
import {
  buildCronExecOperationBinding,
  parseCronExecOperationBinding,
} from "../operator-approval-standing-grants.js";
import { listCronStandingGrants, revokeCronStandingGrant } from "../operator-approval-store.js";
import { resolveGrantExpiryDaysConfig } from "../standing-grant-expiry-config.js";
import { createApprovalRequestAuthority } from "./approval-request-authority.js";
import { handlePendingApprovalRequestWithDelivery } from "./approval-request-delivery.js";
import {
  handleApprovalWaitDecision,
  bindApprovalRequesterMetadata,
  bindApprovalReviewerDeviceIds,
  handleApprovalResolve,
  listVisiblePendingApprovalRequests,
  registerPendingApprovalRecord,
  resolveApprovalDecisionParams,
  respondPendingApprovalLookupError,
  resolvePendingApprovalRecord,
} from "./approval-shared.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const APPROVAL_ALLOW_ALWAYS_UNAVAILABLE_DETAILS = {
  reason: "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE",
} as const;
const RESERVED_PLUGIN_APPROVAL_ID_PREFIX = "plugin:";

type ExecApprovalIosPushDelivery = NonNullable<
  GatewayRequestContext["execApprovalIosPushDelivery"]
>;

export function createExecApprovalHandlers(
  manager: ExecApprovalManager,
  opts?: { forwarder?: ExecApprovalForwarder; iosPushDelivery?: ExecApprovalIosPushDelivery },
): GatewayRequestHandlers {
  return {
    "exec.approval.get": async (options) => {
      using authority = createApprovalRequestAuthority(options);
      const { params, respond, client, context } = options;
      if (!assertValidParams(params, validateExecApprovalGetParams, "exec.approval.get", respond)) {
        return;
      }
      const resolved = await resolvePendingApprovalRecord({
        authority,
        manager,
        inputId: params.id,
        client,
        ...(client?.authenticatedUserProfile ? { getCfg: context.getRuntimeConfig } : {}),
        exposeAmbiguousPrefixError: true,
      });
      authority.assertCurrent();
      if (!resolved.ok) {
        respondPendingApprovalLookupError({ respond, response: resolved.response });
        return;
      }
      const { commandText, commandPreview } = resolveExecApprovalCommandDisplay(
        resolved.snapshot.request,
      );
      respond(
        true,
        {
          id: resolved.approvalId,
          commandText,
          commandPreview,
          allowedDecisions: resolveExecApprovalRequestAllowedDecisions(resolved.snapshot.request),
          host: resolved.snapshot.request.host ?? null,
          nodeId: resolved.snapshot.request.nodeId ?? null,
          agentId: resolved.snapshot.request.agentId ?? null,
          expiresAtMs: resolved.snapshot.expiresAtMs,
        },
        undefined,
      );
    },
    "exec.approval.list": async (options) => {
      using authority = createApprovalRequestAuthority(options);
      const { respond, client, context } = options;
      const approvals = await listVisiblePendingApprovalRequests({
        authority,
        manager,
        client,
        approvalKind: "exec",
        ...(client?.authenticatedUserProfile ? { getCfg: context.getRuntimeConfig } : {}),
      });
      authority.assertCurrent();
      respond(true, approvals, undefined);
    },
    "exec.approval.request": async ({ params, respond, context, client }) => {
      if (
        !assertValidParams(
          params,
          validateExecApprovalRequestParams,
          "exec.approval.request",
          respond,
        )
      ) {
        return;
      }
      const rejectRequest = (message: string) => {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
      };
      const p = params;
      const twoPhase = p.twoPhase === true;
      const timeoutMs = p.timeoutMs ?? DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
      // IDs are opaque cross-surface handles. Preserve every supplied byte so
      // the manager can reject unsafe values instead of silently normalizing them.
      const explicitId = p.id ?? null;
      const host = normalizeOptionalString(p.host) ?? "";
      const nodeId = normalizeOptionalString(p.nodeId) ?? "";
      const trustedAgentRuntime = client?.internal?.agentRuntimeIdentity;
      if (
        trustedAgentRuntime &&
        context.validateAgentRuntimeApprovalAuthority?.(trustedAgentRuntime) !== true
      ) {
        rejectRequest("agent runtime approval authority is no longer active");
        return;
      }
      const approvalContext = resolveSystemRunApprovalRequestContext({
        host,
        command: p.command,
        commandArgv: p.commandArgv,
        systemRunPlan: p.systemRunPlan,
        cwd: p.cwd,
        agentId: trustedAgentRuntime?.agentId ?? p.agentId,
        sessionKey: trustedAgentRuntime?.sessionKey ?? p.sessionKey,
      });
      const effectiveCommandArgv = approvalContext.commandArgv;
      const effectiveCwd = approvalContext.cwd;
      const effectiveAgentId = approvalContext.agentId;
      const effectiveSessionKey = approvalContext.sessionKey;
      const effectiveCommandText = approvalContext.commandText;
      const requestRunId =
        trustedAgentRuntime?.operationalRunInstance.runId ?? normalizeOptionalString(p.runId);
      if (host === "node" && !nodeId) {
        rejectRequest("nodeId is required for host=node");
        return;
      }
      if (host === "node" && !approvalContext.plan) {
        rejectRequest("systemRunPlan is required for host=node");
        return;
      }
      if (effectiveCommandText.trim().length === 0) {
        rejectRequest("command is required");
        return;
      }
      if (explicitId?.startsWith(RESERVED_PLUGIN_APPROVAL_ID_PREFIX)) {
        rejectRequest(
          `approval ids starting with ${RESERVED_PLUGIN_APPROVAL_ID_PREFIX} are reserved`,
        );
        return;
      }
      if (
        host === "node" &&
        (!Array.isArray(effectiveCommandArgv) || effectiveCommandArgv.length === 0)
      ) {
        rejectRequest("commandArgv is required for host=node");
        return;
      }
      const envBinding = buildSystemRunApprovalEnvBinding(p.env);
      const warningText = normalizeOptionalString(p.warningText);
      const runtimeConfig = context.getRuntimeConfig();
      const commandHighlighting = resolveExecCommandHighlighting({
        config: runtimeConfig,
        agentId: effectiveAgentId,
      });
      const sanitizedCommandDisplay =
        sanitizeExecApprovalDisplayTextWithStatus(effectiveCommandText);
      if (sanitizedCommandDisplay.truncated || sanitizedCommandDisplay.oversized) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "command exceeds exec approval display limit", {
            details: {
              reason: "EXEC_APPROVAL_COMMAND_DISPLAY_LIMIT",
            },
          }),
        );
        return;
      }
      const sanitizedCommandText = sanitizedCommandDisplay.text;
      const commandAnalysis = await resolveCommandAnalysisSummaryForDisplay({
        host,
        commandText: effectiveCommandText,
        commandArgv: effectiveCommandArgv,
        cwd: effectiveCwd,
        sanitizeText: sanitizeExecApprovalWarningText,
      });
      const commandSpans =
        commandHighlighting && sanitizedCommandText === effectiveCommandText
          ? normalizeCommandSpans(p.commandSpans, sanitizedCommandText.length)
          : undefined;
      const systemRunBinding =
        host === "node"
          ? buildSystemRunApprovalBinding({
              argv: effectiveCommandArgv,
              cwd: effectiveCwd,
              agentId: effectiveAgentId,
              sessionKey: effectiveSessionKey,
              env: p.env,
            })
          : null;
      if (explicitId && (await manager.getSnapshot(explicitId))) {
        rejectRequest("approval id already pending");
        return;
      }
      const unavailableDecisions = normalizeExecApprovalUnavailableDecisions(
        p.unavailableDecisions,
      );
      // Record the cron fact where it happens: the cron run owner registered
      // its job identity for this active run; a matching gateway-host request
      // carries it so an allow-always resolution can mint a standing grant
      // scoped to this exact operation instead of a JSON allowlist digest.
      const cronRunExecSource =
        host === "gateway" && requestRunId ? lookupCronRunExecSource(requestRunId) : undefined;
      const cronExecutionSource =
        cronRunExecSource && effectiveAgentId && cronRunExecSource.agentId === effectiveAgentId
          ? {
              jobId: cronRunExecSource.jobId,
              jobConfigRevision: cronRunExecSource.jobConfigRevision,
            }
          : null;
      // Automation cards say what allow-always mints. The default expiry is
      // read at request time for display; the resolve transaction re-reads it
      // when stamping the grant, so a config change between the two shows the
      // stale number at worst and never mis-stamps the row.
      const grantDefaultExpiryDays = cronExecutionSource
        ? resolveGrantExpiryDaysConfig(context.getRuntimeConfig())
        : null;
      const standingGrantScope: ApprovalScope | null =
        cronExecutionSource && cronRunExecSource && effectiveCommandText
          ? {
              kind: "standing-grant",
              automation: boundExecApprovalVisibleText(cronRunExecSource.jobName, 128),
              command: boundExecApprovalVisibleText(effectiveCommandText, 256),
              ...(grantDefaultExpiryDays !== null ? { expiresInDays: grantDefaultExpiryDays } : {}),
            }
          : null;
      const request = {
        command: sanitizedCommandText,
        commandPreview:
          host === "node" || !approvalContext.commandPreview
            ? undefined
            : sanitizeExecApprovalDisplayText(approvalContext.commandPreview),
        commandArgv: host === "node" ? undefined : effectiveCommandArgv,
        envKeys: envBinding.envKeys.length > 0 ? envBinding.envKeys : undefined,
        systemRunBinding: systemRunBinding?.binding ?? null,
        systemRunPlan: approvalContext.plan,
        // cwd/resolvedPath are display-only in the stored record (execution
        // binds effectiveCwd via systemRunBinding above); sanitize like the
        // command so bidi/invisible chars cannot spoof reviewer surfaces.
        cwd: effectiveCwd ? sanitizeExecApprovalDisplayText(effectiveCwd) : null,
        // nodeId/agentId/sessionKey stay raw: they are matched against the
        // node registry and session routing, so escaping would break real
        // lookups without display gain (hostile values match nothing).
        nodeId: host === "node" ? nodeId : null,
        // host is enum-gated ("node" checks); escape is identity for valid
        // values and defuses invisible-char spoofing in reviewer meta rows.
        host: host ? sanitizeExecApprovalDisplayText(host) : null,
        // Closed enums: arbitrary strings become null instead of reaching
        // reviewer surfaces; decision resolution already treats them as null.
        security: normalizeExecSecurity(p.security) ?? null,
        ask: normalizeExecAsk(p.ask) ?? null,
        warningText: warningText ? sanitizeExecApprovalWarningText(warningText) : null,
        // Server-derived automation scope wins: the gateway owns the cron
        // fact, so a client-declared scope never masks what allow-always mints.
        scope: standingGrantScope ?? (p.scope ? sanitizeApprovalScope(p.scope) : null),
        commandAnalysis,
        commandSpans,
        unavailableDecisions: unavailableDecisions.length > 0 ? unavailableDecisions : undefined,
        allowedDecisions: resolveExecApprovalRequestAllowedDecisions({
          ask: p.ask ?? null,
          unavailableDecisions,
        }),
        // The runtime owns the decision; the plan retains node policy identity.
        agentId: trustedAgentRuntime?.agentId ?? effectiveAgentId ?? null,
        resolvedPath: p.resolvedPath ? sanitizeExecApprovalDisplayText(p.resolvedPath) : null,
        sessionKey: trustedAgentRuntime?.sessionKey ?? effectiveSessionKey ?? null,
        sessionId: trustedAgentRuntime ? null : (normalizeOptionalString(p.sessionId) ?? null),
        runId: requestRunId ?? null,
        toolCallId: normalizeOptionalString(p.toolCallId) ?? null,
        turnSourceChannel: trustedAgentRuntime
          ? (trustedAgentRuntime.turnSourceChannel ?? null)
          : (normalizeOptionalString(p.turnSourceChannel) ?? null),
        turnSourceTo: trustedAgentRuntime
          ? (trustedAgentRuntime.turnSourceTo ?? null)
          : (normalizeOptionalString(p.turnSourceTo) ?? null),
        turnSourceAccountId: trustedAgentRuntime
          ? (trustedAgentRuntime.turnSourceAccountId ?? null)
          : (normalizeOptionalString(p.turnSourceAccountId) ?? null),
        turnSourceThreadId: trustedAgentRuntime
          ? (trustedAgentRuntime.turnSourceThreadId ?? null)
          : (p.turnSourceThreadId ?? null),
        cronExecutionSource,
        cronOperationBinding: cronExecutionSource
          ? buildCronExecOperationBinding({
              command: effectiveCommandText,
              cwd: effectiveCwd,
              env: p.env,
            })
          : null,
      };
      // This check is adjacent to manager creation with no await between them.
      // The abort owner records the tombstone before sweeping pending approvals.
      if (requestRunId && context.chatRunState.hasAbortMarker(requestRunId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval run already aborted", {
            details: { reason: "EXEC_APPROVAL_RUN_ABORTED" },
          }),
        );
        return;
      }
      let record: ReturnType<typeof manager.create>;
      try {
        record = manager.create(request, timeoutMs, explicitId);
      } catch (error) {
        if (error instanceof InvalidApprovalIdError) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
              details: { code: error.code, reason: error.reason },
            }),
          );
          return;
        }
        throw error;
      }
      bindApprovalRequesterMetadata({ record, client });
      if (trustedAgentRuntime) {
        record.agentRuntimeDelegatedAuthority = trustedAgentRuntime.delegatedAuthority;
      }
      const trustedExecutionIdentity = trustedAgentRuntime?.executionIdentity;
      if (trustedExecutionIdentity && requestRunId === trustedExecutionIdentity.runId) {
        record.executionIdentityToken = trustedExecutionIdentity;
      }
      if (client?.internal?.approvalRuntime === true) {
        // Reviewer ids widen approval visibility, so only the server-trusted
        // approval runtime may bind them onto a pending exec approval.
        bindApprovalReviewerDeviceIds({
          record,
          deviceIds: p.approvalReviewerDeviceIds,
        });
      }
      const registration = await registerPendingApprovalRecord({
        manager,
        record,
        timeoutMs,
        respond,
        context,
      });
      if (!registration) {
        return;
      }
      await handlePendingApprovalRequestWithDelivery({
        approvalKind: "exec",
        manager,
        record,
        respond,
        context,
        clientConnId: client?.connId,
        twoPhase,
        requireDeliveryRoute: p.requireDeliveryRoute,
        suppressDelivery: p.suppressDelivery,
        // The gateway-derived cron fact wins even when an older in-process
        // caller omits the flag: cron cards belong on approval surfaces only.
        deliverToApprovalClientsOnly:
          p.deliverToApprovalClientsOnly === true || cronExecutionSource !== null,
        forwardRequest: opts?.forwarder?.handleRequested.bind(opts.forwarder),
        getIosPushDelivery: () => opts?.iosPushDelivery,
      });
    },
    "exec.approval.waitDecision": async (options) => {
      using authority = createApprovalRequestAuthority(options);
      const { params, respond, client, context } = options;
      await handleApprovalWaitDecision({
        authority,
        manager,
        inputId: params.id,
        client,
        ...(client?.authenticatedUserProfile ? { getCfg: context.getRuntimeConfig } : {}),
        respond,
        resolveTerminalReason: (snapshot) => {
          const runId = normalizeOptionalString(snapshot.request.runId);
          return runId && context.chatRunState.hasAbortMarker(runId) ? "run-aborted" : undefined;
        },
      });
    },
    "exec.approval.grants.list": async (options) => {
      using authority = createApprovalRequestAuthority(options);
      const { params, respond } = options;
      if (
        !assertValidParams(
          params,
          validateExecApprovalGrantsListParams,
          "exec.approval.grants.list",
          respond,
        )
      ) {
        return;
      }
      const records = await listCronStandingGrants({ limit: params.limit, guard: authority.guard });
      authority.assertCurrent();
      const grants = records.map((grant) => {
        const operation = parseCronExecOperationBinding(grant.operationBinding);
        return {
          grantId: grant.grantId,
          mintedByApprovalId: grant.mintedByApprovalId,
          agentId: grant.agentId,
          cronJobId: grant.cronJobId,
          cronJobName: grant.cronJobName,
          command: boundExecApprovalVisibleText(operation?.command ?? "(unreadable)", 512),
          cwd: operation?.cwd ? boundExecApprovalVisibleText(operation.cwd, 512) : null,
          createdAtMs: grant.createdAtMs,
          expiresAtMs: grant.expiresAtMs,
          revokedAtMs: grant.revokedAtMs,
          revokedBy: grant.revokedBy,
          lastUsedAtMs: grant.lastUsedAtMs,
          useCount: grant.useCount,
        };
      });
      respond(true, { grants }, undefined);
    },
    "exec.approval.grants.revoke": async (options) => {
      using authority = createApprovalRequestAuthority(options);
      const { params, respond, client } = options;
      if (
        !assertValidParams(
          params,
          validateExecApprovalGrantsRevokeParams,
          "exec.approval.grants.revoke",
          respond,
        )
      ) {
        return;
      }
      const revokedBy =
        client?.connect?.client?.displayName ?? client?.connect?.client?.id ?? "operator";
      const result = await revokeCronStandingGrant({
        grantId: params.grantId,
        revokedBy,
        guard: authority.guard,
      });
      authority.assertCurrent();
      respond(true, { outcome: result.outcome }, undefined);
    },
    "exec.approval.resolve": async (options) => {
      using authority = createApprovalRequestAuthority(options);
      const { params, respond, client, context } = options;
      const resolveParams = resolveApprovalDecisionParams({
        rawParams: params,
        validate: validateExecApprovalResolveParams,
        methodName: "exec.approval.resolve",
        respond,
      });
      if (!resolveParams) {
        return;
      }
      const { inputId, decision, reviewer } = resolveParams;
      // Grant terms freeze at resolve time. An explicit per-resolve override
      // (custom operator UIs) wins over the configured default; the manager
      // applies tools.exec.grantExpiryDays when this stays undefined.
      const overrideDays = params.grantExpiresInDays;
      const grantExpiresAtMs =
        decision === "allow-always" && typeof overrideDays === "number"
          ? Date.now() + Math.floor(overrideDays) * 86_400_000
          : undefined;
      let autoReviewResolution = false;
      await handleApprovalResolve({
        approvalKind: "exec",
        authority,
        manager,
        inputId,
        decision,
        respond,
        context,
        client,
        reviewer,
        exposeAmbiguousPrefixError: true,
        validateDecision: (snapshot) => {
          const autoReviewIdentity =
            client?.internal?.approvalRuntime === true
              ? client.internal.agentRuntimeIdentity
              : undefined;
          if (autoReviewIdentity) {
            const requestAgentId = normalizeAgentId(snapshot.request.agentId ?? undefined);
            const requestSessionKey = normalizeOptionalString(snapshot.request.sessionKey);
            if (
              decision !== "allow-once" ||
              snapshot.request.host !== "node" ||
              requestAgentId !== autoReviewIdentity.agentId ||
              requestSessionKey !== autoReviewIdentity.sessionKey
            ) {
              return {
                message: "auto-review approval identity does not match request",
                details: { reason: "AUTO_REVIEW_APPROVAL_IDENTITY_MISMATCH" },
              };
            }
            autoReviewResolution = true;
          }
          const allowedDecisions = resolveExecApprovalRequestAllowedDecisions(snapshot.request);
          return allowedDecisions.includes(decision)
            ? null
            : {
                message: "allow-always is unavailable for this command",
                details: APPROVAL_ALLOW_ALWAYS_UNAVAILABLE_DETAILS,
              };
        },
        resolveRecord: async ({
          approvalId,
          decision: decisionLocal,
          resolvedBy,
          resolver,
          guard,
        }) => {
          if (autoReviewResolution) {
            return manager.resolveAutoReview(approvalId, resolvedBy, undefined, guard);
          }
          const grantOptions = {
            guard,
            ...(grantExpiresAtMs !== undefined ? { grantExpiresAtMs } : {}),
          };
          return resolver
            ? (
                await manager.resolveDetailed(
                  approvalId,
                  decisionLocal,
                  resolver,
                  resolvedBy,
                  "operator",
                  grantOptions,
                )
              ).outcome === "resolved"
            : manager.resolve(approvalId, decisionLocal, resolvedBy, grantOptions);
        },
        forwardResolved: (resolvedEvent) => opts?.forwarder?.handleResolved(resolvedEvent),
        forwardResolvedErrorLabel: "exec approvals: forward resolve failed",
        extraResolvedHandlers: opts?.iosPushDelivery?.handleResolved
          ? [
              {
                run: (resolvedEvent) => opts.iosPushDelivery!.handleResolved!(resolvedEvent),
                errorLabel: "exec approvals: iOS push resolve failed",
              },
            ]
          : undefined,
      });
    },
  };
}
