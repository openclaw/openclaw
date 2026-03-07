import type { Command } from "commander";
import { modelsCompletionCommand } from "../commands/models/completion.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data.trim());
    });
    process.stdin.on("error", reject);
  });
}

export function registerModelsCompletionCli(parent: Command) {
  parent
    .command("completion")
    .description("Run an LLM completion using configured models")
    .option(
      "--model <id>",
      'Model identifier (e.g., "anthropic/claude-sonnet-4" or "claude" for default provider)',
    )
    .option("--input <text>", "Prompt text (or read from stdin if not provided)")
    .option("--system <text>", "System prompt (optional)")
    .option("--max-tokens <n>", "Maximum tokens to generate (optional)", (v) => parseInt(v, 10))
    .option("--temperature <n>", "Sampling temperature 0-2 (optional)", (v) => parseFloat(v))
    .option("--format <type>", "Output format: json or text", "text")
    .option("--timeout <ms>", "Timeout for completion in ms", (v) => parseInt(v, 10))
    .option("--json", "Output structured JSON result")
    .helpOption("-h, --help")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Examples:")}\n` +
        `  openclaw models completion --model claude --input "What is 2+2?"\n` +
        `  echo "Summarize this text" | openclaw models completion --model gpt-4o\n` +
        `  openclaw models completion --model claude --system "You are a math tutor" \\\n` +
        `    --input "Teach me about calculus"\n` +
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/models", "docs.openclaw.ai/cli/models")}\n`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        // Read input from stdin if not provided via flag
        let input = opts.input;
        if (!input) {
          if (process.stdin.isTTY) {
            throw new Error(
              "Input required. Use --input flag or pipe stdin: echo 'prompt' | openclaw models completion --model claude",
            );
          }
          input = await readStdin();
          if (!input?.trim()) {
            throw new Error("No input provided via --input flag or stdin");
          }
        }

        // TODO: Resolve model shorthand (e.g., "claude" -> full model ID)
        // For now, require full format like "anthropic/claude-sonnet-4"

        try {
          const result = await modelsCompletionCommand(
            {
              model: opts.model,
              input,
              system: opts.system,
              maxTokens: opts.maxTokens,
              temperature: opts.temperature,
              format: opts.format as "json" | "text",
              timeoutMs: opts.timeout,
            },
            defaultRuntime,
          );

          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
          } else {
            defaultRuntime.log(result.output);
          }
        } catch (err) {
          if (err instanceof Error) {
            defaultRuntime.error(err.message);
          } else {
            defaultRuntime.error(String(err));
          }
          process.exit(1);
        }
      });
    });
}
