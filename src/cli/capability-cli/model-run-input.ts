import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const MAX_MODEL_RUN_PROMPT_BYTES = 1024 * 1024;
const MAX_MODEL_RUN_OUTPUT_TOKENS = 1_000_000;

async function readBoundedPromptFile(handle: fs.FileHandle): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MAX_MODEL_RUN_PROMPT_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  if (offset > MAX_MODEL_RUN_PROMPT_BYTES) {
    throw new Error(`Model run prompt file must not exceed ${MAX_MODEL_RUN_PROMPT_BYTES} bytes.`);
  }
  return buffer.subarray(0, offset);
}

function requireModelRunPrompt(value: unknown): string {
  if (typeof value !== "string" || normalizeOptionalString(value) === undefined) {
    throw new Error("--prompt cannot be empty or whitespace-only.");
  }
  return value;
}

async function readModelRunPromptFile(filePath: string): Promise<string> {
  if (process.platform === "win32") {
    throw new Error("--prompt-file is supported only on POSIX hosts.");
  }
  const resolvedPath = path.resolve(filePath);
  const initialStat = await fs.lstat(resolvedPath);
  if (initialStat.isSymbolicLink()) {
    throw new Error(`Model run prompt file must not be a symbolic link: ${resolvedPath}`);
  }
  if (!initialStat.isFile()) {
    throw new Error(`Model run prompt file must be a regular file: ${resolvedPath}`);
  }
  if ((initialStat.mode & 0o777) !== 0o600) {
    throw new Error(`Model run prompt file must have mode 0600: ${resolvedPath}`);
  }
  if (typeof process.getuid !== "function" || initialStat.uid !== process.getuid()) {
    throw new Error(`Model run prompt file must be owned by the current user: ${resolvedPath}`);
  }
  if (initialStat.size === 0) {
    throw new Error("Model run prompt file cannot be empty.");
  }
  if (initialStat.size > MAX_MODEL_RUN_PROMPT_BYTES) {
    throw new Error(
      `Model run prompt file must not exceed ${MAX_MODEL_RUN_PROMPT_BYTES} bytes: ${resolvedPath}`,
    );
  }

  const handle = await fs.open(resolvedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const openedStat = await handle.stat();
    if (openedStat.dev !== initialStat.dev || openedStat.ino !== initialStat.ino) {
      throw new Error(`Model run prompt file changed while opening: ${resolvedPath}`);
    }
    const buffer = await readBoundedPromptFile(handle);
    return requireModelRunPrompt(buffer.toString("utf8"));
  } finally {
    await handle.close();
  }
}

export async function resolveModelRunPrompt(params: {
  prompt: unknown;
  promptFile: unknown;
}): Promise<string> {
  const prompt = typeof params.prompt === "string" ? params.prompt : undefined;
  const promptFile = typeof params.promptFile === "string" ? params.promptFile : undefined;
  if ((prompt === undefined) === (promptFile === undefined)) {
    throw new Error("Use exactly one of --prompt or --prompt-file.");
  }
  return promptFile === undefined
    ? requireModelRunPrompt(prompt)
    : await readModelRunPromptFile(promptFile);
}

export function normalizeModelRunMaxOutputTokens(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_MODEL_RUN_OUTPUT_TOKENS) {
    throw new Error(
      `--max-output-tokens must be an integer from 1 to ${MAX_MODEL_RUN_OUTPUT_TOKENS}.`,
    );
  }
  return parsed;
}

export function normalizeModelRunTemperature(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
    throw new Error("--temperature must be a number from 0 to 2.");
  }
  return parsed;
}

export type ModelRunRequestedOverrides = {
  maxTokens?: number;
  temperature?: number;
};

export function buildModelRunRequestedOverrides(options: ModelRunRequestedOverrides) {
  return {
    ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  };
}
