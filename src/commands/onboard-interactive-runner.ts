// Shared lifecycle handling for interactive onboarding entrypoints.
import path from "node:path";
import { restoreTerminalState } from "../../packages/terminal-core/src/restore.js";
import type { RuntimeEnv } from "../runtime.js";
import { t } from "../wizard/i18n/index.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import type { OnboardOptions } from "./onboard-types.js";

export { isTerminalInteractive as hasInteractiveOnboardingTty } from "../cli/terminal-interactivity.js";

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

async function launchHatchTui(
  workspace: string,
  local: boolean,
  agentId?: string,
  deviceAuth = false,
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
      ...(deviceAuth ? { deviceAuth: true } : local ? { local: true } : {}),
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

export type GuidedOnboardingHandoff =
  | { next: "browser" }
  | { next: "foreground-gateway"; agentId?: string }
  | {
      workspace: string;
      next: "hatch";
      local: boolean;
      agentId?: string;
      personalSetup?: boolean;
      hostGateway?: boolean;
    }
  | { workspace: string; next: "chat"; agentName?: string };

export type GuidedOnboardingHandoffDeps = {
  runSystemAgentChat?: (
    workspace: string,
    runtime: RuntimeEnv,
    acceptRisk: boolean,
    agentName?: string,
  ) => Promise<void>;
};

export async function runGuidedOnboardingHandoff(
  handoff: GuidedOnboardingHandoff | null,
  opts: OnboardOptions,
  runtime: RuntimeEnv,
  deps: GuidedOnboardingHandoffDeps,
): Promise<void> {
  if (!handoff) {
    return;
  }
  if (handoff.next === "foreground-gateway") {
    const { runQuickstartForegroundGateway } = await import("./onboard-quickstart-host.js");
    await runQuickstartForegroundGateway({
      runtime,
      ...(handoff.agentId ? { agentId: handoff.agentId } : {}),
      ...(opts.suppressGatewayTokenOutput ? { suppressTokenOutput: true } : {}),
    });
    return;
  }
  // Interactive surfaces start only after the wizard lifecycle restores stdin
  // so the TUI (or recovery chat) receives a clean TTY.
  if (handoff.next === "hatch") {
    const continueTerminal = async () => {
      let personal = null;
      if (handoff.personalSetup) {
        const [{ offerTerminalPersonalSetup }, { createClackPrompter }] = await Promise.all([
          import("./onboard-personal.js"),
          import("../wizard/clack-prompter.js"),
        ]);
        personal = await offerTerminalPersonalSetup(createClackPrompter());
      }
      await launchHatchTui(handoff.workspace, handoff.local, handoff.agentId, personal !== null);
    };
    if (handoff.hostGateway) {
      // The existing foreground owner starts, proves readiness, and closes only its own child.
      const { runQuickstartForegroundGateway } = await import("./onboard-quickstart-host.js");
      await runQuickstartForegroundGateway({ runtime, onReady: continueTerminal });
    } else {
      await continueTerminal();
    }
    return;
  }
  if (handoff.next === "browser") {
    return;
  }
  // Chat handoff: legacy remote-gateway flow, or local recovery after a
  // failed setup apply — the conversational chat can finish interactively.
  if (deps.runSystemAgentChat) {
    await deps.runSystemAgentChat(handoff.workspace, runtime, true, handoff.agentName);
  } else {
    const { runConversationalOnboarding } = await import("./onboard-interactive.js");
    await runConversationalOnboarding(
      {
        workspace: handoff.workspace,
        ...(handoff.agentName ? { agentName: handoff.agentName } : {}),
        acceptRisk: true,
      },
      runtime,
    );
  }
}
