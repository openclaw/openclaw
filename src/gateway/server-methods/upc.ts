import { Value } from "@sinclair/typebox/value";
import {
  UPCVerificationRequestSchema,
  UPCSetRequestSchema,
  UPCStatusResponseSchema,
  UPCApprovalRequestSchema,
  type UPCVerificationRequest,
  type UPCSetRequest,
  type UPCStatusResponse,
  type UPCApprovalRequest,
} from "../protocol/schema/upc.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { getGlobalUPCManager } from "../../security/upc-manager.js";
import { verifyUPCInput, markSessionVerified } from "../../agents/upc-verification.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const ADMIN_SCOPE = "operator.admin";

export const upcHandlers: GatewayRequestHandlers = {
  /**
   * Get current UPC status (without exposing credentials)
   */
  "upc.status": async ({ respond, client, context }) => {
    try {
      const upcManager = getGlobalUPCManager();
      const status = upcManager.getStatus();

      const response: UPCStatusResponse = {
        enabled: status.enabled,
        hasUPC: status.hasUPC,
        isLocked: status.isLocked,
      };

      respond(true, response, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `Failed to get UPC status: ${String(err)}`),
      );
    }
  },

  /**
   * Set or update the UPC credential
   * Requires admin scope for security
   */
  "upc.set": async ({ respond, client, params, context }) => {
    try {
      // Check admin scope
      const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
      if (!scopes.includes(ADMIN_SCOPE)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.FORBIDDEN, "UPC configuration requires admin scope"),
        );
        return;
      }

      assertValidParams(params, UPCSetRequestSchema, respond);

      const setRequest = params as UPCSetRequest;
      const upcManager = getGlobalUPCManager();

      try {
        upcManager.setUPC(setRequest.credential);
        respond(true, { success: true }, undefined);
      } catch (err) {
        respond(
          false,
          { success: false, error: String(err) },
          errorShape(ErrorCodes.INVALID_ARGUMENT, String(err)),
        );
      }
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `Failed to set UPC: ${String(err)}`),
      );
    }
  },

  /**
   * Disable UPC protection
   * Requires admin scope for security
   */
  "upc.disable": async ({ respond, client, params, context }) => {
    try {
      // Check admin scope
      const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
      if (!scopes.includes(ADMIN_SCOPE)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.FORBIDDEN, "UPC configuration requires admin scope"),
        );
        return;
      }

      const upcManager = getGlobalUPCManager();
      upcManager.disableUPC();

      respond(true, { success: true }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `Failed to disable UPC: ${String(err)}`),
      );
    }
  },

  /**
   * Verify a UPC credential attempt
   * Required for accessing high-risk tasks when UPC is enabled
   */
  "upc.verify": async ({ respond, client, params, context }) => {
    try {
      assertValidParams(params, UPCVerificationRequestSchema, respond);

      const verifyRequest = params as UPCVerificationRequest;
      const sessionId = client?.connect?.sessionId || "anonymous";

      const result = verifyUPCInput(verifyRequest.upcInput, sessionId, verifyRequest.taskName);

      if (result.verified) {
        // Mark session as verified for future tool calls
        markSessionVerified(sessionId);
      }

      respond(true, result, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `UPC verification failed: ${String(err)}`),
      );
    }
  },

  /**
   * Create UPC approval request (for UI integration with approval flow)
   */
  "upc.approval.create": async ({ respond, client, params, context }) => {
    try {
      const upcManager = getGlobalUPCManager();

      // If UPC is not enabled, no approval needed
      if (!upcManager.isEnabled()) {
        respond(true, { id: "not-needed" }, undefined);
        return;
      }

      const taskName = typeof params?.taskName === "string" ? params.taskName : "unknown";
      const taskDescription = typeof params?.taskDescription === "string" ? params.taskDescription : undefined;

      const approval: UPCApprovalRequest = {
        id: `upc-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        taskName,
        taskDescription,
        createdAtMs: Date.now(),
      };

      respond(true, approval, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `Failed to create approval: ${String(err)}`),
      );
    }
  },

  /**
   * Get UPC audit log (admin only)
   */
  "upc.audit-log": async ({ respond, client, params, context }) => {
    try {
      // Check admin scope
      const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
      if (!scopes.includes(ADMIN_SCOPE)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.FORBIDDEN, "Audit log access requires admin scope"),
        );
        return;
      }

      const upcManager = getGlobalUPCManager();
      const limit = typeof params?.limit === "number" ? Math.min(params.limit, 1000) : 50;
      const auditLog = upcManager.getAuditLog(limit);

      respond(true, { entries: auditLog }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `Failed to get audit log: ${String(err)}`),
      );
    }
  },
};
