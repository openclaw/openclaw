import os from "node:os";
import path from "node:path";
import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import {
  hasCodexCliAuthFile,
  readGeminiCliCredentialsCached,
  resolveCodexCliHomePath,
} from "../agents/cli-credentials.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import {
  resolveConfiguredRouteModelLabel,
  resolveDefaultModelForAgent,
} from "../agents/model-selection.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveOsHomeDir } from "../infra/home-dir.js";
import { probeLocalCommand, type LocalCommandProbe } from "../system-agent/probes.js";
import {
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CODEX_APP_SERVER_DEFAULT_MODEL_REF,
  GEMINI_CLI_DEFAULT_MODEL_REF,
  detectAmbientInferenceBackends,
  type InferenceBackendCandidate,
} from "./onboard-inference-ambient.js";

export {
  ANTHROPIC_API_DEFAULT_MODEL_REF,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CODEX_APP_SERVER_DEFAULT_MODEL_REF,
  GEMINI_CLI_DEFAULT_MODEL_REF,
  OPENAI_API_DEFAULT_MODEL_REF,
  type InferenceBackendKind,
} from "./onboard-inference-ambient.js";

/**
 * Onboarding treats inference as the one required step: reuse whatever the
 * machine already has without activating providers. CLI version and credential
 * presence are detection evidence; explicit setup verifies the selected login.
 */

type DetectInferenceBackendsOptions = {
  config?: OpenClawConfig;
  agentId?: string;
};

// ChatGPT.app is the current desktop owner; keep Codex stable/beta as fallbacks.
const CODEX_MACOS_APP_NAMES = ["ChatGPT.app", "Codex.app", "Codex Beta.app"] as const;
const CODEX_MACOS_APP_PROBE_TIMEOUT_MS = 3_000;

async function probeCodexCommand(): Promise<LocalCommandProbe> {
  const pathProbe = await probeLocalCommand("codex");
  if (pathProbe.found || pathProbe.failure === "error" || process.platform !== "darwin") {
    return pathProbe;
  }
  const home = process.env.HOME?.trim() || os.homedir();
  const appExecutables = new Set(
    CODEX_MACOS_APP_NAMES.flatMap((appName) => [
      path.join("/Applications", appName, "Contents", "Resources", "codex"),
      path.join(home, "Applications", appName, "Contents", "Resources", "codex"),
    ]),
  );
  for (const executable of appExecutables) {
    // ChatGPT.app's signed Codex binary can spend most of the generic 1.5s
    // probe budget in macOS cold-start validation. Keep the broader probe
    // contract tight while giving known desktop-app binaries enough headroom.
    const appProbe = await probeLocalCommand(executable, ["--version"], {
      timeoutMs: CODEX_MACOS_APP_PROBE_TIMEOUT_MS,
    });
    if (appProbe.found || appProbe.failure === "error") {
      return appProbe;
    }
  }
  return pathProbe;
}
/**
 * Detect usable inference backends in ladder order. Returns candidates only
 * for backends that exist on this machine; explicit setup owns selection.
 * Native CLI discovery stays passive; environment credentials precede unverified CLIs.
 */
export async function detectInferenceBackends(
  options: DetectInferenceBackendsOptions = {},
): Promise<InferenceBackendCandidate[]> {
  const candidates: InferenceBackendCandidate[] = [];
  const defaultAgentId = options.config
    ? options.agentId?.trim() || tryResolveLegacyCompatibilityAgentId(options.config)
    : undefined;
  const defaultAgentModel =
    options.config && defaultAgentId
      ? resolveAgentConfig(options.config, defaultAgentId)?.model
      : undefined;
  const existingModel =
    resolveAgentModelPrimaryValue(defaultAgentModel) ??
    resolveAgentModelPrimaryValue(options.config?.agents?.defaults?.model);
  if (existingModel) {
    const resolved = resolveDefaultModelForAgent({
      cfg: options.config ?? {},
      ...(defaultAgentId ? { agentId: defaultAgentId } : {}),
    });
    const profileId = splitTrailingAuthProfile(existingModel).profile;
    const modelRef = resolveConfiguredRouteModelLabel({
      configuredRef: existingModel,
      resolved,
      ...(profileId ? { profileId } : {}),
    });
    candidates.push({
      kind: "existing-model",
      // Approval and activation bind to the executable target, not a mutable
      // alias spelling. The authored config itself remains untouched.
      modelRef,
      label: "Current model",
      detail: `${modelRef} — already configured`,
      credentials: true,
    });
  }
  const envCandidates = detectAmbientInferenceBackends();

  const [claudeProbe, codexProbe, geminiProbe] = await Promise.all([
    probeLocalCommand("claude"),
    probeCodexCommand(),
    probeLocalCommand("gemini"),
  ]);
  if (codexProbe.failure === "error" || codexProbe.timedOut) {
    throw new Error(
      `Codex detection failed (${codexProbe.command}): ${codexProbe.error ?? "version probe failed"}. Check the Codex installation and execution permissions, then retry setup.`,
    );
  }
  const cliCandidates: InferenceBackendCandidate[] = [];
  if (claudeProbe.found && !claudeProbe.timedOut) {
    cliCandidates.push({
      kind: "claude-cli",
      modelRef: CLAUDE_CLI_DEFAULT_MODEL_REF,
      label: "Claude Code",
      detail: "installed; login status unverified",
    });
  }
  let storedCodexCredentials: boolean;
  try {
    const home = resolveOsHomeDir(process.env) || process.env.CODEX_HOME?.trim();
    storedCodexCredentials = Boolean(home) && hasCodexCliAuthFile(resolveCodexCliHomePath());
  } catch (error) {
    throw new Error(
      `Codex sign-in detection failed: ${formatErrorMessage(error)}. Check access to the Codex home, then retry setup.`,
      { cause: error },
    );
  }
  if (codexProbe.found || storedCodexCredentials) {
    // Native status starts provider initialization (including migrations and
    // token refresh). A saved record proves neither the active store nor login.
    cliCandidates.push({
      kind: "codex-cli",
      modelRef: CODEX_APP_SERVER_DEFAULT_MODEL_REF,
      label: "Codex",
      detail: storedCodexCredentials
        ? codexProbe.found
          ? "installed; stored credentials found; login status unverified"
          : "stored credentials found; runtime installation required"
        : "installed; login status unverified",
      credentials: storedCodexCredentials,
    });
  }
  if (geminiProbe.found && !geminiProbe.timedOut) {
    // Current Gemini CLI releases keep primary auth in a private secure store;
    // oauth_creds.json is only a legacy migration source. Its absence cannot
    // distinguish logout from a modern login, and probing the secure store can
    // prompt the user, so only readable legacy credentials are conclusive.
    const credentials =
      readGeminiCliCredentialsCached({ ttlMs: 60_000 }) !== null ? true : undefined;
    cliCandidates.push({
      kind: "gemini-cli",
      modelRef: GEMINI_CLI_DEFAULT_MODEL_REF,
      label: "Gemini CLI",
      detail: credentials ? "installed; credentials found" : "installed; login status unavailable",
      ...(credentials === undefined ? {} : { credentials }),
    });
  }
  return [...candidates, ...envCandidates, ...cliCandidates];
}
