// First-run inference activation: detect candidates, live-test, persist only on success.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { upsertAuthProfileWithLock } from "../agents/auth-profiles/profiles.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { describeFailoverError } from "../agents/failover-error.js";
import {
  isCliProvider,
  normalizeProviderId,
  resolveDefaultModelForAgent,
} from "../agents/model-selection.js";
import {
  ANTHROPIC_API_DEFAULT_MODEL_REF,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CODEX_APP_SERVER_DEFAULT_MODEL_REF,
  GEMINI_CLI_DEFAULT_MODEL_REF,
  OPENAI_API_DEFAULT_MODEL_REF,
  detectInferenceBackends,
  type InferenceBackendKind,
} from "../commands/onboard-inference.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { buildCliPlannerConfig, buildCodexAppServerPlannerConfig } from "./assistant-backends.js";
import { loadAuthoredSetupConfig } from "./onboarding-welcome.js";
import { applyCrestodianSetup, createQuickstartNotePrompter } from "./setup-apply.js";

/**
 * Inference is the one required onboarding step (docs/cli/crestodian.md
 * "Setup bootstrap"). This module gives structured clients (macOS app) the
 * same ladder the conversation uses, with one hard guarantee: a candidate is
 * persisted as the default model only after a real completion round-trips.
 * A failing candidate must never leave config pointing at a broken model.
 */
export const SETUP_INFERENCE_TEST_TIMEOUT_MS = 90_000;
const SETUP_INFERENCE_TEST_PROMPT = "Reply with the single word OK. Do not use tools.";
const SETUP_INFERENCE_TEST_MAX_TOKENS = 32;
const GOOGLE_API_DEFAULT_MODEL_REF = "google/gemini-3.1-pro-preview";

/** Providers accepted for the manual API-key step, mapped to a starter model. */
const MANUAL_API_KEY_MODEL_REFS: Record<string, string> = {
  anthropic: ANTHROPIC_API_DEFAULT_MODEL_REF,
  openai: OPENAI_API_DEFAULT_MODEL_REF,
  google: GOOGLE_API_DEFAULT_MODEL_REF,
};

export type SetupInferenceCandidate = {
  kind: InferenceBackendKind;
  label: string;
  detail: string;
  modelRef: string;
  recommended: boolean;
  credentials?: boolean;
};

export type SetupInferenceDetection = {
  candidates: SetupInferenceCandidate[];
  /** Resolved workspace the setup apply would use (display + default). */
  workspace: string;
  configuredModel?: string;
  /** Config already carries authored setup and a default model. */
  setupComplete: boolean;
};

export type SetupInferenceStatus =
  | "ok"
  | "auth"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "format"
  | "unavailable"
  | "unknown";

export type ActivateSetupInferenceResult =
  | { ok: true; modelRef: string; latencyMs: number; lines: string[] }
  | { ok: false; status: SetupInferenceStatus; error: string };

export type ActivateSetupInferenceParams = {
  kind: InferenceBackendKind | "api-key";
  /** Manual step only: provider the pasted API key belongs to. */
  provider?: string;
  /** Manual step only: the pasted API key. Never logged. */
  apiKey?: string;
  workspace?: string;
  surface: "cli" | "gateway";
  runtime: RuntimeEnv;
  deps?: ActivateSetupInferenceDeps;
};

export type ActivateSetupInferenceDeps = {
  readConfigFileSnapshot?: typeof import("../config/config.js").readConfigFileSnapshot;
  runEmbeddedAgent?: typeof import("../agents/embedded-agent.js").runEmbeddedAgent;
  runCliAgent?: typeof import("../agents/cli-runner.js").runCliAgent;
  applySetup?: typeof applyCrestodianSetup;
  ensureCodexRuntimePlugin?: typeof import("../commands/codex-runtime-plugin-install.js").ensureCodexRuntimePluginForModelSelection;
  updateConfig?: typeof import("../commands/models/shared.js").updateConfig;
  createTempDir?: () => Promise<string>;
  removeTempDir?: (dir: string) => Promise<void>;
  timeoutMs?: number;
};

export async function detectSetupInference(): Promise<SetupInferenceDetection> {
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  const cfg = snapshot.exists && snapshot.valid ? (snapshot.runtimeConfig ?? snapshot.config) : {};
  const raw = await detectInferenceBackends({ config: cfg });
  // Recommended = the first candidate setup itself would bootstrap with; a
  // definitively logged-out CLI never gets the badge.
  const recommendedIndex = raw.findIndex((candidate) => candidate.credentials !== false);
  const candidates = raw.map((candidate, index) => ({
    ...candidate,
    recommended: index === recommendedIndex,
  }));
  const { authoredConfig, hasAuthoredSetup } = await loadAuthoredSetupConfig({
    configExists: snapshot.exists,
    configValid: snapshot.valid,
  });
  const configuredModel = raw.find((candidate) => candidate.kind === "existing-model")?.modelRef;
  const { DEFAULT_WORKSPACE } = await import("../commands/onboard-helpers.js");
  const workspace = resolveUserPath(
    authoredConfig?.agents?.defaults?.workspace?.trim() || DEFAULT_WORKSPACE,
  );
  return {
    candidates,
    workspace,
    ...(configuredModel ? { configuredModel } : {}),
    setupComplete: hasAuthoredSetup && Boolean(configuredModel),
  };
}

