// Shared lifecycle handling for interactive onboarding entrypoints.
import path from "node:path";
import { restoreTerminalState } from "../../packages/terminal-core/src/restore.js";
import { isTerminalInteractive } from "../cli/terminal-interactivity.js";
import type { RuntimeEnv } from "../runtime.js";
import { t } from "../wizard/i18n/index.js";
import { WizardCancelledError } from "../wizard/prompts.js";

export function hasInteractiveOnboardingTty(): boolean {
  return isTerminalInteractive();
}

export async function runInteractiveOnboarding(
  action: () => Promise<void>,
  runtime: RuntimeEnv,
): Promise<void> {
  let exitCode: number | null = null;
  try {
    await action();
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      exitCode = 1;
      return;
    }
    throw error;
  } finally {
    // Keep stdin paused so non-daemon runs can exit cleanly (e.g. Docker setup).
    restoreTerminalState("setup finish", { resumeStdinIfPaused: false });
    if (exitCode !== null) {
      runtime.exit(exitCode);
    }
  }
}

export async function launchHatchTui(
  workspace: string,
  local: boolean,
  agentId?: string,
): Promise<void> {
  const [{ launchTuiCli }, { DEFAULT_BOOTSTRAP_FILENAME }, fs] = await Promise.all([
    import("../tui/tui-launch.js"),
    import("../agents/workspace.js"),
    import("node:fs"),
  ]);
  const hasBootstrap = fs.existsSync(path.join(workspace, DEFAULT_BOOTSTRAP_FILENAME));
  restoreTerminalState("guided hatch tui", { resumeStdinIfPaused: false });
  try {
    // Fresh setup already started the Gateway; local mode would contend for its state lock.
    // No timeoutMs: the run-level TUI timeout overrides the configured agent
    // timeout for every turn in the session, not just the hatch message.
    await launchTuiCli({
      ...(local ? { local: true } : {}),
      deliver: false,
      ...(agentId ? { session: `agent:${agentId}:main` } : {}),
      // Seed the first-run hatch only when the workspace bootstrap exists;
      // re-runs against an established agent open a plain chat instead.
      ...(hasBootstrap ? { message: t("wizard.finalize.bootstrapHatchMessage") } : {}),
    });
  } finally {
    restoreTerminalState("post guided hatch tui", { resumeStdinIfPaused: false });
  }
}
