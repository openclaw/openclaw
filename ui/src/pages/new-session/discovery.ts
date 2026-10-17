import type {
  EnvironmentSummary,
  WorkerEnvironmentProfileSummary,
  WorkerExecutionMode,
  WorkerMachineOption,
} from "../../../../packages/gateway-protocol/src/schema/environments.ts";
import type { WorktreesBranchesResult } from "../../../../packages/gateway-protocol/src/schema/worktrees.ts";

export type DraftBranches = Omit<WorktreesBranchesResult, "repositoryStatus"> & {
  repoRoot: string;
};

export type DraftRepositoryState =
  | { kind: "idle" }
  // Selected GitHub projects offer isolation before checkout exists. Local first
  // turns prepare after admission; remote placement clones on its selected runner.
  | { kind: "pending-clone"; cloneUrl: string }
  | { kind: "pending-project"; projectId: string }
  | { kind: "checking"; repoRoot: string }
  | ({ kind: "git" } & DraftBranches)
  | { kind: "direct"; repoRoot: string }
  | { kind: "unavailable"; repoRoot: string };

export type DraftCloudProfile = Omit<WorkerEnvironmentProfileSummary, "executionModes"> & {
  executionModes?: readonly WorkerExecutionMode[];
};

export type DraftEnvironment = EnvironmentSummary;

export function draftCloudProfileSupportsExecutionMode(
  profile: DraftCloudProfile,
  executionMode: WorkerExecutionMode,
): boolean {
  return profile.executionModes?.includes(executionMode) === true;
}

export function defaultCloudOs(profile: DraftCloudProfile): string {
  return (
    profile.operatingSystems?.find((os) => os.default)?.id ??
    profile.operatingSystems?.[0]?.id ??
    profile.machines?.find((machine) => machine.os)?.os ??
    ""
  );
}

export function cloudMachinesForOs(profile: DraftCloudProfile, os: string): WorkerMachineOption[] {
  return (profile.machines ?? []).filter((machine) => !machine.os || machine.os === os);
}

/** Preserve configured defaults; prefer smaller reported hardware only when unambiguous. */
export function defaultCloudMachine(
  profile: DraftCloudProfile,
  os = defaultCloudOs(profile),
): WorkerMachineOption | undefined {
  const machines = cloudMachinesForOs(profile, os);
  return (
    machines.find((machine) => machine.default) ??
    // Class names do not rank capacity across providers or operating systems.
    // Unknown dimensions or CPU/RAM tradeoffs retain the provider's catalog order.
    machines.find((machine) =>
      machines.every(
        (other) =>
          machine.cpu !== undefined &&
          machine.memoryGb !== undefined &&
          other.cpu !== undefined &&
          other.memoryGb !== undefined &&
          machine.cpu <= other.cpu &&
          machine.memoryGb <= other.memoryGb,
      ),
    ) ??
    machines[0]
  );
}
