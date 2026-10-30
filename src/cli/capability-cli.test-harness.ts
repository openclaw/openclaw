import { Command } from "commander";
// Prepare the fixed subprocess graph during collection, before command deadlines.
import "../infra/runtime-process-entrypoints.js";
import { registerCapabilityCli } from "./capability-cli.js";

export function preparedModel({
  provider = "openai",
  modelId = "gpt-5.4",
  chatGpt = false,
  release,
}: {
  provider?: string;
  modelId?: string;
  chatGpt?: boolean;
  release: () => void;
}) {
  return {
    async [Symbol.asyncDispose]() {
      release();
    },
    selection: { provider, modelId, agentDir: "/tmp/agent" },
    model: {
      provider,
      id: modelId,
      maxTokens: 128,
      input: ["text", "image"],
      ...(chatGpt ? { api: "openai-chatgpt-responses" } : {}),
    },
    auth: chatGpt
      ? { apiKey: "codex-app-server", source: "codex-app-server", mode: "token" }
      : { apiKey: "sk-test", source: "env:TEST_API_KEY", mode: "api-key" },
  };
}

export const invalidModelRunOptionCases = [
  { args: ["--prompt", "\n\t"], error: "--prompt cannot be empty or whitespace-only." },
  {
    args: ["--model", "not-a-provider/"],
    error: "Model overrides must use the form <provider/model>.",
  },
  { args: ["--thinking", "turbo-mode"], error: "Invalid thinking level." },
  { args: ["--thinking", ""], error: "Invalid thinking level." },
  { args: ["--thinking", " \t"], error: "Invalid thinking level." },
];

export async function runCap(...argv: string[]): Promise<void> {
  const program = new Command();
  await registerCapabilityCli(program, ["node", "openclaw", ...argv]);
  await program.parseAsync(argv, { from: "user" });
}

export function runCapability(domain: string, action: string, ...argv: string[]): Promise<void> {
  return runCap("capability", domain, action, ...argv);
}

export function runCapabilityWithParentAgent(
  domain: string,
  action: string,
  agent: string,
  ...argv: string[]
): Promise<void> {
  return runCap("capability", domain, "--agent", agent, action, ...argv);
}

export function runModelAuthWithAgent(
  position: "parent" | "leaf",
  action: "login" | "logout" | "status",
  agent: string,
  ...argv: string[]
): Promise<void> {
  return position === "parent"
    ? runCap("capability", "model", "--agent", agent, "auth", action, ...argv)
    : runCap("capability", "model", "auth", action, "--agent", agent, ...argv);
}
