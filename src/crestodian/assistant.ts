import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { extractAssistantText } from "../agents/pi-embedded-utils.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "../agents/simple-completion-runtime.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CrestodianOverview } from "./overview.js";

const CRESTODIAN_ASSISTANT_TIMEOUT_MS = 10_000;
const CRESTODIAN_ASSISTANT_MAX_TOKENS = 512;
const CRESTODIAN_CLAUDE_CLI_MODEL = "claude-opus-4-7";
const CRESTODIAN_CODEX_MODEL = "gpt-5.5";

const CRESTODIAN_ASSISTANT_SYSTEM_PROMPT = [
  "You are Crestodian, OpenClaw's ring-zero setup helper.",
  "Turn the user's request into exactly one safe OpenClaw Crestodian command.",
  "Return only compact JSON with keys reply and command.",
  "Do not invent commands. Do not claim a write was applied.",
  "Do not use tools, shell commands, file edits, or network lookups; plan only from the supplied overview.",
  "Use the provided OpenClaw docs/source references when the user's request needs behavior, config, or architecture details.",
  "If local source is available, prefer inspecting it. Otherwise point to GitHub and strongly recommend reviewing source when docs are not enough.",
  "Allowed commands:",
  "- setup",
  "- status",
  "- health",
  "- doctor",
  "- doctor fix",
  "- gateway status",
  "- restart gateway",
  "- start gateway",
  "- stop gateway",
  "- agents",
  "- models",
  "- audit",
  "- validate config",
  "- set default model <provider/model>",
  "- config set <path> <value>",
  "- config set-ref <path> env <ENV_VAR>",
  "- create agent <id> workspace <path> model <provider/model>",
  "- talk to <id> agent",
  "- talk to agent",
  "If unsure, choose overview.",
].join("\n");

export type CrestodianAssistantPlan = {
  command: string;
  reply?: string;
  modelLabel?: string;
};

export type CrestodianAssistantPlanner = (params: {
  input: string;
  overview: CrestodianOverview;
}) => Promise<CrestodianAssistantPlan | null>;

type RunCliAgentFn = typeof import("../agents/cli-runner.js").runCliAgent;
type RunEmbeddedPiAgentFn = typeof import("../agents/pi-embedded.js").runEmbeddedPiAgent;

export type CrestodianLocalRuntimePlannerDeps = {
  runCliAgent?: RunCliAgentFn;
  runEmbeddedPiAgent?: RunEmbeddedPiAgentFn;
  createTempDir?: () => Promise<string>;
  removeTempDir?: (dir: string) => Promise<void>;
};

type LocalPlannerCandidate = "claude-cli" | "codex-app-server" | "codex-cli";

export async function planCrestodianCommand(params: {
  input: string;
  overview: CrestodianOverview;
  deps?: CrestodianLocalRuntimePlannerDeps;
}): Promise<CrestodianAssistantPlan | null> {
  const configured = await planCrestodianCommandWithConfiguredModel(params);
  if (configured) {
    return configured;
  }
  return await planCrestodianCommandWithLocalRuntime(params);
}

