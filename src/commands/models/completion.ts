import type { RuntimeEnv } from "../../runtime.js";
import { table } from "../../terminal/table.js";
import { theme } from "../../terminal/theme.js";

export interface ModelsCompletionParams {
  /** Model identifier (e.g., "anthropic/claude-sonnet-4") */
  model?: string;
  /** Input prompt/message content */
  input?: string;
  /** System prompt (optional) */
  system?: string;
  /** Max tokens to generate (optional) */
  maxTokens?: number;
  /** Temperature for sampling (optional, 0-1) */
  temperature?: number;
  /** Output format (json, text) */
  format?: "json" | "text";
  /** Timeout in ms */
  timeoutMs?: number;
}

export interface ModelsCompletionResult {
  output: string;
  model: string;
  tokens?: {
    input: number;
    output: number;
  };
  rawResponse?: unknown;
}

/**
 * Run a single completion against a configured model.
 * Reuses gateway's model configuration and credentials.
 *
 * @param params Input parameters for the completion
 * @param runtime Runtime environment with config
 * @returns Completion result
 */
export async function modelsCompletionCommand(
  params: ModelsCompletionParams,
  _runtime: RuntimeEnv,
): Promise<ModelsCompletionResult> {
  const { model, input, system, maxTokens, temperature } = params;

  if (!model?.trim()) {
    throw new Error(
      `Model required (e.g., "anthropic/claude-sonnet-4" or "openai/gpt-4o")\nUse "openclaw models list" to see available models`,
    );
  }

  if (!input?.trim()) {
    throw new Error("Input prompt required");
  }

  // NOTE: This is a placeholder that shows the interface.
  // The actual implementation will use the gateway's model resolution.
  // For now, we validate inputs and prepare for future integration.

  // Parse model identifier
  const [provider, ...modelParts] = model.split("/");
  const modelName = modelParts.join("/");

  if (!provider || !modelName) {
    throw new Error(
      `Invalid model format: "${model}". Expected format: "provider/model" (e.g., "anthropic/claude-sonnet-4")`,
    );
  }

  // Validate parameters
  if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
    throw new Error("Temperature must be between 0 and 2");
  }

  if (maxTokens !== undefined && maxTokens < 1) {
    throw new Error("maxTokens must be >= 1");
  }

  // Build the message
  const messages = [];
  if (system?.trim()) {
    messages.push({ role: "system" as const, content: system.trim() });
  }
  messages.push({ role: "user" as const, content: input.trim() });

  // TODO: Integrate with actual model resolution and completion logic
  // This would call into the configured gateway's model infrastructure
  // For now, throw an informative error
  throw new Error(
    `Model completion API not yet fully integrated. Parameters validated:\n` +
      `  Provider: ${provider}\n` +
      `  Model: ${modelName}\n` +
      `  Input length: ${input.length} chars\n` +
      `  System prompt: ${system ? "yes" : "no"}`,
  );
}

/**
 * Display completion help/info
 */
export function showCompletionHelp(runtime: RuntimeEnv) {
  runtime.log(
    table(
      [
        ["openclaw models completion --model claude", "Run a completion against Claude"],
        [
          'echo "summarize this" | openclaw models completion --model claude --input -',
          "Pipe input from stdin",
        ],
        [
          'openclaw models completion --model gpt-4o --system "You are a helpful assistant"',
          "Include system prompt",
        ],
        ["openclaw models completion --model claude --max-tokens 500", "Limit output length"],
      ],
      {
        pad: "  ",
        headers: [theme.muted("Examples"), theme.muted("Description")],
      },
    ),
  );
}
