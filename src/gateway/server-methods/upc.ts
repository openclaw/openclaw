import { Value } from "@sinclair/typebox/value";
import { getGlobalUPCManager } from "../../security/upc-manager.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  UPCVerificationRequestSchema,
  UPCSetRequestSchema,
  type UPCVerificationRequest,
  type UPCSetRequest,
  type UPCStatusResponse,
  type UPCApprovalRequest,
} from "../protocol/schema/upc.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

const ADMIN_SCOPE = "operator.admin";

const validateUpcSetParams: Validator<UPCSetRequest> = ((
  candidate: unknown,
): candidate is UPCSetRequest =>
  Value.Check(UPCSetRequestSchema, candidate)) as Validator<UPCSetRequest>;

const validateUpcVerificationParams: Validator<UPCVerificationRequest> = ((
  candidate: unknown,
): candidate is UPCVerificationRequest =>
  Value.Check(UPCVerificationRequestSchema, candidate)) as Validator<UPCVerificationRequest>;

export const upcHandlers: GatewayRequestHandlers = {
  /**
   * Get current UPC status (without exposing credentials)
   */
  "upc.status": async ({ respond, context }) => {
    try {
      const upcManager = context.upcManager ?? getGlobalUPCManager();
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
        errorShape(ErrorCodes.UNAVAILABLE, `Failed to get UPC status: ${String(err)}`),
      );
    }
  },

  /**
   * Set or update the UPC credential
   * Requires admin scope for security
   */
  "upc.set": async ({ respond, client, params, context }) => {
    try {
      const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
      if (!scopes.includes(ADMIN_SCOPE)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "UPC configuration requires admin scope"),
        );
        return;
      }

      if (!assertValidParams(params, validateUpcSetParams, "upc.set", respond)) {
        return;
      }

      const setRequest = params;
      const upcManager = context.upcManager ?? getGlobalUPCManager();

      try {
        upcManager.setUPC(setRequest.credential);
        respond(true, { success: true }, undefined);
      } catch (err) {
        respond(
          false,
          { success: false, error: String(err) },
          errorShape(ErrorCodes.INVALID_REQUEST, String(err)),
        );
      }
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `Failed to set UPC: ${String(err)}`),
      );
    }
  },

  /**
   * Clear cached UPC verification/rate-limit state while keeping credential.
   * Requires admin scope for security.
   */
  "upc.clear": async ({ respond, client, context }) => {
    try {
      const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
      if (!scopes.includes(ADMIN_SCOPE)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "UPC configuration requires admin scope"),
        );
        return;
      }

      const upcManager = context.upcManager ?? getGlobalUPCManager();
      upcManager.clearAllVerifications();

      respond(true, { success: true }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Failed to reset UPC verification state: ${String(err)}`,
        ),
      );
    }
  },

  /**
   * Disable UPC protection
   * Requires admin scope for security
   */
  "upc.disable": async ({ respond, client, context }) => {
    try {
      const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
      if (!scopes.includes(ADMIN_SCOPE)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "UPC configuration requires admin scope"),
        );
        return;
      }

      const upcManager = context.upcManager ?? getGlobalUPCManager();
      upcManager.disableUPC();

      respond(true, { success: true }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `Failed to disable UPC: ${String(err)}`),
      );
    }
  },

  /**
   * Verify a UPC credential attempt
   * Required for accessing high-risk tasks when UPC is enabled
   */
  "upc.verify": async ({ respond, client, params, context }) => {
    try {
      if (!assertValidParams(params, validateUpcVerificationParams, "upc.verify", respond)) {
        return;
      }

      const verifyRequest = params;
      const sessionId = client?.connId ?? client?.clientIp ?? "anonymous:unknown";
      const upcManager = context.upcManager ?? getGlobalUPCManager();
      const result = upcManager.verifyUPC(verifyRequest.upcInput, sessionId);

      if (result.verified) {
        upcManager.markSessionVerified(sessionId);
      }

      respond(true, result, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `UPC verification failed: ${String(err)}`),
      );
    }
  },

  /**
   * Create UPC approval request (for UI integration with approval flow)
   */
  "upc.approval.create": async ({ respond, params, context }) => {
    try {
      const upcManager = context.upcManager ?? getGlobalUPCManager();

      if (!upcManager.isEnabled()) {
        respond(true, { id: "not-needed" }, undefined);
        return;
      }

      const taskName = typeof params?.taskName === "string" ? params.taskName : "unknown";
      const taskDescription =
        typeof params?.taskDescription === "string" ? params.taskDescription : undefined;

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
        errorShape(ErrorCodes.UNAVAILABLE, `Failed to create approval: ${String(err)}`),
      );
    }
  },

  /**
   * Get UPC audit log (admin only)
   */
  "upc.audit-log": async ({ respond, client, params, context }) => {
    try {
      const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
      if (!scopes.includes(ADMIN_SCOPE)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Audit log access requires admin scope"),
        );
        return;
      }

      const upcManager = context.upcManager ?? getGlobalUPCManager();
      const limit = typeof params?.limit === "number" ? Math.min(params.limit, 1000) : 50;
      const auditLog = upcManager.getAuditLog(limit);

      respond(true, { entries: auditLog }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `Failed to get audit log: ${String(err)}`),
      );
    }
  },
};
