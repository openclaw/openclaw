import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { isRemoteEnvironment } from "./oauth-env.js";
import { openUrl } from "./onboard-helpers.js";

// ---------------------------------------------------------------------------
// PKCE helpers (matches Firecrawl CLI auth flow)
// ---------------------------------------------------------------------------

function generateSessionId(): string {
  return crypto.randomBytes(32).toString("hex");
}

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  const digest = crypto.createHash("sha256").update(verifier).digest();
  return digest.toString("base64url");
}

// ---------------------------------------------------------------------------
// Auth polling
// ---------------------------------------------------------------------------

const FIRECRAWL_AUTH_STATUS_URL = "https://firecrawl.dev/api/auth/cli/status";
const FIRECRAWL_AUTH_URL_BASE = "https://firecrawl.dev/cli-auth";

type FirecrawlAuthResult = {
  apiKey: string;
  teamName?: string;
};

async function pollFirecrawlAuthStatus(
  sessionId: string,
  codeVerifier: string,
): Promise<FirecrawlAuthResult | null> {
  const res = await fetch(FIRECRAWL_AUTH_STATUS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, code_verifier: codeVerifier }),
  });
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as { apiKey?: string; teamName?: string };
  if (data.apiKey && !validateFirecrawlKey(data.apiKey)) {
    return { apiKey: data.apiKey, teamName: data.teamName };
  }
  return null;
}

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

async function waitForFirecrawlAuth(
  sessionId: string,
  codeVerifier: string,
  spin: { update: (msg: string) => void },
): Promise<FirecrawlAuthResult | null> {
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

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function getExistingFirecrawlKey(cfg: OpenClawConfig): string | undefined {
  const key = cfg.tools?.web?.fetch?.firecrawl?.apiKey;
  if (key) {
    return key;
  }
  return undefined;
}

const FIRECRAWL_TOOL_NAMES = ["firecrawl_search", "firecrawl_scrape", "browser"];

function applyFirecrawlKey(cfg: OpenClawConfig, apiKey: string): OpenClawConfig {
  // Merge firecrawl tools into the existing alsoAllow list (deduped)
  const existing = cfg.tools?.alsoAllow ?? [];
  const merged = [...new Set([...existing, ...FIRECRAWL_TOOL_NAMES])];

  return {
    ...cfg,
    tools: {
      ...cfg.tools,
      alsoAllow: merged,
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

function validateFirecrawlKey(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return "API key is required";
  }
  if (!trimmed.startsWith("fc-")) {
    return 'Firecrawl API keys start with "fc-"';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main setup function
// ---------------------------------------------------------------------------

export async function setupFirecrawl(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  // Check if already configured via config.
  const existingKey = getExistingFirecrawlKey(cfg);
  if (existingKey) {
    await prompter.note("Firecrawl API key already configured.", "Firecrawl");
    return cfg;
  }

  // Check if already configured via env var.
  if (process.env.FIRECRAWL_API_KEY) {
    await prompter.note(
      "Firecrawl API key found in FIRECRAWL_API_KEY environment variable.",
      "Firecrawl",
    );
    return cfg;
  }

  await prompter.note(
    "Firecrawl adds web scraping, search, and browser automation.\nFree tier: 500 credits on signup, no credit card required.",
    "Firecrawl (optional)",
  );

  const wantsSetup = await prompter.confirm({
    message: "Set up Firecrawl web scraping, search and web browsing?",
    initialValue: true,
  });
  if (!wantsSetup) {
    return cfg;
  }

  const method = await prompter.select<"browser" | "manual">({
    message: "How would you like to authenticate?",
    options: [
      { value: "browser", label: "Browser login", hint: "recommended — opens firecrawl.dev" },
      { value: "manual", label: "Paste API key", hint: "if you already have one" },
    ],
    initialValue: "browser",
  });

  if (method === "manual") {
    return handleManualEntry(cfg, prompter);
  }

  return handleBrowserAuth(cfg, runtime, prompter);
}

// ---------------------------------------------------------------------------
// Manual API key entry
// ---------------------------------------------------------------------------

async function handleManualEntry(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const apiKey = await prompter.text({
    message: "Firecrawl API key",
    placeholder: "fc-...",
    validate: validateFirecrawlKey,
  });

  const trimmed = apiKey.trim();
  if (!trimmed) {
    return cfg;
  }

  await prompter.note("Firecrawl API key saved.", "Firecrawl");
  return applyFirecrawlKey(cfg, trimmed);
}

// ---------------------------------------------------------------------------
// Browser OAuth flow (PKCE + polling)
// ---------------------------------------------------------------------------

async function handleBrowserAuth(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  try {
    const sessionId = generateSessionId();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const authUrl = `${FIRECRAWL_AUTH_URL_BASE}?code_challenge=${codeChallenge}&source=openclaw#session_id=${sessionId}`;

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
      await prompter.note(
        "Authentication timed out.\nYou can set up Firecrawl later via `openclaw configure --section web`\nor set the FIRECRAWL_API_KEY environment variable.",
        "Firecrawl",
      );
      return cfg;
    }

    const teamNote = result.teamName ? ` (team: ${result.teamName})` : "";
    spin.stop(`Authenticated with Firecrawl${teamNote}`);
    return applyFirecrawlKey(cfg, result.apiKey);
  } catch (err) {
    runtime.log("Firecrawl auth error:", err instanceof Error ? err.message : String(err));
    await prompter.note(
      "Something went wrong during Firecrawl setup.\nYou can set up Firecrawl later via `openclaw configure --section web`\nor set the FIRECRAWL_API_KEY environment variable.",
      "Firecrawl",
    );
    return cfg;
  }
}
