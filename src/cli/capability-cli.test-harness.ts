import { Command } from "commander";
// Prepare the fixed subprocess graph during collection, before command deadlines.
import "../infra/runtime-process-entrypoints.js";
import { registerCapabilityCli } from "./capability-cli.js";

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
