import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { parseModelRef } from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("llm-session-memory");

export type GeneratedContinuitySnapshot = {
  slug?: string;
  project?: string;
  currentTask?: string;
  currentPhase?: string;
  latestUserRequest?: string;
  blockers: string[];
  nextSteps: string[];
  keyArtifacts: string[];
  status?: string;
  priority?: string;
  conversationSummary?: string;
};

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeStatus(value: unknown): string | undefined {
  const normalized = normalizeString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["active", "blocked", "pending", "stale"].includes(normalized)) {
    return normalized;
  }
  return undefined;
}

function normalizePriority(value: unknown): string | undefined {
  const normalized = normalizeString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["highest", "high", "medium", "low"].includes(normalized)) {
    return normalized;
  }
  return undefined;
}

function sanitizeSlug(value: unknown): string | undefined {
  const normalized = normalizeString(value)
    ?.toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  return normalized || undefined;
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return trimmed.slice(start, end + 1);
}

export async function generateContinuitySnapshotViaLLM(params: {
  sessionContent: string;
  cfg: OpenClawConfig;
}): Promise<GeneratedContinuitySnapshot | null> {
  let tempSessionFile: string | null = null;

  try {
    const agentId = resolveDefaultAgentId(params.cfg);
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    const agentDir = resolveAgentDir(params.cfg, agentId);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-memory-"));
    tempSessionFile = path.join(tempDir, "session.jsonl");

    const prompt = [
      "Extract near-field continuity state from this conversation excerpt.",
      "Return JSON only.",
      "Schema:",
      "{",
      '  "slug": "short-kebab-case-topic",',
      '  "project": "short project name or unknown",',
      '  "currentTask": "single current in-flight task",',
      '  "currentPhase": "short current phase",',
      '  "latestUserRequest": "latest concrete request to continue",',
      '  "status": "active|blocked|pending|stale",',
      '  "priority": "highest|high|medium|low",',
      '  "blockers": ["current blocker 1"],',
      '  "nextSteps": ["next step 1"],',
      '  "keyArtifacts": ["relevant file, system, or artifact"],',
      '  "conversationSummary": "2-4 sentence summary focused on in-flight work"',
      "}",
      "Rules:",
      "- Focus on current active work, not timeless background.",
      "- Keep blockers and next steps concrete and short.",
      '- If unknown, use "unknown" or [].',
      "",
      "Conversation excerpt:",
      params.sessionContent.slice(0, 4000),
    ].join("\n");

    const modelRef = resolveAgentEffectiveModelPrimary(params.cfg, agentId);
    const parsed = modelRef ? parseModelRef(modelRef, DEFAULT_PROVIDER) : null;
    const provider = parsed?.provider ?? DEFAULT_PROVIDER;
    const model = parsed?.model ?? DEFAULT_MODEL;

    const result = await runEmbeddedPiAgent({
      sessionId: `continuity-memory-${Date.now()}`,
      sessionKey: "temp:continuity-memory",
      agentId,
      sessionFile: tempSessionFile,
      workspaceDir,
      agentDir,
      config: params.cfg,
      prompt,
      provider,
      model,
      timeoutMs: 20_000,
      runId: `continuity-memory-${Date.now()}`,
    });

    const rawText = result.payloads?.[0]?.text;
    if (!rawText) {
      return null;
    }
    const jsonText = extractJsonObject(rawText);
    if (!jsonText) {
      return null;
    }
    const parsedJson = JSON.parse(jsonText) as Record<string, unknown>;
    return {
      slug: sanitizeSlug(parsedJson.slug),
      project: normalizeString(parsedJson.project),
      currentTask: normalizeString(parsedJson.currentTask),
      currentPhase: normalizeString(parsedJson.currentPhase),
      latestUserRequest: normalizeString(parsedJson.latestUserRequest),
      blockers: normalizeStringList(parsedJson.blockers),
      nextSteps: normalizeStringList(parsedJson.nextSteps),
      keyArtifacts: normalizeStringList(parsedJson.keyArtifacts),
      status: normalizeStatus(parsedJson.status),
      priority: normalizePriority(parsedJson.priority),
      conversationSummary: normalizeString(parsedJson.conversationSummary),
    };
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error(`Failed to generate continuity snapshot: ${message}`);
    return null;
  } finally {
    if (tempSessionFile) {
      try {
        await fs.rm(path.dirname(tempSessionFile), { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
}
