import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { upsertAuthProfileWithLock } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/config.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import {
  VLLM_DEFAULT_BASE_URL,
  applyVllmProviderConfig,
  normalizeVllmBaseUrl,
  promptAndConfigureVllm,
} from "../vllm-setup.js";
import { applyDefaultModelPrimaryUpdate, updateConfig } from "./shared.js";

type ConfigureVllmOptions = {
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
  agent?: string;
};

function requireConfigSnapshot() {
  return readConfigFileSnapshot().then((snapshot) => {
    if (!snapshot.valid) {
      const issues = snapshot.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
      throw new Error(`Invalid config at ${snapshot.path}\n${issues}`);
    }
    return snapshot;
  });
}

function resolveAgentContext(params: { cfg: OpenClawConfig; agent?: string }) {
  const rawAgent = params.agent?.trim();
  const agentId = rawAgent || resolveDefaultAgentId(params.cfg);
  return { agentId, agentDir: resolveAgentDir(params.cfg, agentId) };
}

function ensureNonInteractiveInput(params: { apiKey?: string; modelId?: string }) {
  const missing: string[] = [];
  if (!params.apiKey?.trim()) {
    missing.push("--api-key");
  }
  if (!params.modelId?.trim()) {
    missing.push("--model-id");
  }
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(" and ")}. Provide it or run with a TTY for prompts.`);
  }
}

export async function modelsConfigureVllmCommand(opts: ConfigureVllmOptions, runtime: RuntimeEnv) {
  const snapshot = await requireConfigSnapshot();
  const cfg = snapshot.config;
  const { agentDir } = resolveAgentContext({ cfg, agent: opts.agent });

  const hasTty = Boolean(process.stdin.isTTY);
  const needsPrompt = !opts.apiKey?.trim() || !opts.modelId?.trim();

  let baseUrl = VLLM_DEFAULT_BASE_URL;
  let modelId = "";
  let modelRef = "";

  if (needsPrompt) {
    if (!hasTty) {
      ensureNonInteractiveInput({ apiKey: opts.apiKey, modelId: opts.modelId });
    }
    const prompter = createClackPrompter();
    const promptResult = await promptAndConfigureVllm({
      cfg,
      prompter,
      agentDir,
    });
    baseUrl = promptResult.baseUrl;
    modelId = promptResult.modelId;
    modelRef = promptResult.modelRef;
  } else {
    const apiKey = String(opts.apiKey ?? "").trim();
    modelId = String(opts.modelId ?? "").trim();
    baseUrl = normalizeVllmBaseUrl(opts.baseUrl ?? VLLM_DEFAULT_BASE_URL);
    modelRef = `vllm/${modelId}`;

    await upsertAuthProfileWithLock({
      profileId: "vllm:default",
      credential: { type: "api_key", provider: "vllm", key: apiKey },
      agentDir,
    });
  }

  const updated = await updateConfig((current) => {
    const { config } = applyVllmProviderConfig({
      cfg: current,
      baseUrl,
      modelId,
    });
    return applyDefaultModelPrimaryUpdate({
      cfg: config,
      modelRaw: modelRef,
      field: "model",
    });
  });

  logConfigUpdated(runtime);
  runtime.log(`Default model: ${updated.agents?.defaults?.model?.primary ?? modelRef}`);
}
