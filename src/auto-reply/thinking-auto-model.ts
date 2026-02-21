import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { SkillSnapshot } from "../agents/skills.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  AUTO_THINK_CONFIDENCE_THRESHOLD,
  buildAutoThinkClassifierPrompt,
  parseAutoThinkDecision,
} from "./thinking-auto.js";
import type { ThinkLevel } from "./thinking.js";

type ResolveAutoThinkingLevelWithModelParams = {
  cfg: OpenClawConfig;
  agentDir: string;
  workspaceDir: string;
  skillsSnapshot?: SkillSnapshot;
  provider: string;
  model: string;
  text: string;
  timeoutMs: number;
  supportsXHigh: boolean;
};

const AUTO_THINK_TIMEOUT_MS = 12_000;

function normalizeClassifierThinkLevel(params: {
  level: ThinkLevel;
  supportsXHigh: boolean;
}): ThinkLevel {
  if (params.level === "xhigh" && !params.supportsXHigh) {
    return "high";
  }
  return params.level;
}

export async function resolveAutoThinkingLevelWithModel(
  params: ResolveAutoThinkingLevelWithModelParams,
): Promise<ThinkLevel | undefined> {
  const input = params.text.trim();
  if (!input) {
    return undefined;
  }

  const sessionId = `auto-think-${crypto.randomUUID()}`;
  const runId = `auto-think-${crypto.randomUUID()}`;
  const tempDir = path.join(params.workspaceDir, ".openclaw", "tmp");
  const sessionFile = path.join(tempDir, `${sessionId}.jsonl`);

  await fs.mkdir(tempDir, { recursive: true });

  try {
    const result = await runEmbeddedPiAgent({
      sessionId,
      sessionFile,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      config: params.cfg,
      skillsSnapshot: params.skillsSnapshot,
      prompt: buildAutoThinkClassifierPrompt(input),
      disableTools: true,
      suppressToolErrorWarnings: true,
      provider: params.provider,
      model: params.model,
      thinkLevel: "low",
      verboseLevel: "off",
      reasoningLevel: "off",
      timeoutMs: Math.min(params.timeoutMs, AUTO_THINK_TIMEOUT_MS),
      runId,
    });

    const raw =
      result.payloads
        ?.map((payload) => payload.text ?? "")
        .join("\n")
        .trim() ?? "";
    if (!raw) {
      return undefined;
    }

    const decision = parseAutoThinkDecision(raw);
    if (!decision) {
      return undefined;
    }
    if (decision.confidence < AUTO_THINK_CONFIDENCE_THRESHOLD) {
      return undefined;
    }

    return normalizeClassifierThinkLevel({
      level: decision.think,
      supportsXHigh: params.supportsXHigh,
    });
  } catch {
    return undefined;
  } finally {
    await fs.rm(sessionFile, { force: true }).catch(() => undefined);
  }
}
