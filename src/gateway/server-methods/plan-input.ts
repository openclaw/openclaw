import type { PlanInputResult } from "../plan-input-manager.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validatePlanInputRequestParams,
  validatePlanInputResolveParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const planInputHandlers: GatewayRequestHandlers = {
  "plan.input.request": async ({ params, respond, context, client }) => {
    if (!validatePlanInputRequestParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid plan.input.request params: ${formatValidationErrors(
            validatePlanInputRequestParams.errors,
          )}`,
        ),
      );
      return;
    }
    if (!context.planInputManager) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "plan input unavailable"));
      return;
    }

    const p = params as {
      id?: string;
      runId: string;
      sessionKey: string;
      questions: Array<{
        header: string;
        id: string;
        question: string;
        options: Array<{ label: string; description: string }>;
      }>;
      timeoutMs?: number;
    };

    let prompt;
    try {
      prompt = context.planInputManager.create({
        id: p.id,
        runId: p.runId,
        sessionKey: p.sessionKey,
        questions: p.questions,
        timeoutMs: p.timeoutMs,
      });
      prompt.requestedByConnId = client?.connId ?? null;
      prompt.requestedByDeviceId = client?.connect?.device?.id ?? null;
      prompt.requestedByClientId = client?.connect?.client?.id ?? null;
      const resultPromise = context.planInputManager.register(prompt);
      if (prompt.requestedByConnId) {
        context.broadcastToConnIds(
          "plan.input.requested",
          {
            id: prompt.id,
            runId: prompt.runId,
            sessionKey: prompt.sessionKey,
            questions: prompt.questions,
            createdAtMs: prompt.createdAtMs,
            expiresAtMs: prompt.expiresAtMs,
          },
          new Set([prompt.requestedByConnId]),
          { dropIfSlow: true },
        );
      }
      const result = await resultPromise;
      if (result.status === "expired" && prompt.requestedByConnId) {
        context.broadcastToConnIds(
          "plan.input.resolved",
          {
            id: prompt.id,
            runId: prompt.runId,
            sessionKey: prompt.sessionKey,
            status: result.status,
            ts: Date.now(),
          },
          new Set([prompt.requestedByConnId]),
          { dropIfSlow: true },
        );
      }
      respond(
        true,
        {
          status: result.status,
          answers: result.answers,
        },
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `plan input request failed: ${String(err)}`),
      );
    }
  },
  "plan.input.resolve": ({ params, respond, context, client }) => {
    if (!validatePlanInputResolveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid plan.input.resolve params: ${formatValidationErrors(
            validatePlanInputResolveParams.errors,
          )}`,
        ),
      );
      return;
    }
    if (!context.planInputManager) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "plan input unavailable"));
      return;
    }

    const p = params as {
      id: string;
      status: PlanInputResult["status"];
      answers?: PlanInputResult["answers"];
    };
    const snapshot = context.planInputManager.getSnapshot(p.id);
    if (!snapshot) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown plan input id"));
      return;
    }

    const requestedByConnId = snapshot.requestedByConnId ?? null;
    if (requestedByConnId && requestedByConnId !== (client?.connId ?? null)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "plan input id not valid for this client"),
      );
      return;
    }

    const resolvedBy = client?.connect?.client?.displayName ?? client?.connect?.client?.id ?? null;
    const ok = context.planInputManager.resolve(
      p.id,
      {
        status: p.status,
        answers: p.answers,
      },
      resolvedBy,
    );
    if (!ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown plan input id"));
      return;
    }

    if (requestedByConnId) {
      context.broadcastToConnIds(
        "plan.input.resolved",
        {
          id: p.id,
          runId: snapshot.runId,
          sessionKey: snapshot.sessionKey,
          status: p.status,
          ts: Date.now(),
        },
        new Set([requestedByConnId]),
        { dropIfSlow: true },
      );
    }
    respond(true, { ok: true }, undefined);
  },
};
