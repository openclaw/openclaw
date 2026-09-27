/** Private stderr contract between the candidate Gateway and its updater. */
export const UPDATE_CANARY_PROGRESS_PREFIX = "openclaw-update-canary-progress: ";

// Only completed events from the CLI dispatcher and Gateway startup trace renew the wait.
const startupMilestones = [
  "entry.bootstrap",
  "entry.argv",
  "entry.run-main-import",
  "cli.main.argv",
  "cli.main.gateway-run-select-environment",
  "cli.main.gateway-run-imports",
  "cli.main.gateway-run-pre-bootstrap",
  "cli.main.gateway-run-bootstrap",
  "cli.config-snapshot",
  "cli.auth-resolve",
  "cli.gateway-loop",
  "process.bootstrap",
  "state.ownership",
  "state.schema-preflight",
  "config.snapshot",
  "config.auth",
  "plugins.bootstrap",
  "runtime.config",
  "runtime.state",
  "gateway.kernel-state",
  "http.bound",
  "runtime.post-attach",
  "sidecars.ready",
  "ready",
] as const;
export type UpdateCanaryStartupMilestone = (typeof startupMilestones)[number];
const acceptedMilestones: ReadonlySet<string> = new Set(startupMilestones);

export function isUpdateCanaryStartupMilestone(name: string): name is UpdateCanaryStartupMilestone {
  return acceptedMilestones.has(name);
}

export type UpdateCanaryStartupProgress = ReadonlyMap<UpdateCanaryStartupMilestone, number>;
