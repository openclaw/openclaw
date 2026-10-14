/** TLS helpers for ChatGPT OAuth provider discovery in plugin runtime code. */
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runHttpTlsPreflight, type HttpTlsPreflightResult } from "../infra/http-tls-preflight.js";

const OPENAI_AUTH_PROBE_URL =
  "https://auth.openai.com/oauth/authorize?response_type=code&client_id=openclaw-preflight&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email";
const OPENAI_PROVIDER_ID = "openai";

function resolveHomebrewPrefixFromExecPath(execPath: string): string | null {
  const marker = `${path.sep}Cellar${path.sep}`;
  const idx = execPath.indexOf(marker);
  if (idx > 0) {
    return execPath.slice(0, idx);
  }
  const envPrefix = process.env.HOMEBREW_PREFIX?.trim();
  return envPrefix ? envPrefix : null;
}

export function shouldRunOpenAIOAuthTlsPrerequisites(params: {
  cfg: OpenClawConfig;
  deep?: boolean;
}): boolean {
  return (
    params.deep === true ||
    Object.values(params.cfg.auth?.profiles ?? {}).some(
      (profile) => profile.provider === OPENAI_PROVIDER_ID && profile.mode === "oauth",
    )
  );
}

export function runOpenAIOAuthTlsPreflight(options?: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<HttpTlsPreflightResult> {
  return runHttpTlsPreflight(OPENAI_AUTH_PROBE_URL, options);
}

export function formatOpenAIOAuthTlsPreflightFix(
  result: Exclude<HttpTlsPreflightResult, { ok: true }>,
): string {
  if (result.kind !== "tls-cert") {
    return [
      "OpenAI OAuth prerequisites check failed due to a network error before the browser flow.",
      `Cause: ${result.message}`,
      "Verify DNS/firewall/proxy access to auth.openai.com and retry.",
    ].join("\n");
  }
  const prefix = resolveHomebrewPrefixFromExecPath(process.execPath);
  const certBundlePath = prefix ? path.join(prefix, "etc", "openssl@3", "cert.pem") : null;
  const lines = [
    "OpenAI OAuth prerequisites check failed: Node/OpenSSL cannot validate TLS certificates.",
    `Cause: ${result.code ? `${result.code} (${result.message})` : result.message}`,
    "",
    "Fix (Homebrew Node/OpenSSL):",
    `- ${formatCliCommand("brew postinstall ca-certificates")}`,
    `- ${formatCliCommand("brew postinstall openssl@3")}`,
  ];
  if (certBundlePath) {
    lines.push(`- Verify cert bundle exists: ${certBundlePath}`);
  }
  lines.push("- Retry the OAuth login flow.");
  return lines.join("\n");
}

export async function noteOpenAIOAuthTlsPrerequisites(params: {
  cfg: OpenClawConfig;
  deep?: boolean;
}): Promise<void> {
  if (!shouldRunOpenAIOAuthTlsPrerequisites(params)) {
    return;
  }
  const result = await runOpenAIOAuthTlsPreflight({ timeoutMs: 4000 });
  if (result.ok || result.kind !== "tls-cert") {
    return;
  }
  note(formatOpenAIOAuthTlsPreflightFix(result), "OAuth TLS prerequisites");
}
