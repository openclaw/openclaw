/**
 * Extract Memories hook handler
 *
 * Analyzes recent conversations on message:sent events and extracts
 * noteworthy information into memory topic files.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../../config/config.js";
import { resolveStateDir } from "../../../config/paths.js";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";

const log = createSubsystemLogger("hooks/extract-memories");

// Per-session state for cooldown and message counting
const sessionState = new Map<string, { lastExtractAt: number; messageCount: number }>();

const DEFAULT_COOLDOWN_MINUTES = 5;
const DEFAULT_MIN_MESSAGES = 3;
const DEFAULT_MODEL = "gemini-2.0-flash";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_API_KEY_ENV = "GEMINI_API_KEY";

type MemoryEntry = {
  filename: string;
  type: "user" | "feedback" | "project" | "reference";
  name: string;
  description: string;
  content: string;
};

async function listTopicFiles(topicsDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(topicsDir);
    return entries.filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

async function callLLM(params: {
  messages: Array<{ role: string; content: string }>;
  model: string;
  baseUrl: string;
  apiKey: string;
}): Promise<string | null> {
  const url = `${params.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? null;
}

async function extractMemoriesFromConversation(params: {
  conversationContent: string;
  existingTopics: string[];
  model: string;
  baseUrl: string;
  apiKey: string;
}): Promise<MemoryEntry[]> {
  const existingList =
    params.existingTopics.length > 0
      ? `Existing topic files: ${params.existingTopics.join(", ")}`
      : "No existing topic files.";

  const systemPrompt = `You are a memory extraction agent. Analyze the recent conversation and identify information worth remembering long-term.

Types to save:
- user: role, preferences, knowledge level
- feedback: corrections and confirmations of approach
- project: ongoing work context not derivable from code
- reference: pointers to external systems, API endpoints

Do NOT save: code patterns, git history, debugging solutions, ephemeral task details.

${existingList}

If there is something worth remembering, return JSON:
{
  "memories": [
    {
      "filename": "topic-name.md",
      "type": "user|feedback|project|reference",
      "name": "Short title",
      "description": "One-line description",
      "content": "The actual memory content"
    }
  ]
}

If nothing is worth remembering, return: { "memories": [] }`;

  const raw = await callLLM({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: params.conversationContent },
    ],
    model: params.model,
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
  });

  if (!raw) {
    return [];
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { memories?: unknown };
    return Array.isArray(parsed.memories) ? (parsed.memories as MemoryEntry[]) : [];
  } catch {
    log.debug("Failed to parse LLM JSON response");
    return [];
  }
}

function yamlEscape(value: string): string {
  if (/[:\n\r"'#{}[\],&*?|>!%@`]/.test(value) || value.trim() !== value) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function buildTopicFileContent(entry: MemoryEntry): string {
  return [
    "---",
    `name: ${yamlEscape(entry.name)}`,
    `type: ${yamlEscape(entry.type)}`,
    `description: ${yamlEscape(entry.description)}`,
    "---",
    "",
    entry.content,
    "",
  ].join("\n");
}

function sanitizeFilename(raw: string): string {
  return raw
    .replace(/[^a-z0-9._-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function updateMemoryIndex(params: {
  memoryDir: string;
  entries: Array<{ name: string; safeFilename: string; description: string }>;
}): Promise<void> {
  const indexPath = path.join(params.memoryDir, "MEMORY.md");
  try {
    await fs.access(indexPath);
  } catch {
    return;
  }

  const lines = params.entries.map(
    (e) => `- [${e.name}](topics/${e.safeFilename}): ${e.description}`,
  );
  const addition = "\n" + lines.join("\n") + "\n";

  const existing = await fs.readFile(indexPath, "utf-8");
  await fs.writeFile(indexPath, existing + addition, "utf-8");
}

/**
 * Extract memories from conversation on message:sent events
 */
const extractMemories: HookHandler = async (event) => {
  if (event.type !== "message" || event.action !== "sent") {
    return;
  }

  const sk = event.sessionKey ?? "__default__";
  let state = sessionState.get(sk);
  if (!state) {
    state = { lastExtractAt: 0, messageCount: 0 };
    sessionState.set(sk, state);
  }
  state.messageCount += 1;

  try {
    // Load config globally (message:sent context does not carry cfg/workspaceDir)
    let cfg;
    try {
      cfg = loadConfig();
    } catch {
      cfg = undefined;
    }
    const hookConfig = resolveHookConfig(cfg, "extract-memories");

    const cooldownMinutes =
      typeof hookConfig?.cooldownMinutes === "number"
        ? hookConfig.cooldownMinutes
        : DEFAULT_COOLDOWN_MINUTES;
    const minMessages =
      typeof hookConfig?.minMessages === "number" ? hookConfig.minMessages : DEFAULT_MIN_MESSAGES;
    const model =
      typeof hookConfig?.model === "string" ? hookConfig.model : DEFAULT_MODEL;
    const baseUrl =
      typeof hookConfig?.baseUrl === "string" ? hookConfig.baseUrl : DEFAULT_BASE_URL;
    const apiKeyEnv =
      typeof hookConfig?.apiKeyEnv === "string" ? hookConfig.apiKeyEnv : DEFAULT_API_KEY_ENV;

    const now = Date.now();
    if (now - state.lastExtractAt < cooldownMinutes * 60_000) {
      return;
    }
    if (state.messageCount < minMessages) {
      return;
    }

    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      log.debug(`Skipping: env var ${apiKeyEnv} not set`);
      return;
    }

    const workspaceDir = path.join(resolveStateDir(process.env, os.homedir), "workspace");
    const memoryDir = path.join(workspaceDir, "memory");
    const topicsDir = path.join(memoryDir, "topics");
    await fs.mkdir(topicsDir, { recursive: true });

    const context = event.context || {};
    const messageContent = typeof context.content === "string" ? context.content : "";
    if (!messageContent) {
      return;
    }

    const existingTopics = await listTopicFiles(topicsDir);

    log.debug("Running memory extraction", { model, existingTopics: existingTopics.length });

    const memories = await extractMemoriesFromConversation({
      conversationContent: messageContent,
      existingTopics,
      model,
      baseUrl,
      apiKey,
    });

    if (memories.length === 0) {
      log.debug("No memories to extract");
      state.lastExtractAt = now;
      state.messageCount = 0;
      return;
    }

    const indexEntries: Array<{ name: string; safeFilename: string; description: string }> = [];

    for (const entry of memories) {
      const safeFilename = sanitizeFilename(entry.filename);
      if (!safeFilename) {
        continue;
      }

      const content = buildTopicFileContent(entry);
      await writeFileWithinRoot({
        rootDir: topicsDir,
        relativePath: safeFilename,
        data: content,
        encoding: "utf-8",
        mkdir: true,
      });
      indexEntries.push({ name: entry.name, safeFilename, description: entry.description });
      log.info(`Memory saved: topics/${safeFilename}`);
    }

    if (indexEntries.length > 0) {
      await updateMemoryIndex({ memoryDir, entries: indexEntries });
    }

    state.lastExtractAt = now;
    state.messageCount = 0;
  } catch (err) {
    if (err instanceof Error) {
      log.error("Failed to extract memories", {
        errorName: err.name,
        errorMessage: err.message,
      });
    } else {
      log.error("Failed to extract memories", { error: String(err) });
    }
  }
};

export default extractMemories;