type SetupInferenceTestPlan = {
  runner: "cli" | "embedded";
  provider: string;
  model: string;
  modelRef: string;
  config: OpenClawConfig;
  agentHarnessId?: string;
  authProfileId?: string;
  /** Model to persist as default on success; undefined keeps the current one. */
  persistModelRef?: string;
};

type RunResult = {
  payloads?: Array<{ text?: string }>;
  meta?: { finalAssistantVisibleText?: string; finalAssistantRawText?: string };
};

function extractRunText(result: RunResult): string | undefined {
  return (
    result.meta?.finalAssistantVisibleText ??
    result.meta?.finalAssistantRawText ??
    result.payloads
      ?.map((payload) => payload.text?.trim())
      .filter(Boolean)
      .join("\n")
  );
}

function parseRef(modelRef: string): { provider: string; model: string } {
  const slash = modelRef.indexOf("/");
  return slash === -1
    ? { provider: modelRef, model: "" }
    : { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) };
}

function mapFailoverReasonToSetupStatus(reason?: string | null): SetupInferenceStatus {
  if (reason === "auth" || reason === "auth_permanent") {
    return "auth";
  }
  if (reason === "rate_limit" || reason === "overloaded") {
    return "rate_limit";
  }
  if (reason === "billing") {
    return "billing";
  }
  if (reason === "timeout") {
    return "timeout";
  }
  if (reason === "format" || reason === "model_not_found") {
    return "format";
  }
  return "unknown";
}

async function buildTestPlan(params: {
  kind: InferenceBackendKind | "api-key";
  provider?: string;
  cfg: OpenClawConfig;
  workspaceDir: string;
}): Promise<SetupInferenceTestPlan | { error: string }> {
  const { kind, cfg, workspaceDir } = params;
  switch (kind) {
    case "existing-model": {
      const ref = resolveDefaultModelForAgent({ cfg, agentId: resolveDefaultAgentId(cfg) });
      const modelRef = `${ref.provider}/${ref.model}`;
      return {
        runner: isCliProvider(ref.provider, cfg) ? "cli" : "embedded",
        provider: ref.provider,
        model: ref.model,
        modelRef,
        config: cfg,
      };
    }
    case "claude-cli": {
      const ref = parseRef(CLAUDE_CLI_DEFAULT_MODEL_REF);
      return {
        runner: "cli",
        ...ref,
        modelRef: CLAUDE_CLI_DEFAULT_MODEL_REF,
        config: buildCliPlannerConfig(workspaceDir, CLAUDE_CLI_DEFAULT_MODEL_REF),
        persistModelRef: CLAUDE_CLI_DEFAULT_MODEL_REF,
      };
    }
    case "gemini-cli": {
      const ref = parseRef(GEMINI_CLI_DEFAULT_MODEL_REF);
      return {
        runner: "cli",
        ...ref,
        modelRef: GEMINI_CLI_DEFAULT_MODEL_REF,
        config: buildCliPlannerConfig(workspaceDir, GEMINI_CLI_DEFAULT_MODEL_REF),
        persistModelRef: GEMINI_CLI_DEFAULT_MODEL_REF,
      };
    }
    case "codex-cli": {
      const ref = parseRef(CODEX_APP_SERVER_DEFAULT_MODEL_REF);
      return {
        runner: "embedded",
        ...ref,
        modelRef: CODEX_APP_SERVER_DEFAULT_MODEL_REF,
        config: buildCodexAppServerPlannerConfig(workspaceDir),
        agentHarnessId: "codex",
        persistModelRef: CODEX_APP_SERVER_DEFAULT_MODEL_REF,
      };
    }
    case "openai-api-key": {
      const ref = parseRef(OPENAI_API_DEFAULT_MODEL_REF);
      return {
        runner: "embedded",
        ...ref,
        modelRef: OPENAI_API_DEFAULT_MODEL_REF,
        config: buildCliPlannerConfig(workspaceDir, OPENAI_API_DEFAULT_MODEL_REF),
        persistModelRef: OPENAI_API_DEFAULT_MODEL_REF,
      };
    }
    case "anthropic-api-key": {
      const ref = parseRef(ANTHROPIC_API_DEFAULT_MODEL_REF);
      return {
        runner: "embedded",
        ...ref,
        modelRef: ANTHROPIC_API_DEFAULT_MODEL_REF,
        config: buildCliPlannerConfig(workspaceDir, ANTHROPIC_API_DEFAULT_MODEL_REF),
        persistModelRef: ANTHROPIC_API_DEFAULT_MODEL_REF,
      };
    }
    case "api-key": {
      const provider = normalizeProviderId(params.provider ?? "");
      const canonical = provider === "codex" || provider === "openai-codex" ? "openai" : provider;
      const modelRef = MANUAL_API_KEY_MODEL_REFS[canonical];
      if (!modelRef) {
        return {
          error: `Unsupported provider "${params.provider ?? ""}" — expected anthropic, openai, or google.`,
        };
      }
      const ref = parseRef(modelRef);
      return {
        runner: "embedded",
        ...ref,
        modelRef,
        config: buildCliPlannerConfig(workspaceDir, modelRef),
        authProfileId: `${canonical}:manual`,
        persistModelRef: modelRef,
      };
    }
    default:
      return { error: `Unknown inference choice "${String(kind)}".` };
  }
}

