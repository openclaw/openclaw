import {
  exchangeOpenAICodexAuthorizationCode,
  startOpenAICodexAuthorizationFlow,
} from "../../openai-codex/connect-flow.js";
import {
  buildFailedBeforeCallbackRecord,
  buildOpenAICodexConnectStatus,
  canManageOpenAICodex,
  deleteOpenAICodexPendingConnect,
  disconnectOpenAICodex,
  readOpenAICodexPendingConnect,
  resolveOpenAICodexPendingLifecycle,
  writeOpenAICodexPendingConnect,
} from "../../openai-codex/connect-store.js";
import { writeOAuthCredentials } from "../../plugins/provider-auth-helpers.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function readRedirectUri(params: Record<string, unknown>): string | null {
  const redirectUri = typeof params.redirectUri === "string" ? params.redirectUri.trim() : "";
  if (!redirectUri) {
    return null;
  }
  try {
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function requireOwnerScope(client: { connect?: { scopes?: string[] } } | null) {
  if (!canManageOpenAICodex(client)) {
    return errorShape(ErrorCodes.UNAUTHORIZED, "OpenAI Codex connect requires tenant owner access");
  }
  return null;
}

export const codexHandlers: GatewayRequestHandlers = {
  "codex.connect.status": async ({ client, context, respond }) => {
    let pending = await readOpenAICodexPendingConnect();
    if (pending) {
      const lifecycle = resolveOpenAICodexPendingLifecycle(pending);
      if (
        lifecycle.stage === "failed_before_callback" &&
        pending.stage !== "failed_before_callback"
      ) {
        pending = buildFailedBeforeCallbackRecord(pending);
        await writeOpenAICodexPendingConnect(pending);
        context.logGateway.warn(
          `codex-connect: marked stale pending auth as failed-before-callback startedAt=${pending.startedAt} requestedBy=${pending.requestedBy ?? "n/a"}`,
        );
      }
    }
    respond(true, buildOpenAICodexConnectStatus({ pending, client }), undefined);
  },
  "codex.connect.start": async ({ params, client, context, respond }) => {
    const unauthorized = requireOwnerScope(client);
    if (unauthorized) {
      respond(false, undefined, unauthorized);
      return;
    }
    const browserReturnTo = readRedirectUri(params);
    if (!browserReturnTo) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "redirectUri must be a valid http(s) URL"),
      );
      return;
    }
    const flow = await startOpenAICodexAuthorizationFlow({ browserReturnTo });
    await writeOpenAICodexPendingConnect({
      version: 2,
      redirectUri: flow.redirectUri,
      state: flow.state,
      codeVerifier: flow.codeVerifier,
      startedAt: new Date().toISOString(),
      requestedBy:
        typeof client?.connect?.client?.displayName === "string"
          ? client.connect.client.displayName
          : null,
      stage: "browser_flow_started",
      callbackReceivedAt: null,
      lastFailureAt: null,
      lastError: null,
    });
    const authorizeHost = new URL(flow.authorizeUrl).host;
    context.logGateway.info(
      `codex-connect: start authorizeHost=${authorizeHost} redirectUri=${flow.redirectUri} browserReturnTo=${browserReturnTo}`,
    );
    respond(true, { authorizeUrl: flow.authorizeUrl, state: flow.state }, undefined);
  },
  "codex.connect.complete": async ({ params, client, context, respond }) => {
    const unauthorized = requireOwnerScope(client);
    if (unauthorized) {
      respond(false, undefined, unauthorized);
      return;
    }
    const code = typeof params.code === "string" ? params.code.trim() : "";
    const state = typeof params.state === "string" ? params.state.trim() : "";
    if (!code || !state) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "code and state are required"),
      );
      return;
    }
    const pending = await readOpenAICodexPendingConnect();
    if (!pending || pending.state !== state) {
      context.logGateway.warn(
        `codex-connect: complete rejected stateMismatch pending=${pending ? "present" : "missing"} callbackState=${state || "n/a"}`,
      );
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "missing or mismatched pending OpenAI Codex state"),
      );
      return;
    }
    const callbackReceivedAt = new Date().toISOString();
    const callbackPending = {
      ...pending,
      version: 2 as const,
      stage: "callback_received" as const,
      callbackReceivedAt,
      lastFailureAt: null,
      lastError: null,
    };
    await writeOpenAICodexPendingConnect(callbackPending);
    context.logGateway.info(
      `codex-connect: callback received redirectUri=${pending.redirectUri} callbackReceivedAt=${callbackReceivedAt} codePresent=yes`,
    );
    try {
      const credentials = await exchangeOpenAICodexAuthorizationCode({
        code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
      });
      await writeOAuthCredentials("openai-codex", credentials);
      await deleteOpenAICodexPendingConnect();
      context.logGateway.info(
        `codex-connect: token exchange succeeded accountId=${credentials.accountId} expiresAt=${new Date(credentials.expires).toISOString()}`,
      );
      respond(true, buildOpenAICodexConnectStatus({ pending: null, client }), undefined);
    } catch (err) {
      const failureAt = new Date().toISOString();
      const failureMessage = err instanceof Error ? err.message : String(err);
      await writeOpenAICodexPendingConnect({
        ...callbackPending,
        stage: "failed_token_exchange",
        lastFailureAt: failureAt,
        lastError: failureMessage,
      });
      context.logGateway.warn(
        `codex-connect: token exchange failed redirectUri=${pending.redirectUri} failureAt=${failureAt} error=${failureMessage}`,
      );
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, failureMessage, { retryable: true }),
      );
    }
  },
  "codex.connect.disconnect": async ({ client, context, respond }) => {
    const unauthorized = requireOwnerScope(client);
    if (unauthorized) {
      respond(false, undefined, unauthorized);
      return;
    }
    await Promise.all([disconnectOpenAICodex(), deleteOpenAICodexPendingConnect()]);
    context.logGateway.info("codex-connect: disconnected and cleared pending state");
    respond(true, buildOpenAICodexConnectStatus({ pending: null, client }), undefined);
  },
};
