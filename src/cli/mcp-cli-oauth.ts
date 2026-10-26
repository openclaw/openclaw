import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { operatorMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import type { McpOAuthLoginLifecycle } from "../agents/mcp-oauth-provider.js";
import { completeMcpOAuthAuthorization, startMcpOAuthAuthorization } from "../agents/mcp-oauth.js";
import { resolveMcpTransportConfig } from "../agents/mcp-transport-config.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  startOAuthLoopbackCallbackServer,
  type OAuthLoopbackCallbackServer,
} from "../infra/oauth-loopback-callback.js";
import { defaultRuntime } from "../runtime.js";
import { formatCliCommand } from "./command-format.js";

const MCP_OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export async function loginMcpServer(params: {
  name: string;
  server: Record<string, unknown>;
  code?: string;
  owner: Pick<McpOAuthLoginLifecycle, "signal" | "assertCurrent">;
  fail: (message: string) => never;
}): Promise<void> {
  const { name, server, code, owner, fail } = params;
  if (asRecord(server.oauth)?.identity === "per-requester") {
    return fail(
      `MCP server "${name}" uses per-requester OAuth. Senders connect from the channel via the MCP connect flow.`,
    );
  }
  if (server.auth !== "oauth") {
    return fail(`MCP server "${name}" is not configured with auth: "oauth".`);
  }
  if (typeof server.url !== "string" || server.url.trim().length === 0) {
    return fail(`MCP server "${name}" needs a URL for OAuth login.`);
  }
  const resolved = resolveMcpTransportConfig(name, server);
  if (!resolved || resolved.kind !== "http") {
    return fail(`MCP server "${name}" needs a valid HTTP transport for OAuth login.`);
  }
  const identity = operatorMcpOAuthIdentity(name, resolved.url);
  if (code) {
    owner.assertCurrent();
    await completeMcpOAuthAuthorization(identity, resolved, {
      code,
    });
    defaultRuntime.log(`MCP OAuth credentials saved for "${name}".`);
    return;
  }

  let callbackServer: OAuthLoopbackCallbackServer | undefined;
  const manualCommand = formatCliCommand(`openclaw mcp login ${name} --code <code>`);
  try {
    owner.assertCurrent();
    const session = await startMcpOAuthAuthorization(identity, resolved, {});
    owner.assertCurrent();
    if (session.status === "authorized") {
      defaultRuntime.log(`MCP OAuth credentials saved for "${name}".`);
      return;
    }
    if (session.state.length >= 16) {
      try {
        callbackServer = await startOAuthLoopbackCallbackServer({
          redirectUrl: session.redirectUrl,
          expectedState: session.state,
          timeoutMs: MCP_OAUTH_CALLBACK_TIMEOUT_MS,
          signal: owner.signal,
        });
      } catch (error) {
        defaultRuntime.log(
          `Could not start the local OAuth callback (${formatErrorMessage(error)}).`,
        );
      }
    }
    defaultRuntime.log(`Open this URL to authorize "${name}":`);
    defaultRuntime.log(session.authorizationUrl);
    if (callbackServer) {
      defaultRuntime.log("Waiting for the browser to return to OpenClaw...");
      defaultRuntime.log(
        `If the callback cannot reach this terminal, cancel this attempt, then run ${manualCommand}.`,
      );
    } else {
      defaultRuntime.log(`After approval, run ${manualCommand}.`);
    }
    if (!callbackServer) {
      return;
    }

    let callback;
    try {
      callback = await callbackServer.waitForCallback();
    } catch (error) {
      return fail(`${formatErrorMessage(error)}. Complete login manually with ${manualCommand}.`);
    }
    if (callback.type === "oauth_error") {
      return fail(`OAuth authorization did not complete. Retry login or use ${manualCommand}.`);
    }
    owner.assertCurrent();
    await completeMcpOAuthAuthorization(identity, resolved, {
      code: callback.code,
    });
    defaultRuntime.log(`MCP OAuth credentials saved for "${name}".`);
  } finally {
    await callbackServer?.close();
  }
}
