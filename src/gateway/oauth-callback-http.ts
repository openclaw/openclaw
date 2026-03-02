import type { IncomingMessage, ServerResponse } from "node:http";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { HookMessageChannel } from "./hooks.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export const OAUTH_CALLBACK_PATH = "/oauth/callback";

export type OAuthCallbackHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

function resolvePublicBaseUrl(req: IncomingMessage): string {
  const fwdHost = req.headers["x-forwarded-host"];
  const host =
    (Array.isArray(fwdHost) ? fwdHost[0] : fwdHost) ?? req.headers["host"] ?? "localhost";
  const fwdProto = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(fwdProto) ? fwdProto[0] : fwdProto) ?? "http";
  return `${proto}://${host}`;
}

export function createOAuthCallbackHandler(opts: {
  logOAuth: SubsystemLogger;
  dispatchAgentHook: (value: {
    message: string;
    name: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    channel: HookMessageChannel;
  }) => string;
}): OAuthCallbackHandler {
  const { logOAuth, dispatchAgentHook } = opts;

  return async (req, res) => {
    const rawUrl = req.url ?? "/";
    const qIdx = rawUrl.indexOf("?");
    const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
    if (pathname !== OAUTH_CALLBACK_PATH) {
      return false;
    }

    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const baseUrl = resolvePublicBaseUrl(req);
    const fullUrl = `${baseUrl}${rawUrl}`;
    const params = new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : "");
    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error");
    const errorDescription = params.get("error_description");

    if (error) {
      logOAuth.warn(`Google OAuth callback error: ${error}: ${errorDescription ?? ""}`);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        `<!DOCTYPE html><html><head><title>Authorization Failed</title></head><body>` +
          `<h1>Authorization Failed</h1>` +
          `<p>Google returned an error: <strong>${error}</strong>` +
          `${errorDescription ? `: ${errorDescription}` : ""}</p>` +
          `<p>You can close this tab and try again in your chat.</p></body></html>`,
      );
      return true;
    }

    if (!code || !state) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Bad Request: missing code or state");
      return true;
    }

    logOAuth.info(`Google OAuth callback received: state=${state.slice(0, 8)}...`);

    dispatchAgentHook({
      message:
        `Google OAuth callback received. Run this to complete the authorization:\n\n` +
        `gog auth add <email> --remote --step 2 --auth-url '${fullUrl}'\n\n` +
        `(Add --client <name> if using a custom OAuth client.)`,
      name: "Google OAuth",
      wakeMode: "now",
      sessionKey: "",
      deliver: true,
      channel: "last",
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      `<!DOCTYPE html><html>` +
        `<head><title>Authorization Complete</title>` +
        `<style>body{font-family:sans-serif;max-width:600px;margin:60px auto;text-align:center;padding:0 20px}</style></head>` +
        `<body><h1>&#x2705; Authorization Received</h1>` +
        `<p>Larry has received your Google authorization and will complete the token exchange shortly.</p>` +
        `<p>You can close this tab.</p></body></html>`,
    );
    return true;
  };
}
