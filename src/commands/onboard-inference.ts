import { randomInt } from "node:crypto";
// Inference backend detection shared by onboarding bootstrap and OpenClaw setup.
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import {
  readCodexCliCredentialsCached,
  readGeminiCliCredentialsCached,
  resolveCodexCliHomePath,
} from "../agents/cli-credentials.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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

type DetectInferenceBackendsDeps = {
  probeLocalCommand?: typeof probeLocalCommand;
  readCodexCliCredentials?: () => { type: string } | null;
  readGeminiCliCredentials?: () => { type: string } | null;
  randomInt?: (maxExclusive: number) => number;
};

type DetectInferenceBackendsOptions = {
  config?: OpenClawConfig;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  deps?: DetectInferenceBackendsDeps;
};

function randomizeClaudeCodexTie(
  candidates: InferenceBackendCandidate[],
  pickRandomInt: (maxExclusive: number) => number,
): void {
  const claudeIndex = candidates.findIndex((candidate) => candidate.kind === "claude-cli");
  const codexIndex = candidates.findIndex((candidate) => candidate.kind === "codex-cli");
  if (claudeIndex === -1 || codexIndex === -1 || pickRandomInt(2) === 0) {
    return;
  }
  const claudeCandidate = candidates[claudeIndex];
  const codexCandidate = candidates[codexIndex];
  candidates[claudeIndex] = expectDefined(codexCandidate, "Codex onboarding candidate");
  candidates[codexIndex] = expectDefined(claudeCandidate, "Claude onboarding candidate");
}

// ChatGPT.app is the current desktop owner; keep Codex stable/beta as fallbacks.
const CODEX_MACOS_APP_NAMES = ["ChatGPT.app", "Codex.app", "Codex Beta.app"] as const;
const CODEX_MACOS_APP_PROBE_TIMEOUT_MS = 3_000;

async function probeCodexCommand(params: {
  probe: typeof probeLocalCommand;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): Promise<LocalCommandProbe> {
  const pathProbe = await params.probe("codex");
  if (pathProbe.found || params.platform !== "darwin") {
    return pathProbe;
  }
  const home = params.env.HOME?.trim() || os.homedir();
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
    const appProbe = await params.probe(executable, ["--version"], {
      timeoutMs: CODEX_MACOS_APP_PROBE_TIMEOUT_MS,
    });
    if (appProbe.found) {
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
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const probe = options.deps?.probeLocalCommand ?? probeLocalCommand;
  const readCodex =
    options.deps?.readCodexCliCredentials ??
    (() => {
      const home = resolveOsHomeDir(env, env === process.env ? os.homedir : () => "");
      if (!home && !env.CODEX_HOME?.trim()) {
        return null;
      }
      return readCodexCliCredentialsCached({
        codexHome: resolveCodexCliHomePath(undefined, env),
        platform,
        allowKeychainPrompt: false,
        ttlMs: 60_000,
      });
    });
  const readGemini =
    options.deps?.readGeminiCliCredentials ??
    (() => readGeminiCliCredentialsCached({ ttlMs: 60_000 }));

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
    const modelRef = `${resolved.provider}/${resolved.model}`;
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
  const envCandidates = detectAmbientInferenceBackends(env);

  const [claudeProbe, codexProbe, geminiProbe] = await Promise.all([
    probe("claude"),
    probeCodexCommand({ probe, env, platform }),
    probe("gemini"),
  ]);
  const cliCandidates: InferenceBackendCandidate[] = [];
  if (claudeProbe.found && !claudeProbe.timedOut) {
    cliCandidates.push({
      kind: "claude-cli",
      modelRef: CLAUDE_CLI_DEFAULT_MODEL_REF,
      label: "Claude Code",
      detail: "installed; login status unverified",
    });
  }
  if (codexProbe.found && !codexProbe.timedOut) {
    const storedCredentials = readCodex() !== null;
    // Native status starts provider initialization (including migrations and
    // token refresh). A saved record proves neither the active store nor login.
    cliCandidates.push({
      kind: "codex-cli",
      modelRef: CODEX_APP_SERVER_DEFAULT_MODEL_REF,
      label: "Codex",
      detail: storedCredentials
        ? "installed; stored credentials found; login status unverified"
        : "installed; login status unverified",
    });
  }
  if (geminiProbe.found && !geminiProbe.timedOut) {
    // Current Gemini CLI releases keep primary auth in a private secure store;
    // oauth_creds.json is only a legacy migration source. Its absence cannot
    // distinguish logout from a modern login, and probing the secure store can
    // prompt the user, so only readable legacy credentials are conclusive.
    const credentials = readGemini() !== null ? true : undefined;
    cliCandidates.push({
      kind: "gemini-cli",
      modelRef: GEMINI_CLI_DEFAULT_MODEL_REF,
      label: "Gemini CLI",
      detail: credentials ? "installed; credentials found" : "installed; login status unavailable",
      ...(credentials === undefined ? {} : { credentials }),
    });
  }
  // Stored CLI credentials do not establish a verified subscription.
  randomizeClaudeCodexTie(cliCandidates, options.deps?.randomInt ?? randomInt);
  return [...candidates, ...envCandidates, ...cliCandidates];
}
