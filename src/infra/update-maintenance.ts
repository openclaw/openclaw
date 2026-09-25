import fs from "node:fs/promises";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { formatErrorMessage } from "./errors.js";
import type { UpdateStepResult } from "./update-step-result.js";

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
  /** Recheck custody inside the warning boundary; false skips removal. */
  canRemove?: () => Promise<boolean>;
  onWarning: (step: UpdateStepResult) => void;
}): Promise<void> {
  const started = Date.now();
  let canRemove = false;
  let failure: { error: unknown } | undefined;
  try {
    canRemove = !params.canRemove || (await params.canRemove());
    if (canRemove) {
      await fs.rm(params.directory, { recursive: true, force: true });
      return;
    }
  } catch (error) {
    failure = { error };
  }
  // Unverified paths may be absent or replaced; never recommend deleting them.
  const command = canRemove ? formatUpdateCleanupCommand(params.directory) : "";
  const reason = failure
    ? formatErrorMessage(failure.error)
    : "Directory ownership could not be verified.";
  params.onWarning({
    name: params.name,
    command,
    cwd: params.root,
    durationMs: Date.now() - started,
    exitCode: 1,
    stderrTail: reason,
    advisory: {
      kind: "recoverable-maintenance",
      message: canRemove
        ? `Skipped ${params.name}. Remove the retained temporary copy with: ${command}. Reason: ${reason}`
        : `Skipped ${params.name}: ownership could not be verified for ${params.directory}. Inspect that path before removing any files.${failure ? ` Reason: ${reason}` : ""}`,
    },
  });
}