/**
 * Test one candidate with a real completion, then persist it as the setup
 * default. Manual API keys are staged into the auth store for the test and
 * rolled back when the test fails, so a bad key leaves no trace.
 */
export async function activateSetupInference(
  params: ActivateSetupInferenceParams,
): Promise<ActivateSetupInferenceResult> {
  const deps = params.deps ?? {};
  const readSnapshot =
    deps.readConfigFileSnapshot ?? (await import("../config/config.js")).readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  const cfg: OpenClawConfig =
    snapshot.exists && snapshot.valid ? (snapshot.runtimeConfig ?? snapshot.config) : {};

  const tempDir = await (
    deps.createTempDir ?? (() => fs.mkdtemp(path.join(os.tmpdir(), "openclaw-setup-inference-")))
  )();
  try {
    const plan = await buildTestPlan({
      kind: params.kind,
      ...(params.provider !== undefined ? { provider: params.provider } : {}),
      cfg,
      workspaceDir: tempDir,
    });
    if ("error" in plan) {
      return { ok: false, status: "unavailable", error: plan.error };
    }

    const agentDir = resolveAgentDir(cfg, resolveDefaultAgentId(cfg));
    let stagedProfile: { profileId: string; prior?: AuthProfileCredential } | null = null;
    if (plan.authProfileId) {
      const apiKey = params.apiKey?.trim();
      if (!apiKey) {
        return { ok: false, status: "unavailable", error: "Enter an API key first." };
      }
      stagedProfile = await stageManualApiKeyProfile({
        profileId: plan.authProfileId,
        provider: plan.provider,
        apiKey,
        agentDir,
      });
      if (!stagedProfile) {
        return {
          ok: false,
          status: "unknown",
          error: "Could not update the auth profile store; try again in a moment.",
        };
      }
    }

    const test = await runSetupInferenceTest({ plan, tempDir, deps });
    if (!test.ok) {
      if (stagedProfile) {
        await rollbackManualApiKeyProfile({ ...stagedProfile, agentDir });
      }
      return test;
    }

    // Test passed — persist. Codex routes openai/* through the Codex plugin,
    // so make sure it is installed/enabled before the model ref lands in config.
    if (params.kind === "codex-cli") {
      const ensureCodex =
        deps.ensureCodexRuntimePlugin ??
        (await import("../commands/codex-runtime-plugin-install.js"))
          .ensureCodexRuntimePluginForModelSelection;
      const ensured = await ensureCodex({
        cfg,
        model: plan.modelRef,
        prompter: createQuickstartNotePrompter(params.runtime),
        runtime: params.runtime,
        workspaceDir: tempDir,
      });
      if (ensured.required) {
        const updateConfig =
          deps.updateConfig ?? (await import("../commands/models/shared.js")).updateConfig;
        const { enablePluginInConfig } = await import("../plugins/enable.js");
        await updateConfig((current) => enablePluginInConfig(current, "codex").config);
      }
    }
    if (stagedProfile && plan.authProfileId) {
      const updateConfig =
        deps.updateConfig ?? (await import("../commands/models/shared.js")).updateConfig;
      const { applyAuthProfileConfig } = await import("../plugins/provider-auth-helpers.js");
      const profileId = plan.authProfileId;
      const provider = plan.provider;
      await updateConfig((current) =>
        applyAuthProfileConfig(current, { profileId, provider, mode: "api_key" }),
      );
    }

    const applySetup = deps.applySetup ?? applyCrestodianSetup;
    const detection = params.workspace?.trim()
      ? { workspace: resolveUserPath(params.workspace) }
      : { workspace: (await detectSetupInference()).workspace };
    const applied = await applySetup({
      workspace: detection.workspace,
      ...(plan.persistModelRef ? { model: plan.persistModelRef } : {}),
      surface: params.surface,
      runtime: params.runtime,
    });
    return { ok: true, modelRef: plan.modelRef, latencyMs: test.latencyMs, lines: applied.lines };
  } finally {
    await (deps.removeTempDir ?? ((dir: string) => fs.rm(dir, { recursive: true, force: true })))(
      tempDir,
    );
  }
}

