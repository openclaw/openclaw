import fs from "node:fs/promises";
import path from "node:path";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { extractGeminiResponse } from "../../packages/media-understanding-common/src/output-extract.js";
import { hasErrnoCode } from "../infra/errors.js";

function extractSherpaOnnxText(raw: string): string | undefined {
  const tryParse = (value: string): string | undefined => {
    const trimmed = value.trim();
    const head = trimmed[0];
    if (head !== "{" && head !== '"') {
      return undefined;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") {
        return tryParse(parsed);
      }
      if (parsed && typeof parsed === "object" && "text" in parsed) {
        const text = parsed.text;
        if (typeof text === "string") {
          return text.trim();
        }
      }
    } catch {
      // Structured text is optional; CLI stdout can also contain non-JSON progress.
    }
    return undefined;
  };

  const direct = tryParse(raw);
  if (direct !== undefined) {
    return direct;
  }

  const lines = normalizeStringEntries(raw.split("\n"));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = tryParse(lines[i] ?? "");
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function findArgValue(args: string[], keys: string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (keys.includes(arg)) {
      const value = args[index + 1];
      if (value) {
        return value;
      }
    }
    for (const key of keys) {
      const prefix = `${key}=`;
      if (arg.startsWith(prefix)) {
        const value = arg.slice(prefix.length);
        if (value) {
          return value;
        }
      }
    }
  }
  return undefined;
}

function resolveWhisperOutputPath(args: string[], mediaPath: string): string | null {
  const outputDir = findArgValue(args, ["--output_dir", "-o"]);
  if (!outputDir) {
    return null;
  }
  const outputFormat = findArgValue(args, ["--output_format", "-f"]) ?? "all";
  if (outputFormat !== "txt" && outputFormat !== "all") {
    return null;
  }
  return path.join(outputDir, `${path.parse(mediaPath).name}.txt`);
}

function resolveWhisperCppOutputPath(args: string[]): string | null {
  if (!args.some((arg) => arg === "-otxt" || arg === "--output-txt")) {
    return null;
  }
  const outputBase = findArgValue(args, ["-of", "--output-file"]);
  if (!outputBase) {
    return null;
  }
  return `${outputBase}.txt`;
}

function resolveParakeetOutputPath(args: string[], mediaPath: string): string | null {
  const outputDir = findArgValue(args, ["--output-dir"]);
  const outputFormat =
    findArgValue(args, ["--output-format"]) ?? (process.env.PARAKEET_OUTPUT_FORMAT || "srt");
  const outputTemplate =
    findArgValue(args, ["--output-template"]) ??
    (process.env.PARAKEET_OUTPUT_TEMPLATE || "{filename}");
  if (
    !outputDir ||
    (outputFormat !== "txt" && outputFormat !== "all") ||
    outputTemplate !== "{filename}"
  ) {
    return null;
  }
  return path.join(outputDir, `${path.parse(mediaPath).name}.txt`);
}

async function readCliTranscriptFile(filePath: string): Promise<string> {
  try {
    return (await fs.readFile(filePath, "utf8")).trim();
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
}

export async function resolveCliOutput(params: {
  command: string;
  args: string[];
  stdout: string;
  mediaPath: string;
}): Promise<string> {
  const commandId = path.parse(params.command).name;
  const fileOutput =
    commandId === "whisper-cli"
      ? resolveWhisperCppOutputPath(params.args)
      : commandId === "whisper"
        ? resolveWhisperOutputPath(params.args, params.mediaPath)
        : commandId === "parakeet-mlx"
          ? resolveParakeetOutputPath(params.args, params.mediaPath)
          : null;
  if (fileOutput) {
    // A known file-output contract is authoritative: falling back would expose
    // progress/status stdout as user speech when transcription is empty or missing.
    return await readCliTranscriptFile(fileOutput);
  }

  if (commandId === "gemini") {
    const response = extractGeminiResponse(params.stdout);
    if (response) {
      return response;
    }
  }

  if (commandId === "sherpa-onnx-offline") {
    const response = extractSherpaOnnxText(params.stdout);
    if (response !== undefined) {
      return response;
    }
  }

  return params.stdout.trim();
}
