/**
 * Audit RPC handlers
 */

import { homedir } from "node:os";
import { queryAuditEvents, type AuditQueryParams } from "../../infra/audit/index.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const homeDir = homedir();

export const auditHandlers: GatewayRequestHandlers = {
  "audit.query": async ({ params, respond }) => {
    const { category, action, severity, startTs, endTs, limit, offset } =
      params as AuditQueryParams;

    try {
      const result = await queryAuditEvents(homeDir, {
        category,
        action,
        severity,
        startTs,
        endTs,
        limit: limit ?? 100,
        offset: offset ?? 0,
      });
      respond(true, result, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Failed to query audit log: ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
      );
    }
  },
};
