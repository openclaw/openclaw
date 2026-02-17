import type { GatewayRequestHandlers } from "./types.js";
import { loadConfig } from "../../config/config.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

export const quotaHandlers: GatewayRequestHandlers = {
  "quota.status": async ({ params, respond }) => {
    const customerId = typeof params.customerId === "string" ? params.customerId.trim() : null;
    if (!customerId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "customerId is required"));
      return;
    }

    const config = loadConfig();
    if (!config.quota?.enabled) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "quota is not enabled"));
      return;
    }

    try {
      const { checkQuota } = await import("../../quota/index.js");
      const status = await checkQuota(customerId, config);
      if (!status) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `No quota configuration for customer: ${customerId}`,
          ),
        );
        return;
      }
      respond(true, status, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
