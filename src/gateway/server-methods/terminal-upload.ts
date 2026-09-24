import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  type TerminalUploadParams,
  validateTerminalUploadParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { isCanonicalTerminalUploadBase64 } from "../../../packages/gateway-protocol/src/schema/terminal-constants.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function invalid(respond: GatewayRequestHandlerOptions["respond"], detail: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, detail));
}

export const terminalUploadHandlers: GatewayRequestHandlers = {
  "terminal.upload": async (opts) => {
    const { params, respond, context } = opts;
    if (!assertValidParams(params, validateTerminalUploadParams, "terminal.upload", respond)) {
      return;
    }
    const connId = opts.client?.connId;
    if (!connId) {
      invalid(respond, "terminal requires an authenticated connection");
      return;
    }
    const p = params as TerminalUploadParams;
    if (!isCanonicalTerminalUploadBase64(p.contentBase64)) {
      invalid(respond, "invalid terminal.upload base64 content");
      return;
    }
    if (!context.terminalSessions || !context.isTerminalEnabled()) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "terminal is not available"));
      return;
    }
    try {
      const result = await context.terminalSessions.upload(connId, p.sessionId, {
        name: p.name,
        contentBase64: p.contentBase64,
      });
      if (!result) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown terminal session "${p.sessionId}"`),
        );
        return;
      }
      respond(true, {
        path: result.path,
        size: result.size,
        ...(result.uploadPathStyle &&
        hasGatewayClientCap(
          opts.client?.connect?.caps,
          GATEWAY_CLIENT_CAPS.TERMINAL_UPLOAD_PATH_STYLE,
        )
          ? { uploadPathStyle: result.uploadPathStyle }
          : {}),
      });
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          error instanceof Error ? error.message : "terminal upload failed",
        ),
      );
    }
  },
};
