import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";

// Released drivers persist display labels. Recovery still reads some of these exact keys;
// project only source-owned labels, never command arguments, into public report identities.
const stepIds = new Map<string, string>([
  ...[
    ...UPDATE_RUN_PHASES,
    "clean check",
    "upstream check",
    "tracked target ancestry",
    "git clone",
    "git fetch",
    "git remote",
    "git release remote",
    "git config update upstream",
    "git fetch tags",
    "git rollback clean",
    "git rollback clean untracked",
    "git rollback checkout",
    "git rollback reset",
    "git runtime rollback",
    "git import admitted target",
    "git target inspection fetch",
    "git runtime activation",
    "git update",
    "git update pack cleanup",
    "git target inspection cleanup",
    "git pin update upstream",
    "git update history",
    "git update tree",
    "git retained tree",
    "git retained object availability",
    "git retained object inventory",
    "git pack update",
    "git update pack read",
    "git import admitted upstream",
    "git rev-list",
    "preflight worktree",
    "preflight cleanup",
    "ui assets verify",
    "rollback outcome recording",
    "local package overrides",
    "package update",
    "package stage cleanup",
    "npm lifecycle policy preflight",
    "pnpm isolated install preflight",
    "state schema verification",
    "config rollback",
    "package rollback",
    "gateway verification",
    "gateway recovery verification",
    "rollback gateway verification",
    "previous gateway verification",
    "previous generation restoration",
    "post-update verification",
    "managed-service update handoff",
    "Windows task autostart recovery",
    "update executor settlement",
    "original managed service compensation",
    "Doctor config changes",
    "post-core plugin finalize",
    "repair restart",
  ].map((name): [string, string] => [name, name.toLowerCase().replaceAll(" ", "-")]),
  ["global update", "package-install"],
  ["global update (omit optional)", "package-install-omit-optional"],
  ["global update pack", "package-pack"],
  ["global update pack verify", "package-pack-verify"],
  ["global install stage", "package-stage"],
  ["global install verify", "package-verify"],
  ["global install swap", "package-swap"],
  ["global install rollback", "package-rollback"],
  ["global install backup retention", "package-backup-retention"],
  ["global install permissions", "package-permissions"],
  ["openclaw doctor", "package-doctor"],
  ["openclaw doctor entry", "package-doctor-entry"],
  ["post-install verification", "post-install-verify"],
  ["ui:build (post-doctor repair)", "post-doctor-ui-build"],
  ["git rollback verify HEAD", "git-rollback-verify-head"],
  ["git rev-parse HEAD (after)", "git-verify-head"],
  ["Checking update runtime", "candidate-runtime"],
  ["Preparing update checks", "candidate-state-snapshot"],
  ["Checking data migrations", "candidate-doctor"],
  ["Checking update health", "candidate-doctor-lint"],
  ["Checking configuration", "candidate-config"],
  ["Checking plugins", "candidate-plugins"],
  ["Checking update recovery", "candidate-recovery"],
  ["Checking Gateway startup", "candidate-gateway-startup"],
  ["candidate snapshot", "candidate-state-snapshot"],
  ["candidate doctor", "candidate-doctor"],
  ["candidate lint", "candidate-doctor-lint"],
  ["candidate config", "candidate-config"],
  ["candidate plugins", "candidate-plugins"],
  ["candidate runtime", "candidate-runtime"],
  ["candidate migration rehearsal", "candidate-doctor"],
  ["candidate doctor lint", "candidate-doctor-lint"],
  ["candidate config validation", "candidate-config"],
  ["candidate plugin resolution", "candidate-plugins"],
  ["candidate migration continuation", "candidate-recovery"],
  ["candidate gateway canary", "candidate-gateway-startup"],
  ["candidate rehearsal cleanup", "candidate-state-cleanup"],
  ["Removing temporary update files", "candidate-state-cleanup"],
  ["Removing temporary plugin inventory", "candidate-plugin-inventory-cleanup"],
  ...[
    "preflight",
    "targetConfigValidation",
    "configSnapshot",
    "doctor",
    "plugins",
    "targetConfigConvergence",
    "completionCache",
    "package-rollback-not-needed",
    "repair-continuation",
    "repair-takeover",
    "exit",
  ].map((phase): [string, string] => [
    `finalize:${phase}`,
    `finalize-${phase.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`,
  ]),
]);
for (const [name, id] of stepIds) {
  if (name.startsWith("Checking ") && !name.endsWith(" cleanup")) {
    stepIds.set(`${name} cleanup`, `${id}-cleanup`);
  }
}
for (const manager of ["npm", "pnpm", "bun"]) {
  for (const suffix of [
    "staging preflight",
    "package preinstall",
    "package postinstall",
    "package lifecycle",
  ]) {
    const name = `${manager} ${suffix}`;
    stepIds.set(name, name.replaceAll(" ", "-"));
  }
}
for (const operation of [
  "reset",
  "clean",
  "checkout",
  "local checkout",
  "rebase",
  "rebase --abort",
  "node runtime",
  "package manager",
  "deps install",
  "deps install (ignore scripts)",
  "build",
  "ui:build",
  "ui assets verify",
  "config validate",
  "lint",
  "update clean check",
  "update source check",
]) {
  stepIds.set(
    `preflight ${operation}`,
    `preflight-${operation.replace(/[^a-z]+/gu, "-").replace(/-$/u, "")}`,
  );
}
const publicIds = new Set(stepIds.values());

const gitArgumentSteps: ReadonlyArray<readonly [string, string]> = [
  ["git rollback delete ", "git-rollback-delete-branch"],
  ["git checkout ", "git-checkout"],
  ["git branch --set-upstream-to ", "git-set-upstream"],
  ["git fetch tags ", "git-fetch-tags"],
  ["git fetch ", "git-fetch-target-tag"],
  ["git rev-parse ", "git-resolve-target"],
  ["git show-ref ", "git-show-branch"],
];
for (const [, id] of gitArgumentSteps) {
  publicIds.add(id);
}
publicIds.add("git-resolve-upstream");

/** A closed projection also handles history produced by a restored released updater. */
export function resolvePublicUpdateStepId(name: string): string | undefined {
  return (
    stepIds.get(name) ??
    (publicIds.has(name) ? name : undefined) ??
    // Old preflight labels included a candidate SHA; neither refs nor arguments are public IDs.
    stepIds.get(name.replace(/ \([a-f0-9]{7,40}\)$/u, "")) ??
    gitArgumentSteps.find(([prefix]) => name.startsWith(prefix))?.[1] ??
    (/^repair attempt \d+$/u.test(name) ? "repair-attempt" : undefined)
  );
}
