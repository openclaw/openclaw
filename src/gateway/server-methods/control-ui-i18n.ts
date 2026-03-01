import {
  ErrorCodes,
  errorShape,
  validateControlUiI18nGenerateParams,
  validateControlUiI18nGetParams,
  validateControlUiI18nListParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function mapControlUiI18nError(err: unknown): {
  code: (typeof ErrorCodes)[keyof typeof ErrorCodes];
  message: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (
    lower.includes("invalid locale") ||
    lower.includes("locale is required") ||
    lower.includes("locale too long") ||
    lower.includes("not found")
  ) {
    return { code: ErrorCodes.INVALID_REQUEST, message };
  }
  return { code: ErrorCodes.UNAVAILABLE, message };
}

export const controlUiI18nHandlers: GatewayRequestHandlers = {
  "controlui.i18n.list": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateControlUiI18nListParams, "controlui.i18n.list", respond)
    ) {
      return;
    }
    try {
      if (!context.controlUiI18n) {
        throw new Error("control UI i18n service unavailable");
      }
      respond(true, await context.controlUiI18n.list(), undefined);
    } catch (err) {
      const mapped = mapControlUiI18nError(err);
      respond(false, undefined, errorShape(mapped.code, mapped.message));
    }
  },
  "controlui.i18n.get": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateControlUiI18nGetParams, "controlui.i18n.get", respond)) {
      return;
    }
    try {
      if (!context.controlUiI18n) {
        throw new Error("control UI i18n service unavailable");
      }
      respond(true, await context.controlUiI18n.get(params.locale), undefined);
    } catch (err) {
      const mapped = mapControlUiI18nError(err);
      respond(false, undefined, errorShape(mapped.code, mapped.message));
    }
  },
  "controlui.i18n.generate": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(
        params,
        validateControlUiI18nGenerateParams,
        "controlui.i18n.generate",
        respond,
      )
    ) {
      return;
    }
    try {
      if (!context.controlUiI18n) {
        throw new Error("control UI i18n service unavailable");
      }
      const result = await context.controlUiI18n.generate({
        locale: params.locale,
        force: params.force,
        requesterConnId: client?.connId,
      });
      respond(true, result, undefined);
    } catch (err) {
      const mapped = mapControlUiI18nError(err);
      respond(false, undefined, errorShape(mapped.code, mapped.message));
    }
  },
};
