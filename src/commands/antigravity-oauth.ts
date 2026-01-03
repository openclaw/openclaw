/**
 * VPS-aware Antigravity OAuth flow.
 *
 * On local machines: Uses the standard pi-ai loginAntigravity with local server callback.
 * On VPS/SSH/headless: Shows URL and prompts user to paste the callback URL manually.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { loginAntigravity, type OAuthCredentials } from "@mariozechner/pi-ai";

// OAuth constants - decoded from pi-ai's base64 encoded values to stay in sync
const decode = (s: string) => Buffer.from(s, "base64").toString();
const CLIENT_ID = decode(
  "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
const CLIENT_SECRET = decode(
  "R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=",
);
const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// Antigravity requires these additional scopes
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
// Fallback project ID when discovery fails (same as pi-ai)
const DEFAULT_PROJECT_ID = "rising-fact-p41fc";

/**
 * Detect if running in WSL (Windows Subsystem for Linux).
 */
function isWSL(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const release = readFileSync("/proc/version", "utf8").toLowerCase();
    return release.includes("microsoft") || release.includes("wsl");
  } catch {
    return false;
  }
}

/**
 * Detect if running in WSL2 specifically.
 */
function isWSL2(): boolean {
  if (!isWSL()) return false;
  try {
    const version = readFileSync("/proc/version", "utf8").toLowerCase();
    return version.includes("wsl2") || version.includes("microsoft-standard");
  } catch {
    return false;
  }
}

/**
 * Detect if running in a remote/headless environment where localhost callback won't work.
 */
export function isRemoteEnvironment(): boolean {
  // SSH session indicators
  if (
    process.env.SSH_CLIENT ||
    process.env.SSH_TTY ||
    process.env.SSH_CONNECTION
  ) {
    return true;
  }

  // Container/cloud environments
  if (process.env.REMOTE_CONTAINERS || process.env.CODESPACES) {
    return true;
  }

  // Linux without display (and not WSL which can use wslview)
  if (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY &&
    !isWSL()
  ) {
    return true;
  }

  return false;
}

/**
 * Whether to skip the local OAuth callback server.
 */
export function shouldUseManualOAuthFlow(): boolean {
  return isWSL2() || isRemoteEnvironment();
}

/**
 * Generate PKCE verifier and challenge using Node.js crypto.
 */
function generatePKCESync(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Build the Antigravity OAuth authorization URL.
 */
function buildAuthUrl(challenge: string, verifier: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/**
 * Parse the OAuth callback URL or code input.
 */
function parseCallbackInput(
  input: string,
  expectedState: string,
): { code: string; state: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { error: "No input provided" };
  }

  try {
    // Try parsing as full URL
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? expectedState;

    if (!code) {
      return { error: "Missing 'code' parameter in URL" };
    }
    if (!state) {
      return { error: "Missing 'state' parameter. Paste the full URL." };
    }

    return { code, state };
  } catch {
    // Not a URL - treat as raw code (need state from original request)
    if (!expectedState) {
      return { error: "Paste the full redirect URL, not just the code." };
    }
    return { code: trimmed, state: expectedState };
  }
}

/**
 * Exchange authorization code for tokens.
 */
async function exchangeCodeForTokens(
  code: string,
  verifier: string,
): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${errorText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  if (!data.refresh_token) {
    throw new Error("No refresh token received. Please try again.");
  }

  // Fetch user email
  const email = await getUserEmail(data.access_token);

  // Fetch project ID
  const projectId = await fetchProjectId(data.access_token);

  // Calculate expiry time (same as pi-ai: current time + expires_in - 5 min buffer)
  const expiresAt = Date.now() + data.expires_in * 1000 - 5 * 60 * 1000;

  return {
    refresh: data.refresh_token,
    access: data.access_token,
    expires: expiresAt,
    projectId,
    email,
  };
}

/**
 * Get user email from access token.
 */
async function getUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetch(
      "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );
    if (response.ok) {
      const data = (await response.json()) as { email?: string };
      return data.email;
    }
  } catch {
    // Ignore errors, email is optional
  }
  return undefined;
}

