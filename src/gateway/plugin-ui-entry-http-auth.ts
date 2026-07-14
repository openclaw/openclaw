import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthorizedGatewayHttpRequest } from "./http-auth-utils.js";
import {
  consumePluginUiEntryPointLaunchToken,
  PLUGIN_UI_ENTRY_CONTEXT_TOKENS_HEADER,
  PLUGIN_UI_ENTRY_SESSION_KEY_HEADER,
  resolvePluginUiEntryPointSessionCookie,
} from "./plugin-ui-entry-launch-tokens.js";

type PluginUiEntryRequestAuth = {
  requestAuth: AuthorizedGatewayHttpRequest;
  scopes: string[];
};

type PluginUiEntryContext = {
  contextTokens?: number;
  sessionKey?: string;
};

function applyPluginUiEntryContextHeaders(
  req: IncomingMessage,
  context?: PluginUiEntryContext,
): void {
  delete req.headers[PLUGIN_UI_ENTRY_SESSION_KEY_HEADER];
  delete req.headers[PLUGIN_UI_ENTRY_CONTEXT_TOKENS_HEADER];
  const sessionKey = context?.sessionKey?.trim();
  if (sessionKey) {
    req.headers[PLUGIN_UI_ENTRY_SESSION_KEY_HEADER] = sessionKey;
  }
  if (typeof context?.contextTokens === "number" && Number.isFinite(context.contextTokens)) {
    req.headers[PLUGIN_UI_ENTRY_CONTEXT_TOKENS_HEADER] = String(Math.floor(context.contextTokens));
  }
}

export function clearUiEntryHeaders(req: IncomingMessage): void {
  applyPluginUiEntryContextHeaders(req);
}

export function authorizeUiEntryRequest(params: {
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
}): PluginUiEntryRequestAuth | undefined {
  const launchAuth = consumePluginUiEntryPointLaunchToken({ req: params.req, path: params.path });
  const entryAuth = launchAuth.ok
    ? launchAuth
    : resolvePluginUiEntryPointSessionCookie({ req: params.req, path: params.path });
  if (!entryAuth.ok) {
    return undefined;
  }
  params.req.headers["x-openclaw-scopes"] = entryAuth.scopes.join(",");
  applyPluginUiEntryContextHeaders(params.req, entryAuth);
  if (launchAuth.ok && launchAuth.setCookieHeader) {
    params.res.setHeader("Set-Cookie", launchAuth.setCookieHeader);
  }
  return {
    requestAuth: { authMethod: "device-token", trustDeclaredOperatorScopes: true },
    scopes: entryAuth.scopes,
  };
}
