// HTTP endpoint adapter for invoking gateway tools from OpenAI-compatible clients.
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import {
  readJsonBodyOrError,
  sendJson,
  sendMethodNotAllowed,
  watchClientDisconnect,
} from "./http-common.js";
import {
  assertGatewayHttpRequestCurrent,
  type GatewayHttpRequestAuthOptions,
} from "./http-request-authority.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  getHeader,
  resolveSharedSecretHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
} from "./http-utils.js";
import { resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { invokeGatewayTool, type ToolsInvokeInput } from "./tools-invoke-shared.js";

const DEFAULT_BODY_BYTES = 2 * 1024 * 1024;

/** Handle `/tools/invoke` requests and return false when another HTTP route should handle them. */
export async function handleToolsInvokeHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: GatewayHttpRequestAuthOptions & {
    maxBodyBytes?: number;
    resolveGatewayContext?: GatewayContextResolver;
  },
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "bad_request", message: "Invalid request URL" }));
    return true;
  }
  if (url.pathname !== "/tools/invoke") {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  // /tools/invoke intentionally uses the same shared-secret HTTP trust model as
  // the OpenAI-compatible APIs: token/password bearer auth is full operator
  // access for the gateway, not a narrower per-request scope boundary.
  const authResult = await authorizeScopedGatewayHttpRequestOrReply({
    ...opts,
    req,
    res,
    operatorMethod: "agent",
    resolveOperatorScopes: resolveSharedSecretHttpOperatorScopes,
  });
  if (!authResult) {
    return true;
  }
  const { cfg, requestAuth, operatorScopes } = authResult;
  if (req.socket.destroyed || res.destroyed || res.socket?.destroyed) {
    return true;
  }
  const abortController = new AbortController();
  const operatorAccessAuthority = requestAuth.operatorAccessAuthority;
  const signal = operatorAccessAuthority
    ? AbortSignal.any([abortController.signal, operatorAccessAuthority.signal])
    : abortController.signal;
  const stopWatchingDisconnect = watchClientDisconnect(req, res, abortController);

  try {
    const bodyUnknown = await readJsonBodyOrError(
      req,
      res,
      opts.maxBodyBytes ?? DEFAULT_BODY_BYTES,
    );
    if (bodyUnknown === undefined || signal.aborted) {
      return true;
    }
    await requestAuth.revalidate();
    const body = (bodyUnknown ?? {}) as ToolsInvokeInput;

    // Resolve message channel/account hints (optional headers) for policy inheritance.
    const messageChannel = normalizeMessageChannel(
      getHeader(req, "x-openclaw-message-channel") ?? "",
    );
    const accountId = normalizeOptionalString(getHeader(req, "x-openclaw-account-id"));
    const agentTo = normalizeOptionalString(getHeader(req, "x-openclaw-message-to"));
    const agentThreadId = normalizeOptionalString(getHeader(req, "x-openclaw-thread-id"));
    const senderIsOwner = resolveOpenAiCompatibleHttpSenderIsOwner(req, requestAuth);
    const client = createSyntheticPluginRuntimeClient({
      authenticatedUserProfile: requestAuth.authenticatedUserProfile,
      operatorRoleActor: requestAuth.operatorRoleActor,
      operatorAccessAuthority,
      scopes: operatorScopes,
    });
    const context = opts.resolveGatewayContext?.();
    if (resolveGatewayOperatorRoleActor(client)?.kind === "operator" && !context) {
      sendJson(res, 503, {
        error: { message: "Gateway context is unavailable; retry shortly.", type: "unavailable" },
      });
      return true;
    }
    const outcome = await withPluginRuntimeGatewayRequestScope(
      {
        client,
        context,
        resolveGatewayContext: opts.resolveGatewayContext,
        signal,
        hasCurrentClientAuthority: () => !signal.aborted && requestAuth.hasCurrentClientAuthority(),
        isWebchatConnect: () => false,
      },
      () =>
        invokeGatewayTool({
          cfg,
          input: body,
          messageChannel: messageChannel ?? undefined,
          accountId,
          agentTo,
          agentThreadId,
          authenticatedUserProfile: requestAuth.authenticatedUserProfile,
          operatorRoleActor: requestAuth.operatorRoleActor,
          operatorScopes,
          senderIsOwner,
          conversationReadOrigin: "direct-operator",
          toolCallIdPrefix: "http",
          signal,
          assertInvocationCurrent: () => assertGatewayHttpRequestCurrent(requestAuth),
        }),
    );
    if (signal.aborted) {
      return true;
    }
    if (outcome.ok) {
      sendJson(res, outcome.status, { ok: true, result: outcome.result });
    } else {
      sendJson(res, outcome.status, { ok: false, error: outcome.error });
    }
  } catch (error) {
    if (!res.writableEnded && !res.destroyed) {
      throw error;
    }
  } finally {
    stopWatchingDisconnect();
    abortController.abort(new Error("HTTP tool invocation authority ended"));
  }

  return true;
}
