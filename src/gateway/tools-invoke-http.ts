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
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import { authorizeScopedGatewayHttpRequestOrReply, getHeader } from "./http-utils.js";
import { prepareGatewayHttpOperatorRunAuthority } from "./operator-run-authority.js";
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
  const url = URL.parse(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (!url) {
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

  // /tools/invoke uses the same HTTP trust model as the OpenAI-compatible APIs: the request is
  // admitted once as the principal its credential names (the shared token or password names the
  // Gateway owner) and the tool runs with that admitted grant.
  const authResult = await authorizeScopedGatewayHttpRequestOrReply({
    ...opts,
    req,
    res,
    operatorMethod: "agent",
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
  // Admitted once above; operator access revocation applies to the next request.
  const signal = abortController.signal;
  const stopWatchingDisconnect = watchClientDisconnect(req, res, abortController);
  let releaseAdmission: (() => void) | undefined;

  try {
    const bodyUnknown = await readJsonBodyOrError(
      req,
      res,
      opts.maxBodyBytes ?? DEFAULT_BODY_BYTES,
    );
    if (bodyUnknown === undefined || signal.aborted) {
      return true;
    }
    const body = (bodyUnknown ?? {}) as ToolsInvokeInput;

    // Resolve message channel/account hints (optional headers) for policy inheritance.
    const messageChannel = normalizeMessageChannel(
      getHeader(req, "x-openclaw-message-channel") ?? "",
    );
    const accountId = normalizeOptionalString(getHeader(req, "x-openclaw-account-id"));
    const agentTo = normalizeOptionalString(getHeader(req, "x-openclaw-message-to"));
    const agentThreadId = normalizeOptionalString(getHeader(req, "x-openclaw-thread-id"));
    const context = opts.resolveGatewayContext?.();
    if ((requestAuth.authenticatedUserProfile || requestAuth.openclawIdPrincipal) && !context) {
      sendJson(res, 503, {
        error: { message: "Gateway context is unavailable; retry shortly.", type: "unavailable" },
      });
      return true;
    }
    const principal = {
      authenticatedUserProfile: requestAuth.authenticatedUserProfile,
      operatorRoleActor: requestAuth.operatorRoleActor,
      openclawIdPrincipal: requestAuth.openclawIdPrincipal,
      operatorAccessAuthority,
    };
    const admitted = context
      ? await prepareGatewayHttpOperatorRunAuthority({
          client: createSyntheticPluginRuntimeClient({ ...principal, scopes: operatorScopes }),
          context: { ...context, resolveGatewayContext: opts.resolveGatewayContext },
          sourceAuthority: operatorAccessAuthority,
          hasCurrentClientAuthority: requestAuth.hasCurrentClientAuthority,
        })
      : undefined;
    releaseAdmission = admitted?.release;
    const authority = admitted?.authority;
    const client = createSyntheticPluginRuntimeClient({
      ...principal,
      operatorRunAuthority: authority,
      scopes: authority ? [...authority.scopes] : operatorScopes,
    });
    const outcome = await withPluginRuntimeGatewayRequestScope(
      {
        client,
        context,
        resolveGatewayContext: opts.resolveGatewayContext,
        signal,
        hasCurrentClientAuthority: () => !signal.aborted,
        isWebchatConnect: () => false,
        pluginRegistry: context?.getGatewayMethodRegistry?.().pluginRegistry,
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
          openclawIdPrincipal: requestAuth.openclawIdPrincipal,
          operatorScopes: client.connect.scopes,
          senderIsOwner: authority?.grant.owner,
          conversationReadOrigin: "direct-operator",
          toolCallIdPrefix: "http",
          signal,
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
    releaseAdmission?.();
    abortController.abort(new Error("HTTP tool invocation authority ended"));
  }

  return true;
}