/**
 * Fetch the Antigravity project ID using the access token.
 */
async function fetchProjectId(accessToken: string): Promise<string> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    }),
  };

  // Try endpoints in order: prod first, then sandbox
  const endpoints = [
    "https://cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          metadata: {
            ideType: "IDE_UNSPECIFIED",
            platform: "PLATFORM_UNSPECIFIED",
            pluginType: "GEMINI",
          },
        }),
      });

      if (!response.ok) continue;

      const data = (await response.json()) as {
        cloudaicompanionProject?: string | { id?: string };
      };

      if (typeof data.cloudaicompanionProject === "string") {
        return data.cloudaicompanionProject;
      }
      if (
        data.cloudaicompanionProject &&
        typeof data.cloudaicompanionProject === "object" &&
        data.cloudaicompanionProject.id
      ) {
        return data.cloudaicompanionProject.id;
      }
    } catch {
      // ignore failed endpoint, try next
    }
  }

  // Use fallback project ID
  return DEFAULT_PROJECT_ID;
}

/**
 * Prompt user for input via readline.
 */
async function promptInput(message: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}

/**
 * VPS-aware Antigravity OAuth login.
 *
 * On local machines: Uses the standard pi-ai flow with automatic localhost callback.
 * On VPS/SSH: Shows URL and prompts user to paste the callback URL manually.
 */
export async function loginAntigravityVpsAware(
  onUrl: (url: string) => void | Promise<void>,
  onProgress?: (message: string) => void,
): Promise<OAuthCredentials | null> {
  // Check if we're in a remote environment
  if (shouldUseManualOAuthFlow()) {
    return loginAntigravityManual(onUrl, onProgress);
  }

  // Use the standard pi-ai flow for local environments
  try {
    return await loginAntigravity(
      async ({ url, instructions }) => {
        await onUrl(url);
        onProgress?.(instructions ?? "Complete sign-in in browser...");
      },
      (msg) => onProgress?.(msg),
    );
  } catch (err) {
    // If the local server fails (e.g., port in use), fall back to manual
    if (
      err instanceof Error &&
      (err.message.includes("EADDRINUSE") ||
        err.message.includes("port") ||
        err.message.includes("listen"))
    ) {
      onProgress?.("Local callback server failed. Switching to manual mode...");
      return loginAntigravityManual(onUrl, onProgress);
    }
    throw err;
  }
}

/**
 * Manual Antigravity OAuth login for VPS/headless environments.
 *
 * Shows the OAuth URL and prompts user to paste the callback URL.
 */
export async function loginAntigravityManual(
  onUrl: (url: string) => void | Promise<void>,
  onProgress?: (message: string) => void,
): Promise<OAuthCredentials | null> {
  const { verifier, challenge } = generatePKCESync();
  const authUrl = buildAuthUrl(challenge, verifier);

  // Show the URL to the user
  await onUrl(authUrl);

  onProgress?.("Waiting for you to paste the callback URL...");

  console.log("\n");
  console.log("=".repeat(60));
  console.log("VPS/Remote Mode - Manual OAuth");
  console.log("=".repeat(60));
  console.log("\n1. Open the URL above in your LOCAL browser");
  console.log("2. Complete the Google sign-in");
  console.log(
    "3. Your browser will redirect to a localhost URL that won't load",
  );
  console.log("4. Copy the ENTIRE URL from your browser's address bar");
  console.log("5. Paste it below\n");
  console.log("The URL will look like:");
  console.log("http://localhost:51121/oauth-callback?code=xxx&state=yyy\n");

  const callbackInput = await promptInput("Paste the redirect URL here: ");

  const parsed = parseCallbackInput(callbackInput, verifier);
  if ("error" in parsed) {
    throw new Error(parsed.error);
  }

  // Verify state matches
  if (parsed.state !== verifier) {
    throw new Error("OAuth state mismatch - please try again");
  }

  onProgress?.("Exchanging authorization code for tokens...");

  return exchangeCodeForTokens(parsed.code, verifier);
}
