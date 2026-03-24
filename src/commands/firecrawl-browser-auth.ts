import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { isRemoteEnvironment } from "./oauth-env.js";
import { openUrl } from "./onboard-helpers.js";

const FIRECRAWL_AUTH_STATUS_URL = "https://firecrawl.dev/api/auth/cli/status";
const FIRECRAWL_AUTH_URL_BASE = "https://firecrawl.dev/cli-auth";
/** Query value for `source=` so firecrawl.dev/cli-auth shows the OpenClaw plan picker (free tier vs starter pack). */
export const FIRECRAWL_CLI_AUTH_SOURCE = "openclaw";

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000;

function generateSessionId(): string {
  return crypto.randomBytes(32).toString("hex");
}

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = crypto.createHash("sha256").update(verifier).digest();
  return digest.toString("base64url");
}

export type FirecrawlBrowserAuthResult = {
  apiKey: string;
  teamName?: string;
};

async function pollFirecrawlAuthStatus(
  sessionId: string,
  codeVerifier: string,
): Promise<FirecrawlBrowserAuthResult | null> {
  const res = await fetch(FIRECRAWL_AUTH_STATUS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, code_verifier: codeVerifier }),
  });
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as { apiKey?: string; teamName?: string };
  if (data.apiKey) {
    return { apiKey: data.apiKey, teamName: data.teamName };
  }
  return null;
}

async function waitForFirecrawlAuth(
  sessionId: string,
  codeVerifier: string,
  spin: { update: (msg: string) => void },
): Promise<FirecrawlBrowserAuthResult | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let dots = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    dots = (dots + 1) % 4;
    spin.update(`Waiting for browser login${".".repeat(dots)}`);
    try {
      const result = await pollFirecrawlAuthStatus(sessionId, codeVerifier);
      if (result) {
        return result;
      }
    } catch {
      // Network blip — keep polling.
    }
  }
  return null;
}

/**
 * Opens Firecrawl CLI auth in the browser and polls until an API key is issued (PKCE flow).
 * Returns null on timeout or unexpected errors (caller may fall back to manual key entry).
 */
export async function obtainFirecrawlApiKeyThroughBrowser(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
}): Promise<FirecrawlBrowserAuthResult | null> {
  const { prompter, runtime } = params;
  try {
    const sessionId = generateSessionId();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const authUrl = `${FIRECRAWL_AUTH_URL_BASE}?code_challenge=${encodeURIComponent(codeChallenge)}&source=${encodeURIComponent(FIRECRAWL_CLI_AUTH_SOURCE)}#session_id=${sessionId}`;

    const isRemote = isRemoteEnvironment();
    if (isRemote) {
      await prompter.note(`Open this URL in your browser to log in:\n\n${authUrl}`, "Firecrawl");
    } else {
      const opened = await openUrl(authUrl);
      if (!opened) {
        await prompter.note(
          `Could not open browser. Visit this URL to log in:\n\n${authUrl}`,
          "Firecrawl",
        );
      }
    }

    const spin = prompter.progress("Waiting for browser login...");
    const result = await waitForFirecrawlAuth(sessionId, codeVerifier, spin);

    if (!result) {
      spin.stop("Timed out waiting for login.");
      return null;
    }

    const teamNote = result.teamName ? ` (team: ${result.teamName})` : "";
    spin.stop(`Authenticated with Firecrawl${teamNote}`);
    return result;
  } catch (err) {
    runtime.log("Firecrawl auth error:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Persist Firecrawl API key for `web_fetch` / shared tools (same shape as onboard-firecrawl). */
export function mergeFirecrawlApiKeyIntoOpenClawConfig(
  cfg: OpenClawConfig,
  apiKey: string,
): OpenClawConfig {
  return {
    ...cfg,
    tools: {
      ...cfg.tools,
      web: {
        ...cfg.tools?.web,
        fetch: {
          ...cfg.tools?.web?.fetch,
          firecrawl: {
            ...cfg.tools?.web?.fetch?.firecrawl,
            enabled: true,
            apiKey,
          },
        },
      },
    },
  };
}
