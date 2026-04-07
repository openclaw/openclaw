import fs from "node:fs";
import path from "node:path";
import { resolveRequiredHomeDir } from "../../infra/home-dir.js";

const SESSION_MEMORY_FILENAME = "session_memory.json";

export type SessionMemory = {
  lastSessionId?: string;
  lastSessionKey?: string;
  summary?: string;
  lastActiveAt?: number;
  userPreferences?: {
    thinkingLevel?: string;
    verboseLevel?: string;
    reasoningLevel?: string;
    ttsAuto?: string;
    modelOverride?: string;
    providerOverride?: string;
  };

import { createSubsystemLogger } from "../../infra/logger.js";
import { z } from "zod";

const log = createSubsystemLogger("session-memory-persist");

// Zod schema for validating persisted session memory
const UserPreferencesSchema = z.object({
  thinkingLevel: z.string().optional(),
  verboseLevel: z.string().optional(),
  reasoningLevel: z.string().optional(),
  ttsAuto: z.string().optional(),
  modelOverride: z.string().optional(),
  providerOverride: z.string().optional(),
});

const SessionMemorySchema = z.object({
  lastSessionId: z.string().optional(),
  lastSessionKey: z.string().optional(),
  summary: z.string().optional(),
  lastActiveAt: z.number().optional(),
  userPreferences: UserPreferencesSchema.optional(),
});
};

function resolveSessionMemoryPath(): string {
  const homeDir = resolveRequiredHomeDir(process.env, undefined);
  return path.join(homeDir, SESSION_MEMORY_FILENAME);
}

export async function saveSessionMemory(memory: SessionMemory): Promise<void> {
  const memoryPath = resolveSessionMemoryPath();
  try {
    const dir = path.dirname(memoryPath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(memoryPath, JSON.stringify(memory, null, 2), "utf-8");
  } catch (error) {
    // Log but don't fail - session memory is best-effort
    log.warn({ error: String(error) }, "Failed to save session memory");
  }
}

export async function loadSessionMemory(): Promise<SessionMemory | null> {
  const memoryPath = resolveSessionMemoryPath();
  try {
    const content = await fs.promises.readFile(memoryPath, "utf-8");
    const parsed = JSON.parse(content);
    // Validate with Zod - return null on validation failure
    const result = SessionMemorySchema.safeParse(parsed);
    if (!result.success) {
      log.warn({ error: result.error.message }, "Invalid session memory JSON, discarding");
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}

export async function clearSessionMemory(): Promise<void> {
  const memoryPath = resolveSessionMemoryPath();
  try {
    await fs.promises.unlink(memoryPath);
  } catch {
    // File doesn't exist - that's fine
  }
}

export async function updateSessionMemoryAfterRun(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: {
    thinkingLevel?: string;
    verboseLevel?: string;
    reasoningLevel?: string;
    ttsAuto?: string;
    modelOverride?: string;
    providerOverride?: string;
  };
  summary?: string;
}): Promise<void> {
  const memory: SessionMemory = {
    lastSessionId: params.sessionId,
    lastSessionKey: params.sessionKey,
    summary: params.summary,
    lastActiveAt: Date.now(),
    userPreferences: {
      thinkingLevel: params.sessionEntry.thinkingLevel,
      verboseLevel: params.sessionEntry.verboseLevel,
      reasoningLevel: params.sessionEntry.reasoningLevel,
      ttsAuto: params.sessionEntry.ttsAuto,
      modelOverride: params.sessionEntry.modelOverride,
      providerOverride: params.sessionEntry.providerOverride,
    },
  };
  await saveSessionMemory(memory);
}