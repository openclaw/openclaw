import { theme } from "../../../packages/terminal-core/src/theme.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { tryWriteCompletionCache } from "./shared.js";
import { tryInstallShellCompletion } from "./update-command-service.js";

/** Completion refresh is advisory and runs after service recovery has settled. */
export async function refreshUpdateCompletion(
  root: string,
  jsonMode: boolean,
  skipPrompt: boolean,
): Promise<void> {
  try {
    await tryWriteCompletionCache(root, jsonMode);
  } catch (error) {
    if (!jsonMode) {
      const command = formatCliCommand("openclaw completion --write-state");
      defaultRuntime.log(
        theme.warn(
          `Completion cache update failed: ${formatErrorMessage(error)}. Update will continue; retry with: ${command}`,
        ),
      );
    }
  }
  await tryInstallShellCompletion({ jsonMode, skipPrompt });
}
