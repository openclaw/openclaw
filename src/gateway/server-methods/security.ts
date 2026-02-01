/**
 * Security RPC handlers
 */

import { homedir } from "node:os";
import {
  getSecurityState,
  setupPassword,
  changePassword,
  unlock,
  lockApp,
  disableLock,
  setup2fa,
  verify2fa,
  disable2fa,
  getSecurityHistory,
} from "../../infra/security/index.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const homeDir = homedir();

export const securityHandlers: GatewayRequestHandlers = {
  "security.getState": async ({ respond }) => {
    try {
      const state = await getSecurityState(homeDir);
      respond(true, state, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Failed to get security state: ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
      );
    }
  },

  "security.setupPassword": async ({ params, respond }) => {
    const { password } = params as { password?: string };

    if (!password || typeof password !== "string") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Password is required"));
      return;
    }

    if (password.length < 8) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Password must be at least 8 characters"),
      );
      return;
    }

    try {
      const result = await setupPassword(homeDir, password);
      respond(true, result, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Failed to setup password: ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
      );
    }
  },

  "security.changePassword": async ({ params, respond }) => {
    const { currentPassword, newPassword } = params as {
      currentPassword?: string;
      newPassword?: string;
    };

    if (!currentPassword || !newPassword) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Both current and new passwords are required"),
      );
      return;
    }

    if (newPassword.length < 8) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "New password must be at least 8 characters"),
      );
      return;
    }

    try {
      const result = await changePassword(homeDir, currentPassword, newPassword);
      if (!result.success) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Current password is incorrect"),
        );
        return;
      }
      respond(true, result, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Failed to change password: ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
      );
    }
  },

  "security.unlock": async ({ params, req, respond }) => {
    const { password, totpCode, recoveryCode } = params as {
      password?: string;
      totpCode?: string;
      recoveryCode?: string;
    };

    if (!password) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Password is required"));
      return;
    }

    // Extract IP and user agent from request if available
    const ipAddress = undefined; // Would come from HTTP headers in real implementation
    const userAgent = undefined;

    try {
      const result = await unlock(homeDir, password, totpCode, recoveryCode, ipAddress, userAgent);
      respond(true, result, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Failed to unlock: ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
      );
    }
  },

  "security.lock": async ({ respond }) => {
    try {
      const result = lockApp();
      respond(true, result, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Failed to lock: ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
      );
    }
  },

  "security.disable": async ({ params, respond }) => {
    const { password } = params as { password?: string };

    if (!password) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Password is required"));
      return;
    }

    try {
      const result = await disableLock(homeDir, password);
      if (!result.success) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Password is incorrect"));
        return;
      }
      respond(true, result, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Failed to disable lock: ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
      );
    }
  },

  "security.setup2fa": async ({ params, respond }) => {
    const { password } = params as { password?: string };

    if (!password) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Password is required"));
      return;
    }

    try {
      const result = await setup2fa(homeDir, password);
      if (!result.success) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Password is incorrect"));
        return;
      }
      respond(true, result, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Failed to setup 2FA: ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
      );
    }
  },

  "security.verify2fa": async ({ params, respond }) => {
    const { code } = params as { code?: string };

    if (!code) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Verification code is required"),
      );
      return;
    }

    try {
      const result = await verify2fa(homeDir, code);
      respond(true, result, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Failed to verify 2FA: ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
      );
    }
  },

  "security.disable2fa": async ({ params, respond }) => {
    const { password, code } = params as { password?: string; code?: string };

    if (!password || !code) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Password and verification code are required"),
      );
      return;
    }

    try {
      const result = await disable2fa(homeDir, password, code);
      if (!result.success) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Password or code is incorrect"),
        );
        return;
      }
      respond(true, result, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Failed to disable 2FA: ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
      );
    }
  },

  "security.getHistory": async ({ params, respond }) => {
    const { limit, offset } = params as { limit?: number; offset?: number };

    try {
      const result = await getSecurityHistory(homeDir, {
        limit: limit ?? 50,
        offset: offset ?? 0,
      });
      respond(true, result, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Failed to get history: ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
      );
    }
  },
};
