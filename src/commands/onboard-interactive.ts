/**
 * Interactive onboarding command entrypoint.
 *
 * It wires the Clack prompter to the setup wizard and restores terminal state
 * on every exit path so canceled setup cannot leave stdin paused.
 */
import { restoreTerminalState } from "../../packages/terminal-core/src/restore.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { runSetupWizard } from "../wizard/setup.js";
import type { OnboardOptions } from "./onboard-types.js";

/** Runs the interactive setup wizard and maps user cancellation to exit code 1. */
export async function runInteractiveSetup(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const prompter = createClackPrompter();
  let exitCode: number | null = null;
  try {
    await runSetupWizard(opts, runtime, prompter);
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      // Best practice: cancellation is not a successful completion.
      exitCode = 1;
      return;
    }
    throw err;
  } finally {
    // Keep stdin paused so non-daemon runs can exit cleanly (e.g. Docker setup).
    restoreTerminalState("setup finish", { resumeStdinIfPaused: false });
    if (exitCode !== null) {
      runtime.exit(exitCode);
    }
  }
}

/**
 * Default interactive onboarding: no step wizard, just the Crestodian
 * conversation. The first-run greeting proposes a full setup plan (detected
 * inference, workspace, gateway) and a plain "yes" applies it; channels and
 * the agent handoff continue in the same conversation.
 */
export async function runConversationalOnboarding(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    runtime.error(
      "Onboarding needs an interactive TTY. Use `openclaw onboard --non-interactive --accept-risk ...` for automation.",
    );
    runtime.exit(1);
    return;
  }
  const { runCrestodian } = await import("../crestodian/crestodian.js");
  await runCrestodian(
    {
      welcomeVariant: "onboarding",
      ...(opts.workspace ? { setupWorkspace: opts.workspace } : {}),
    },
    runtime,
  );
}