async function stageManualApiKeyProfile(params: {
  profileId: string;
  provider: string;
  apiKey: string;
  agentDir: string;
}): Promise<{ profileId: string; prior?: AuthProfileCredential } | null> {
  let prior: AuthProfileCredential | undefined;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
    updater: (store) => {
      prior = store.profiles[params.profileId];
      return false;
    },
  });
  if (updated === null) {
    return null;
  }
  const upserted = await upsertAuthProfileWithLock({
    profileId: params.profileId,
    credential: { type: "api_key", provider: params.provider, key: params.apiKey },
    agentDir: params.agentDir,
  });
  if (upserted === null) {
    return null;
  }
  return { profileId: params.profileId, ...(prior ? { prior } : {}) };
}

async function rollbackManualApiKeyProfile(params: {
  profileId: string;
  prior?: AuthProfileCredential;
  agentDir: string;
}): Promise<void> {
  await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
    updater: (store) => {
      if (params.prior) {
        store.profiles[params.profileId] = params.prior;
      } else {
        delete store.profiles[params.profileId];
      }
      return true;
    },
  });
}

async function runSetupInferenceTest(params: {
  plan: SetupInferenceTestPlan;
  tempDir: string;
  deps: ActivateSetupInferenceDeps;
}): Promise<
  { ok: true; latencyMs: number } | { ok: false; status: SetupInferenceStatus; error: string }
> {
  const { plan, tempDir, deps } = params;
  const runId = `setup-inference-${randomUUID()}`;
  const sessionId = `${runId}-session`;
  const sessionFile = path.join(tempDir, "session.jsonl");
  const timeoutMs = deps.timeoutMs ?? SETUP_INFERENCE_TEST_TIMEOUT_MS;
  const started = Date.now();
  try {
    let result: RunResult;
    if (plan.runner === "cli") {
      const runCli = deps.runCliAgent ?? (await import("../agents/cli-runner.js")).runCliAgent;
      result = (await runCli({
        sessionId,
        sessionKey: `temp:setup-inference:${runId}`,
        agentId: "crestodian",
        trigger: "manual",
        sessionFile,
        workspaceDir: tempDir,
        config: plan.config,
        prompt: SETUP_INFERENCE_TEST_PROMPT,
        provider: plan.provider,
        model: plan.model,
        timeoutMs,
        runId,
        messageChannel: "crestodian",
        messageProvider: "crestodian",
        cleanupCliLiveSessionOnRunEnd: true,
      })) as RunResult;
    } else {
      const runEmbedded =
        deps.runEmbeddedAgent ?? (await import("../agents/embedded-agent.js")).runEmbeddedAgent;
      result = (await runEmbedded({
        sessionId,
        sessionKey: `temp:setup-inference:${runId}`,
        agentId: "crestodian",
        trigger: "manual",
        sessionFile,
        workspaceDir: tempDir,
        config: plan.config,
        prompt: SETUP_INFERENCE_TEST_PROMPT,
        provider: plan.provider,
        model: plan.model,
        ...(plan.authProfileId
          ? { authProfileId: plan.authProfileId, authProfileIdSource: "user" as const }
          : {}),
        ...(plan.agentHarnessId
          ? { agentHarnessId: plan.agentHarnessId, cleanupBundleMcpOnRunEnd: true }
          : {}),
        timeoutMs,
        runId,
        lane: `setup-inference:${plan.provider}`,
        thinkLevel: "off",
        reasoningLevel: "off",
        verboseLevel: "off",
        streamParams: { maxTokens: SETUP_INFERENCE_TEST_MAX_TOKENS },
        disableTools: true,
        modelRun: true,
        messageChannel: "crestodian",
        messageProvider: "crestodian",
      })) as RunResult;
    }
    const text = extractRunText(result)?.trim();
    if (!text) {
      return {
        ok: false,
        status: "format",
        error: "The model started but did not send a reply. Try again or pick another option.",
      };
    }
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    const described = describeFailoverError(error);
    const { redactSecrets } = await import("../commands/status-all/format.js");
    return {
      ok: false,
      status: mapFailoverReasonToSetupStatus(described.reason),
      error: redactSecrets(described.message),
    };
  }
}
