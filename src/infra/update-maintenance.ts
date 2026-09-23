import fs from "node:fs/promises";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { formatErrorMessage } from "./errors.js";
import type { UpdateStepResult } from "./update-runner-types.js";

export function formatUpdateCleanupCommand(directory: string): string {
  return process.platform === "win32"
    ? `Remove-Item -LiteralPath ${quotePowerShellArg(directory)} -Recurse -Force`
    : `rm -rf -- ${quoteCliArg(directory)}`;
}

/** Only disposable directories owned by this update, never recovery originals. */
export async function cleanupUpdateTemporaryDirectory(params: {
  directory: string;
  root: string;
  name: string;
  onWarning: (step: UpdateStepResult) => void;
}): Promise<void> {
  const started = Date.now();
  try {
    await fs.rm(params.directory, { recursive: true, force: true });
  } catch (error) {
    const command = formatUpdateCleanupCommand(params.directory);
    params.onWarning({
      name: params.name,
      command,
      cwd: params.root,
      durationMs: Date.now() - started,
      exitCode: 1,
      stderrTail: formatErrorMessage(error),
      advisory: {
        kind: "recoverable-maintenance",
        message: `Skipped ${params.name}. Remove the retained temporary copy with: ${command}. Reason: ${formatErrorMessage(error)}`,
      },
    });
  }
}
