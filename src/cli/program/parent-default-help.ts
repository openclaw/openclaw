// Parent-command default action helper that prints help with success exit status.
import type { Command } from "commander";

const parentDefaultHelpCommands = new WeakSet<Command>();

function outputParentHelpWithoutStartupBanner(parent: Command): void {
  const previous = process.env.OPENCLAW_SUPPRESS_HELP_BANNER;
  process.env.OPENCLAW_SUPPRESS_HELP_BANNER = "1";
  try {
    parent.outputHelp();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_SUPPRESS_HELP_BANNER;
    } else {
      process.env.OPENCLAW_SUPPRESS_HELP_BANNER = previous;
    }
  }
}

/**
 * Bare parent help exits successfully instead of Commander's default status 1 (#73077).
 * Apply only to parents without a default action; Commander has no public action-handler probe.
 */
export function applyParentDefaultHelpAction(parent: Command): void {
  parentDefaultHelpCommands.add(parent);
  parent.action(() => {
    outputParentHelpWithoutStartupBanner(parent);
    process.exitCode = 0;
  });
}

export function isParentDefaultHelpAction(parent: Command): boolean {
  return parentDefaultHelpCommands.has(parent);
}
