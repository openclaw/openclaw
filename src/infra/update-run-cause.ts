import type { UPDATE_RUN_CAUSES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";

export type UpdateRunCause = (typeof UPDATE_RUN_CAUSES)[number];

type CauseInput = {
  status: string;
  reason?: string | null;
  facts: readonly { code: string; npmErrorCode?: string }[];
};

// Exact codes first; the prefix rules below cover each code family.
const CODE_CAUSES: Readonly<Record<string, UpdateRunCause>> = {
  "node-runtime-preflight": "node-unsupported",
  "preflight-node-runtime-incompatible": "node-unsupported",
  "git-version-unsupported": "git-unsupported",
  "preflight-insufficient-space": "disk-full",
  "snapshot-capacity-insufficient": "disk-full",
  ENOSPC: "disk-full",
  "global-install-permission-denied": "permission-denied",
  EACCES: "permission-denied",
  EPERM: "permission-denied",
  "fetch-failed": "network",
  "git-clone-failed": "network",
  ECONNRESET: "network",
  ETIMEDOUT: "network",
  ETARGET: "network",
  E404: "network",
  "target-registry-metadata": "network",
  "target-registry-dist-tag": "network",
  "target-metadata-preflight": "network",
  "invalid-config": "config-invalid",
  "config-read-failed": "config-invalid",
  "repair-requires-config-change": "config-invalid",
  "doctor-failed": "state-migration-failed",
  "state-migrated-no-rollback": "state-migration-failed",
  "retired-state-format": "state-migration-failed",
  "step-refused": "state-migration-failed",
  "blocked-by-session-repair-failure": "state-migration-failed",
  "unverified-agent-databases": "state-migration-failed",
  OPENCLAW_STATE_LEASE_LOST: "state-migration-failed",
  OPENCLAW_STATE_LEASE_STORAGE_FAILED: "state-migration-failed",
  "finalize:doctor": "state-migration-failed",
  "finalize:plugins": "plugin-failed",
  "readyz-unhealthy": "service-failed",
  "restart-unhealthy": "service-failed",
  "service-not-running": "service-failed",
  "gateway-probe-failed": "service-failed",
  "gateway-stop-unverified": "service-failed",
  abandoned: "interrupted",
  interrupted: "interrupted",
  superseded: "interrupted",
  signal: "interrupted",
  "handoff-terminated": "interrupted",
  dirty: "refused",
  "not-git-install": "refused",
  "update-recovery-pending": "refused",
  unsupported_git_channel: "refused",
  "unsupported-package-target": "refused",
  "invalid-dev-target": "refused",
  "global-install-foreign-destination": "refused",
  "global-install-failed": "install-failed",
  "swap-failed": "install-failed",
  "preflight-no-good-commit": "install-failed",
  "runtime-verification-failed": "install-failed",
};

const PREFIX_CAUSES: readonly [string, UpdateRunCause][] = [
  ["database-", "state-migration-failed"],
  ["agent-database", "state-migration-failed"],
  ["candidate-snapshot", "state-migration-failed"],
  ["plugin", "plugin-failed"],
  ["post-plugin", "plugin-failed"],
  ["post-update-plugins", "plugin-failed"],
  ["managed-service", "service-failed"],
  ["handoff-", "service-failed"],
  ["service-", "service-failed"],
  ["candidate-", "install-failed"],
  ["package-", "install-failed"],
  ["pnpm-", "install-failed"],
];

function causeOf(code: string | null | undefined): UpdateRunCause | undefined {
  if (!code) {
    return undefined;
  }
  return CODE_CAUSES[code] ?? PREFIX_CAUSES.find(([prefix]) => code.startsWith(prefix))?.[1];
}

const MACHINE_CAUSES = new Set<UpdateRunCause>(["disk-full", "permission-denied", "network"]);

/**
 * Maps a finished attempt to one cause. Machine facts (disk, permissions, network) win;
 * then the most specific of the reason and its facts, since site codes such as
 * global-install-failed name where an update failed, not why.
 */
export function classifyUpdateRunCause(input: CauseInput): UpdateRunCause {
  if (input.status === "succeeded" || input.status === "skipped") {
    return "none";
  }
  const facts = input.facts
    .flatMap((fact) => [causeOf(fact.npmErrorCode), causeOf(fact.code)])
    .filter((cause) => cause !== undefined);
  const reason = causeOf(input.reason);
  return (
    facts.find((cause) => MACHINE_CAUSES.has(cause)) ??
    [reason, ...facts].find((cause) => cause !== undefined && cause !== "install-failed") ??
    reason ??
    facts[0] ??
    "unknown"
  );
}
