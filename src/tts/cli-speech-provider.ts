import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import type { ResolvedTtsConfig } from "./tts.js";

const execFileAsync = promisify(execFile);

const DEFAULT_CLI_TIMEOUT_SECONDS = 30;
const DEFAULT_CLI_OUTPUT_FORMAT = "wav";

/**
 * Substitute `{{TEXT_FILE}}` and `{{OUTPUT_FILE}}` placeholders in CLI args.
 * Also supports `{{VOICE}}` and `{{MODEL}}` for optional pass-through.
 */
export function substituteCliArgs(args: readonly string[], vars: Record<string, string>): string[] {
  return args.map((arg) =>
    arg.replace(/\{\{(\w+)\}\}/g, (match, key: string) => vars[key] ?? match),
  );
}

function resolveCliConfig(config: ResolvedTtsConfig) {
  return config.cli;
}

export function buildCliSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "cli",
    label: "CLI",
    isConfigured: ({ config }) => {
      const cli = resolveCliConfig(config);
      return Boolean(cli?.command);
    },
    synthesize: async (req) => {
      const cli = resolveCliConfig(req.config);
      if (!cli?.command) {
        throw new Error("CLI TTS command not configured");
      }

      const timeoutMs = (cli.timeoutSeconds ?? DEFAULT_CLI_TIMEOUT_SECONDS) * 1000;
      const outputFormat = cli.outputFormat ?? DEFAULT_CLI_OUTPUT_FORMAT;
      const fileExtension = `.${outputFormat}`;

      // Create a temp directory for text input and audio output.
      const tmpRoot = resolvePreferredOpenClawTmpDir();
      mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
      const tmpDir = mkdtempSync(path.join(tmpRoot, "tts-cli-"));
      const textFile = path.join(tmpDir, "input.txt");
      const outputFile = path.join(tmpDir, `output${fileExtension}`);

      try {
        writeFileSync(textFile, req.text, "utf8");

        const vars: Record<string, string> = {
          TEXT_FILE: textFile,
          OUTPUT_FILE: outputFile,
          ...(cli.voice ? { VOICE: cli.voice } : {}),
          ...(cli.model ? { MODEL: cli.model } : {}),
        };

        const args = cli.args ? substituteCliArgs(cli.args, vars) : [textFile, outputFile];

        await execFileAsync(cli.command, args, {
          timeout: timeoutMs,
          env: { ...process.env },
          maxBuffer: 50 * 1024 * 1024, // 50 MB
        });

        const audioBuffer = readFileSync(outputFile);
        if (audioBuffer.length === 0) {
          throw new Error("CLI TTS command produced empty output");
        }

        return {
          audioBuffer,
          outputFormat,
          fileExtension,
          voiceCompatible: false,
        };
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };
}
