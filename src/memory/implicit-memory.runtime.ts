import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "../config/config.js";
import { runCommandWithTimeout } from "../process/exec.js";

const MEMORY_MANAGER_PATH = fileURLToPath(new URL("./memory_manager.py", import.meta.url));
const PYTHON_CANDIDATES = ["python3", "python"] as const;
const RETRIEVE_TIMEOUT_MS = 1_500;
const SAVE_TIMEOUT_MS = 2_000;
const MAX_SAVED_RULE_CHARS = 4_000;
const MAX_SAVED_INTENT_CHARS = 500;

export function isAutoMemoryEnabled(config: OpenClawConfig | undefined): boolean {
  return config?.memory?.implicit?.enabled === true;
}

export async function retrieveImplicitContext(userQuery: string): Promise<string | null> {
  const normalizedQuery = userQuery.trim();
  if (!normalizedQuery) {
    return null;
  }
  const stdout = await runMemoryManagerCommand(
    ["retrieve", "--query", normalizedQuery],
    RETRIEVE_TIMEOUT_MS,
  );
  const context = stdout.trim();
  return context ? context : null;
}

export async function saveImplicitExperience(params: {
  intent: string;
  rules: string;
}): Promise<void> {
  const intent = sanitizeStoredValue(params.intent, MAX_SAVED_INTENT_CHARS);
  const rules = sanitizeStoredValue(params.rules, MAX_SAVED_RULE_CHARS);
  if (!intent || !rules) {
    return;
  }

  await runMemoryManagerCommand(["save", "--intent", intent, "--rules", rules], SAVE_TIMEOUT_MS);
}

export function buildImplicitMemoryWriteback(params: {
  userInput: string;
  assistantTexts: string[];
  success: boolean;
  error?: string;
}): { intent: string; rules: string } | null {
  // Seed the store with a lightweight turn summary until a dedicated
  // post-turn distillation model is wired in.
  const intent = sanitizeStoredValue(params.userInput, MAX_SAVED_INTENT_CHARS);
  if (!intent) {
    return null;
  }

  const assistantText = sanitizeStoredValue(
    params.assistantTexts.join("\n\n"),
    MAX_SAVED_RULE_CHARS,
  );
  const errorText = sanitizeStoredValue(params.error ?? "", MAX_SAVED_RULE_CHARS);
  const detail = assistantText || errorText;
  if (!detail) {
    return null;
  }

  const outcome = params.success ? "success" : "failure";
  const label = assistantText ? "Assistant output" : "Error";
  return {
    intent,
    rules: sanitizeStoredValue(`Outcome: ${outcome}\n${label}: ${detail}`, MAX_SAVED_RULE_CHARS),
  };
}

async function runMemoryManagerCommand(args: string[], timeoutMs: number): Promise<string> {
  let lastError: unknown = null;

  for (const python of PYTHON_CANDIDATES) {
    try {
      const result = await runCommandWithTimeout([python, MEMORY_MANAGER_PATH, ...args], {
        timeoutMs,
      });
      if (result.code === 0) {
        return result.stdout;
      }
      lastError = new Error(
        result.stderr || result.stdout || `${python} exited with ${result.code}`,
      );
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sanitizeStoredValue(value: string, maxChars: number): string {
  const normalized = value.replaceAll("\u0000", "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(0, maxChars);
}
