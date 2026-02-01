/**
 * Token RPC handlers
 */

import { homedir } from "node:os";
import { listTokens, createToken, revokeToken, type TokenScope } from "../../infra/tokens/index.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const homeDir = homedir();

const VALID_SCOPES: TokenScope[] = [
  "agent:read",
  "agent:write",
  "config:read",
  "config:write",
  "audit:read",
  "sessions:read",
  "sessions:write",
  "*",
];

export const tokenHandlers: GatewayRequestHandlers = {
  "tokens.list": async ({ respond }) => {
    try {
      const tokens = await listTokens(homeDir);
      respond(true, { tokens }, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Failed to list tokens: ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
      );
    }
  },

  "tokens.create": async ({ params, respond }) => {
    const { name, scopes, expiresInDays } = params as {
      name?: string;
      scopes?: string[];
      expiresInDays?: number | null;
    };

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Token name is required"));
      return;
    }

    if (!scopes || !Array.isArray(scopes) || scopes.length === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "At least one scope is required"),
      );
      return;
    }

    // Validate scopes
    const invalidScopes = scopes.filter((s) => !VALID_SCOPES.includes(s as TokenScope));
    if (invalidScopes.length > 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Invalid scopes: ${invalidScopes.join(", ")}`),
      );
      return;
    }

    try {
      const result = await createToken(homeDir, {
        name: name.trim(),
        scopes: scopes as TokenScope[],
        expiresInDays: expiresInDays ?? undefined,
      });
      respond(true, result, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Failed to create token: ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
      );
    }
  },

  "tokens.revoke": async ({ params, respond }) => {
    const { tokenId } = params as { tokenId?: string };

    if (!tokenId || typeof tokenId !== "string") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Token ID is required"));
      return;
    }

    try {
      const result = await revokeToken(homeDir, tokenId);
      if (!result.success) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Token not found"));
        return;
      }
      respond(true, result, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Failed to revoke token: ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
      );
    }
  },
};
