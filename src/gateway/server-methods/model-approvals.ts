/**
 * Model Approvals Gateway Methods
 *
 * Handles approval requests for model divergence escalations.
 */

import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

// In-memory store of pending approval requests (would be in a DB in production)
const pendingApprovals = new Map<
  string,
  {
    sessionKey: string;
    userId: string;
    channel: string;
    message: string;
    decision?: "approve" | "reject";
    decidedAt?: string;
    createdAt: string;
  }
>();

/**
 * approval.request - Post an approval request for model divergence
 */
async function approvalRequest(
  params: {
    sessionKey: string;
    userId: string;
    channel: string;
    message: string;
  },
  respond: RespondFn,
) {
  try {
    const { sessionKey, userId, channel, message } = params;

    if (!sessionKey || !userId || !channel || !message) {
      return respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Missing required approval request fields"),
      );
    }

    // Store approval request
    const approval = {
      sessionKey,
      userId,
      channel,
      message,
      createdAt: new Date().toISOString(),
    };

    pendingApprovals.set(sessionKey, approval);

    console.log(`[ModelApprovals] Posted approval request for session ${sessionKey}`);

    respond(true, {
      sessionKey,
      createdAt: approval.createdAt,
    });
  } catch (err) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INTERNAL_ERROR, `Failed to create approval request: ${String(err)}`),
    );
  }
}

/**
 * approval.resolve - Resolve an approval request
 */
async function approvalResolve(
  params: {
    sessionKey: string;
    decision: "approve" | "reject";
  },
  respond: RespondFn,
) {
  try {
    const { sessionKey, decision } = params;

    if (!sessionKey || !["approve", "reject"].includes(decision)) {
      return respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Missing sessionKey or invalid decision (approve|reject)",
        ),
      );
    }

    const approval = pendingApprovals.get(sessionKey);
    if (!approval) {
      return respond(
        false,
        undefined,
        errorShape(ErrorCodes.NOT_FOUND, `Approval request not found: ${sessionKey}`),
      );
    }

    // Record decision
    approval.decision = decision;
    approval.decidedAt = new Date().toISOString();

    console.log(
      `[ModelApprovals] Resolved approval for session ${sessionKey}: ${decision} at ${approval.decidedAt}`,
    );

    // Notify session process of the decision
    if (process.send) {
      process.send({
        type: "approval-decision",
        sessionKey,
        decision,
        decidedAt: approval.decidedAt,
      });
    }

    respond(true, {
      sessionKey,
      decision,
      decidedAt: approval.decidedAt,
    });

    // Clean up after a delay
    setTimeout(() => pendingApprovals.delete(sessionKey), 60_000);
  } catch (err) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INTERNAL_ERROR, `Failed to resolve approval: ${String(err)}`),
    );
  }
}

/**
 * approval.get - Get status of an approval request
 */
async function approvalGet(
  params: {
    sessionKey: string;
  },
  respond: RespondFn,
) {
  try {
    const { sessionKey } = params;

    if (!sessionKey) {
      return respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Missing sessionKey"),
      );
    }

    const approval = pendingApprovals.get(sessionKey);
    if (!approval) {
      return respond(
        false,
        undefined,
        errorShape(ErrorCodes.NOT_FOUND, `Approval request not found: ${sessionKey}`),
      );
    }

    respond(true, approval);
  } catch (err) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INTERNAL_ERROR, `Failed to get approval status: ${String(err)}`),
    );
  }
}

export const modelApprovalsHandlers: GatewayRequestHandlers = {
  "approval.request": approvalRequest,
  "approval.resolve": approvalResolve,
  "approval.get": approvalGet,
};
