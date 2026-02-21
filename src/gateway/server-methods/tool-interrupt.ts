import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateToolInterruptEmitParams,
  validateToolInterruptListParams,
  validateToolInterruptResumeParams,
} from "../protocol/index.js";
import type { ToolInterruptManager } from "../tool-interrupt-manager.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_INTERRUPT_TIMEOUT_MS = 10 * 60 * 1000;

function summarizeInterrupt(interrupt: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    redacted: true,
  };
  if (typeof interrupt.type === "string" && interrupt.type.trim()) {
    summary.type = interrupt.type.trim();
  }
  if (typeof interrupt.text === "string" && interrupt.text.trim()) {
    summary.text = `${interrupt.text.trim().slice(0, 120)}${interrupt.text.length > 120 ? "…" : ""}`;
  }
  if (typeof interrupt.reason === "string" && interrupt.reason.trim()) {
    summary.reason = `${interrupt.reason.trim().slice(0, 120)}${interrupt.reason.length > 120 ? "…" : ""}`;
  }
  return summary;
}

export function createToolInterruptHandlers(manager: ToolInterruptManager): GatewayRequestHandlers {
  return {
    "tool.interrupt.emit": async ({ params, respond, context }) => {
      if (!validateToolInterruptEmitParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid tool.interrupt.emit params: ${formatValidationErrors(
              validateToolInterruptEmitParams.errors,
            )}`,
          ),
        );
        return;
      }

      const p = params as {
        approvalRequestId: string;
        runId: string;
        sessionKey: string;
        toolCallId: string;
        toolName?: string;
        normalizedArgsHash?: string;
        interrupt: Record<string, unknown>;
        timeoutMs?: number;
        twoPhase?: boolean;
      };

      const snapshot = manager.getSnapshot(p.approvalRequestId);
      if (snapshot?.resumedAtMs) {
        if (
          snapshot.runId !== p.runId ||
          snapshot.sessionKey !== p.sessionKey ||
          snapshot.toolCallId !== p.toolCallId
        ) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "tool interrupt binding mismatch"),
          );
          return;
        }
        respond(
          true,
          {
            status: "resumed",
            approvalRequestId: snapshot.approvalRequestId,
            runId: snapshot.runId,
            sessionKey: snapshot.sessionKey,
            toolCallId: snapshot.toolCallId,
            resumedAtMs: snapshot.resumedAtMs,
            resumedBy: snapshot.resumedBy ?? null,
            result: snapshot.resumedResult,
          },
          undefined,
        );
        return;
      }

      let emitted: Awaited<ReturnType<typeof manager.emit>>;
      try {
        emitted = await manager.emit({
          approvalRequestId: p.approvalRequestId,
          runId: p.runId,
          sessionKey: p.sessionKey,
          toolCallId: p.toolCallId,
          toolName: p.toolName,
          normalizedArgsHash: p.normalizedArgsHash,
          interrupt: p.interrupt,
          timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : DEFAULT_INTERRUPT_TIMEOUT_MS,
        });
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
        return;
      }

      // SECURITY: resumeToken is a capability secret. Keep this event approvals-scoped only and
      // never mirror it into end-user chat streams or non-privileged logs.
      context.broadcast(
        "tool.interrupt.requested",
        {
          approvalRequestId: emitted.requested.approvalRequestId,
          runId: emitted.requested.runId,
          sessionKey: emitted.requested.sessionKey,
          toolCallId: emitted.requested.toolCallId,
          createdAtMs: emitted.requested.createdAtMs,
          expiresAtMs: emitted.requested.expiresAtMs,
          resumeToken: emitted.requested.resumeToken,
          toolName: p.toolName,
          normalizedArgsHash: p.normalizedArgsHash,
          interruptSummary: summarizeInterrupt(emitted.requested.interrupt),
          created: emitted.created,
        },
        { dropIfSlow: true },
      );

      if (p.twoPhase === true) {
        respond(
          true,
          {
            status: "accepted",
            ...emitted.requested,
            created: emitted.created,
          },
          undefined,
        );
      }

      const waitResult = await emitted.wait;
      if (waitResult.status === "expired") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "tool interrupt expired before resume"),
        );
        return;
      }

      respond(true, waitResult, undefined);
    },
    "tool.interrupt.list": async ({ params, respond }) => {
      if (!validateToolInterruptListParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid tool.interrupt.list params: ${formatValidationErrors(
              validateToolInterruptListParams.errors,
            )}`,
          ),
        );
        return;
      }

      const p = params as { state?: "pending" };
      const state = p.state ?? "pending";
      if (state !== "pending") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "unsupported state filter"),
        );
        return;
      }

      respond(
        true,
        {
          state,
          interrupts: manager.listPending(),
        },
        undefined,
      );
    },
    "tool.interrupt.resume": async ({ params, respond, context, client }) => {
      if (!validateToolInterruptResumeParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid tool.interrupt.resume params: ${formatValidationErrors(
              validateToolInterruptResumeParams.errors,
            )}`,
          ),
        );
        return;
      }

      const p = params as {
        approvalRequestId: string;
        runId: string;
        sessionKey: string;
        toolCallId: string;
        toolName?: string;
        normalizedArgsHash?: string;
        resumeToken: string;
        decisionReason?: string | null;
        policyRuleId?: string | null;
        decisionAtMs?: number;
        decisionMeta?: Record<string, unknown>;
        result: unknown;
      };

      const resolvedBy = client?.connect?.client?.displayName ?? client?.connect?.client?.id;
      const resumed = await manager.resume({
        approvalRequestId: p.approvalRequestId,
        runId: p.runId,
        sessionKey: p.sessionKey,
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        normalizedArgsHash: p.normalizedArgsHash,
        resumeToken: p.resumeToken,
        decisionReason: p.decisionReason,
        policyRuleId: p.policyRuleId,
        decisionAtMs: p.decisionAtMs,
        decisionMeta: p.decisionMeta,
        result: p.result,
        resumedBy: resolvedBy ?? null,
      });

      if (!resumed.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resumed.message));
        return;
      }

      context.broadcast(
        "tool.interrupt.resumed",
        {
          approvalRequestId: resumed.waitResult.approvalRequestId,
          runId: resumed.waitResult.runId,
          sessionKey: resumed.waitResult.sessionKey,
          toolCallId: resumed.waitResult.toolCallId,
          resumedAtMs: resumed.waitResult.resumedAtMs,
          resumedBy: resumed.waitResult.resumedBy,
          decisionReason: p.decisionReason ?? null,
          policyRuleId: p.policyRuleId ?? null,
          decisionAtMs:
            typeof p.decisionAtMs === "number" && Number.isFinite(p.decisionAtMs)
              ? Math.floor(p.decisionAtMs)
              : resumed.waitResult.resumedAtMs,
          decisionMeta: p.decisionMeta ?? null,
          ts: Date.now(),
        },
        { dropIfSlow: true },
      );

      respond(
        true,
        {
          ok: true,
          status: "resumed",
          alreadyResolved: resumed.alreadyResolved,
          approvalRequestId: resumed.waitResult.approvalRequestId,
          runId: resumed.waitResult.runId,
          sessionKey: resumed.waitResult.sessionKey,
          toolCallId: resumed.waitResult.toolCallId,
          resumedAtMs: resumed.waitResult.resumedAtMs,
          resumedBy: resumed.waitResult.resumedBy,
          result: resumed.waitResult.result,
        },
        undefined,
      );
    },
  };
}
