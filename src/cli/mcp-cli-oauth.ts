import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { Command } from "commander";
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

export type McpLoginOptions = { code?: string; issuer?: string };

export function registerMcpLoginCommand(
  mcp: Command,
  action: (name: string, options: McpLoginOptions) => Promise<void>,
): void {
  mcp
    .command("login")
    .description("Authorize an OAuth MCP server")
    .argument("<name>", "MCP server name")
    .option("--code <code>", "Authorization code from the OAuth redirect")
    .option("--issuer <iss>", "Exact iss value from the same OAuth redirect (with --code)")
    .action(action);
}

export async function loginMcpServer(
  params: McpLoginOptions & {
    name: string;
    server: Record<string, unknown>;
    owner: Pick<McpOAuthLoginLifecycle, "signal" | "assertCurrent">;
    fail: (message: string) => never;
  },
): Promise<void> {
  const { name, server, code, issuer, owner, fail } = params;
  if (issuer !== undefined && !code) {
    return fail("--issuer requires --code from the same OAuth callback.");
  }
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
      ...(issuer === undefined ? {} : { iss: issuer }),
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
    defaultRuntime.log(
      "If the callback URL includes iss, pass its exact value with --issuer <iss> when completing login manually.",
    );
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
    if (callback.parameters.getAll("iss").length > 1) {
      return fail("OAuth callback includes multiple issuer values. Retry login.");
    }
    const iss = callback.parameters.get("iss");
    owner.assertCurrent();
    await completeMcpOAuthAuthorization(identity, resolved, {
      code: callback.code,
      ...(iss === null ? {} : { iss }),
    });
    defaultRuntime.log(`MCP OAuth credentials saved for "${name}".`);
  } finally {
    await callbackServer?.close();
  }
}
