import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  validateChatStartupParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { withPreparedSessionResolve } from "../sessions-resolve.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { assertValidParams } from "./validation.js";

export async function handleChatStartupRequest(
  opts: GatewayRequestHandlerOptions,
  handleHistory: (
    opts: GatewayRequestHandlerOptions & { method: "chat.history" | "chat.startup" },
  ) => Promise<void>,
  respondUnavailable: (
    method: "chat.history" | "chat.startup",
    respond: GatewayRequestHandlerOptions["respond"],
    message: string,
  ) => void,
) {
  if (!assertValidParams(opts.params, validateChatStartupParams, "chat.startup", opts.respond)) {
    return;
  }
  if ("sessionKey" in opts.params) {
    await handleHistory({ ...opts, method: "chat.startup" });
    return;
  }
  const connId = opts.client?.connId?.trim();
  if (connId) {
    // This snapshot precedes pane mount. Enroll the connection before any read
    // so a concurrent sessions.subscribe cannot leave a gap in live delivery.
    opts.context.subscribeSessionEvents(connId);
    if (!opts.context.getSessionEventSubscriberConnIds().has(connId)) {
      opts.respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "connection closed before chat startup"),
      );
      return;
    }
  }
  const { shortId, slugHint, agentId, limit, maxBytes } = opts.params;
  const projection = getSessionRowProjection(opts.context);
  if (!projection) {
    respondUnavailable(
      "chat.startup",
      opts.respond,
      "session rows are initializing; reload the conversation",
    );
    return;
  }
  const resolution = await withPreparedSessionResolve(
    {
      projection,
      client: opts.client,
      p: { shortId, slugHint, agentId, allowMissing: true },
      isCurrent: () => getSessionRowProjection(opts.context) === projection,
    },
    (resolved) => {
      opts.sessionMutationAuthorization?.assertCurrent();
      if (!resolved.ok) {
        opts.respond(false, undefined, resolved.error);
        return undefined;
      }
      if ("missing" in resolved || "ambiguous" in resolved) {
        opts.respond(true, {
          resolution: {
            ok: false,
            ...("ambiguous" in resolved ? { candidates: resolved.candidates } : {}),
          },
        });
        return undefined;
      }
      return resolved;
    },
  );
  if (!resolution) {
    return;
  }
  await handleHistory({
    ...opts,
    params: { sessionKey: resolution.key, agentId: resolution.agentId, limit, maxBytes },
    method: "chat.startup",
    respond: (ok, payload, error, meta) =>
      opts.respond(ok, ok ? { ...asOptionalRecord(payload), resolution } : payload, error, meta),
  });
}
