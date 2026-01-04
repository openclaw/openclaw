import { defaultRuntime } from "../../runtime.js";
import { startWebLoginWithQr, waitForWebLogin } from "../../web/login-qr.js";
import { logoutWeb } from "../../web/session.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateWebLoginStartParams,
  validateWebLoginWaitParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

export const webHandlers: GatewayRequestHandlers = {
  "web.login.start": async ({ params, respond, context }) => {
    if (!validateWebLoginStartParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid web.login.start params: ${formatValidationErrors(validateWebLoginStartParams.errors)}`,
        ),
      );
      return;
    }
    try {
      await context.stopWhatsAppProvider();
      const result = await startWebLoginWithQr({
        force: Boolean((params as { force?: boolean }).force),
        timeoutMs:
          typeof (params as { timeoutMs?: unknown }).timeoutMs === "number"
            ? (params as { timeoutMs?: number }).timeoutMs
            : undefined,
        verbose: Boolean((params as { verbose?: boolean }).verbose),
      });
      respond(true, result, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      );
    }
  },
  "web.login.wait": async ({ params, respond, context }) => {
    if (!validateWebLoginWaitParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid web.login.wait params: ${formatValidationErrors(validateWebLoginWaitParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const result = await waitForWebLogin({
        timeoutMs:
          typeof (params as { timeoutMs?: unknown }).timeoutMs === "number"
            ? (params as { timeoutMs?: number }).timeoutMs
            : undefined,
      });
      if (result.connected) {
        await context.startWhatsAppProvider();
      }
      respond(true, result, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      );
    }
  },
  "web.logout": async ({ respond, context }) => {
    try {
      await context.stopWhatsAppProvider();
      const cleared = await logoutWeb(defaultRuntime);
      context.markWhatsAppLoggedOut(cleared);
      respond(true, { cleared }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      );
    }
  },
};