export async function planCrestodianCommandWithConfiguredModel(params: {
  input: string;
  overview: CrestodianOverview;
}): Promise<CrestodianAssistantPlan | null> {
  const input = params.input.trim();
  if (!input) {
    return null;
  }
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.exists || !snapshot.valid) {
    return null;
  }
  const cfg = snapshot.runtimeConfig ?? snapshot.config;
  const agentId = resolveDefaultAgentId(cfg);
  const prepared = await prepareSimpleCompletionModelForAgent({
    cfg,
    agentId,
    allowMissingApiKeyModes: ["aws-sdk"],
  });
  if ("error" in prepared) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CRESTODIAN_ASSISTANT_TIMEOUT_MS);
  try {
    const response = await completeWithPreparedSimpleCompletionModel({
      model: prepared.model,
      auth: prepared.auth,
      context: {
        systemPrompt: CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildCrestodianAssistantUserPrompt({
              input,
              overview: params.overview,
            }),
            timestamp: Date.now(),
          },
        ],
      },
      options: {
        maxTokens: CRESTODIAN_ASSISTANT_MAX_TOKENS,
        signal: controller.signal,
      },
    });
    const parsed = parseCrestodianAssistantPlanText(extractAssistantText(response));
    if (!parsed) {
      return null;
    }
    return {
      ...parsed,
      modelLabel: `${prepared.selection.provider}/${prepared.selection.modelId}`,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function planCrestodianCommandWithLocalRuntime(params: {
  input: string;
  overview: CrestodianOverview;
  deps?: CrestodianLocalRuntimePlannerDeps;
}): Promise<CrestodianAssistantPlan | null> {
  const input = params.input.trim();
  if (!input) {
    return null;
  }
  const candidates = listLocalRuntimePlannerCandidates(params.overview);
  if (candidates.length === 0) {
    return null;
  }
  const prompt = buildCrestodianAssistantUserPrompt({
    input,
    overview: params.overview,
  });

  for (const candidate of candidates) {
    try {
      const rawText = await runLocalRuntimePlanner(candidate, {
        prompt,
        deps: params.deps,
      });
      const parsed = parseCrestodianAssistantPlanText(rawText);
      if (parsed) {
        return {
          ...parsed,
          modelLabel: localRuntimePlannerLabel(candidate),
        };
      }
    } catch {
      // Try the next locally available runtime. Crestodian must keep booting.
    }
  }
  return null;
}

export function buildCrestodianAssistantUserPrompt(params: {
  input: string;
  overview: CrestodianOverview;
}): string {
  const agents = params.overview.agents
    .map((agent) => {
      const fields = [
        `id=${agent.id}`,
        agent.name ? `name=${agent.name}` : undefined,
        agent.workspace ? `workspace=${agent.workspace}` : undefined,
        agent.model ? `model=${agent.model}` : undefined,
        agent.isDefault ? "default=true" : undefined,
      ].filter(Boolean);
      return `- ${fields.join(", ")}`;
    })
    .join("\n");
  return [
    `User request: ${params.input}`,
    "",
    `Default agent: ${params.overview.defaultAgentId}`,
    `Default model: ${params.overview.defaultModel ?? "not configured"}`,
    `Config valid: ${params.overview.config.valid}`,
    `Gateway reachable: ${params.overview.gateway.reachable}`,
    `Codex CLI: ${params.overview.tools.codex.found ? "found" : "not found"}`,
    `Claude Code CLI: ${params.overview.tools.claude.found ? "found" : "not found"}`,
    `OpenAI API key: ${params.overview.tools.apiKeys.openai ? "found" : "not found"}`,
    `Anthropic API key: ${params.overview.tools.apiKeys.anthropic ? "found" : "not found"}`,
    `OpenClaw docs: ${params.overview.references.docsPath ?? params.overview.references.docsUrl}`,
    `OpenClaw source: ${
      params.overview.references.sourcePath ?? params.overview.references.sourceUrl
    }`,
    params.overview.references.sourcePath
      ? "Source mode: local git checkout; inspect source directly when docs are insufficient."
      : "Source mode: package/install; use GitHub source when docs are insufficient.",
    "",
    "Agents:",
    agents || "- none",
  ].join("\n");
}

export function parseCrestodianAssistantPlanText(
  rawText: string | undefined,
): CrestodianAssistantPlan | null {
  const text = rawText?.trim();
  if (!text) {
    return null;
  }
  const jsonText = extractFirstJsonObject(text);
  if (!jsonText) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (!command) {
    return null;
  }
  const reply = typeof record.reply === "string" ? record.reply.trim() : undefined;
  return {
    command,
    ...(reply ? { reply } : {}),
  };
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

function listLocalRuntimePlannerCandidates(overview: CrestodianOverview): LocalPlannerCandidate[] {
  const candidates: LocalPlannerCandidate[] = [];
  if (overview.tools.claude.found) {
    candidates.push("claude-cli");
  }
  if (overview.tools.codex.found) {
    candidates.push("codex-app-server", "codex-cli");
  }
  return candidates;
}

function localRuntimePlannerLabel(candidate: LocalPlannerCandidate): string {
  const labels: Record<LocalPlannerCandidate, string> = {
    "claude-cli": `claude-cli/${CRESTODIAN_CLAUDE_CLI_MODEL}`,
    "codex-app-server": `openai/${CRESTODIAN_CODEX_MODEL} via codex`,
    "codex-cli": `codex-cli/${CRESTODIAN_CODEX_MODEL}`,
  };
  return labels[candidate];
}

async function runLocalRuntimePlanner(
  candidate: LocalPlannerCandidate,
  params: {
    prompt: string;
    deps?: CrestodianLocalRuntimePlannerDeps;
  },
): Promise<string | undefined> {
  const tempDir = await (params.deps?.createTempDir ?? createTempPlannerDir)();
  try {
    const runId = `crestodian-planner-${randomUUID()}`;
    const sessionFile = path.join(tempDir, "session.jsonl");
    const sessionId = `${runId}-session`;
    const sessionKey = `temp:crestodian-planner:${runId}`;
    switch (candidate) {
      case "claude-cli": {
        const runCli = params.deps?.runCliAgent ?? (await loadRunCliAgent());
        const result = await runCli({
          sessionId,
          sessionKey,
          agentId: "crestodian",
          trigger: "manual",
          sessionFile,
          workspaceDir: tempDir,
          config: buildCliPlannerConfig(tempDir, `claude-cli/${CRESTODIAN_CLAUDE_CLI_MODEL}`),
          prompt: params.prompt,
          provider: "claude-cli",
          model: CRESTODIAN_CLAUDE_CLI_MODEL,
          timeoutMs: CRESTODIAN_ASSISTANT_TIMEOUT_MS,
          runId,
          extraSystemPrompt: CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
          extraSystemPromptStatic: CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
          messageChannel: "crestodian",
          messageProvider: "crestodian",
          senderIsOwner: true,
          cleanupCliLiveSessionOnRunEnd: true,
        });
        return extractPlannerResultText(result);
      }
      case "codex-app-server": {
        const runEmbedded = params.deps?.runEmbeddedPiAgent ?? (await loadRunEmbeddedPiAgent());
        const result = await runEmbedded({
          sessionId,
          sessionKey,
          agentId: "crestodian",
          trigger: "manual",
          sessionFile,
          workspaceDir: tempDir,
          config: buildCodexAppServerPlannerConfig(tempDir),
          prompt: params.prompt,
          provider: "openai",
          model: CRESTODIAN_CODEX_MODEL,
          agentHarnessId: "codex",
          disableTools: true,
          toolsAllow: [],
          timeoutMs: CRESTODIAN_ASSISTANT_TIMEOUT_MS,
          runId,
          extraSystemPrompt: CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
          messageChannel: "crestodian",
          messageProvider: "crestodian",
          senderIsOwner: true,
          cleanupBundleMcpOnRunEnd: true,
        });
        return extractPlannerResultText(result);
      }
      case "codex-cli": {
        const runCli = params.deps?.runCliAgent ?? (await loadRunCliAgent());
        const result = await runCli({
          sessionId,
          sessionKey,
          agentId: "crestodian",
          trigger: "manual",
          sessionFile,
          workspaceDir: tempDir,
          config: buildCliPlannerConfig(tempDir, `codex-cli/${CRESTODIAN_CODEX_MODEL}`),
          prompt: params.prompt,
          provider: "codex-cli",
          model: CRESTODIAN_CODEX_MODEL,
          timeoutMs: CRESTODIAN_ASSISTANT_TIMEOUT_MS,
          runId,
          extraSystemPrompt: CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
          extraSystemPromptStatic: CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
          messageChannel: "crestodian",
          messageProvider: "crestodian",
          senderIsOwner: true,
          cleanupCliLiveSessionOnRunEnd: true,
        });
        return extractPlannerResultText(result);
      }
    }
    return undefined;
  } finally {
    await (params.deps?.removeTempDir ?? removeTempPlannerDir)(tempDir);
  }
}

function buildCliPlannerConfig(workspaceDir: string, modelRef: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: { primary: modelRef },
      },
    },
  };
}

function buildCodexAppServerPlannerConfig(workspaceDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        embeddedHarness: { runtime: "codex", fallback: "none" },
        model: { primary: `openai/${CRESTODIAN_CODEX_MODEL}` },
      },
    },
    plugins: {
      entries: {
        codex: { enabled: true },
      },
    },
  };
}

async function createTempPlannerDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-crestodian-planner-"));
}

async function removeTempPlannerDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

async function loadRunCliAgent(): Promise<RunCliAgentFn> {
  return (await import("../agents/cli-runner.js")).runCliAgent;
}

async function loadRunEmbeddedPiAgent(): Promise<RunEmbeddedPiAgentFn> {
  return (await import("../agents/pi-embedded.js")).runEmbeddedPiAgent;
}

function extractPlannerResultText(result: {
  payloads?: Array<{ text?: string }>;
  meta?: {
    finalAssistantVisibleText?: string;
    finalAssistantRawText?: string;
  };
}): string | undefined {
  return (
    result.meta?.finalAssistantVisibleText ??
    result.meta?.finalAssistantRawText ??
    result.payloads
      ?.map((payload) => payload.text?.trim())
      .filter(Boolean)
      .join("\n")
  );
}
