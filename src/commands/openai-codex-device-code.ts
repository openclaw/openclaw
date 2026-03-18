import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { readCodexCliCredentials } from "../agents/cli-credentials.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { detectBinary } from "./onboard-helpers.js";

const CODEX_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const OPENAI_PROFILE_EMAIL_CLAIM = "https://api.openai.com/profile.email";

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  const payload = segments[1];
  if (!payload) {
    return null;
  }

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const paddingLength = (4 - (normalized.length % 4)) % 4;
    const padded = normalized.padEnd(normalized.length + paddingLength, "=");
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function extractOpenAICodexEmailFromAccessToken(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const candidates = [payload?.[OPENAI_PROFILE_EMAIL_CLAIM], payload?.email];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

export async function loginOpenAICodexDeviceCode(): Promise<OAuthCredentials> {
  const hasCodex = await detectBinary("codex");
  if (!hasCodex) {
    throw new Error("Codex CLI not found. Install with: npm install -g @openai/codex");
  }

  const result = await runCommandWithTimeout(["codex", "login"], {
    timeoutMs: CODEX_LOGIN_TIMEOUT_MS,
    // Prevent ambient API-key auth from short-circuiting the Codex CLI login flow.
    env: { NODE_OPTIONS: "", OPENAI_API_KEY: undefined },
    mirrorStdout: true,
    mirrorStderr: true,
  });

  if (result.code !== 0) {
    const details = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(
      [
        `Codex CLI login failed (exit ${String(result.code)}).`,
        details ? `Output:\n${details}` : "No output captured.",
      ].join("\n"),
    );
  }

  const creds = readCodexCliCredentials();
  if (!creds) {
    throw new Error(
      "Codex CLI login completed, but credentials were not found in ~/.codex/auth.json or keychain.",
    );
  }

  const email = extractOpenAICodexEmailFromAccessToken(creds.access);
  return email ? { ...creds, email } : creds;
}
