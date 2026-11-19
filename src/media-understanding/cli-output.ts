import fs from "node:fs/promises";
import path from "node:path";
import { extractBalancedJsonFragments } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { ignoreMissingPath } from "../infra/errno.js";

function extractGeminiResponse(raw: string): string | null {
  const fragments = extractBalancedJsonFragments(raw, {
    openers: ["{"],
    skipQuotedOpeners: true,
  });
  for (const { json } of fragments.toReversed()) {
    try {
      const response = asOptionalRecord(JSON.parse(json))?.response;
      return typeof response === "string" ? response.trim() || null : null;
    } catch {
      // Malformed diagnostic noise is best effort; try the previous complete object.
    }
  }
  return null;
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
    return (await fs.readFile(fileOutput, "utf8").catch(ignoreMissingPath))?.trim() ?? "";
  }

  if (commandId === "gemini") {
    const response = extractGeminiResponse(params.stdout);
    if (response) {
      return response;
    }
  }

  if (commandId === "sherpa-onnx-offline") {
    const raw = params.stdout;
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
  }

  return params.stdout.trim();
}
