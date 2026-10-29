import { readPackageVersion } from "../../infra/package-json.js";
import { planLegacyStateMigrationsReadOnly } from "../../infra/state-migrations.doctor.js";
import { refuseLegacyStateMigrationPlan } from "../../infra/state-migrations.plan.js";
import { defaultRuntime } from "../../runtime.js";
import { ExpectedCliError } from "../failure-output.js";
import { resolveUpdateRoot } from "./shared.js";

type UpdateMigrationPlanCommandOptions = {
  snapshotConfig: string;
  snapshotHome: string;
  snapshotState: string;
};

function requireSnapshotPath(value: string, flag: string): string {
  if (!value.trim()) {
    const message = `${flag} must not be blank`;
    throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
  }
  return value;
}

export async function updateMigrationPlanCommand(
  opts: UpdateMigrationPlanCommandOptions,
): Promise<void> {
  // Root and version are observations only. This diagnostic command cannot bind
  // candidate bytes, so the planner returns a closed artifact-identity refusal.
  const root = await resolveUpdateRoot();
  const version = (await readPackageVersion(root)) ?? "unknown";
  let plan = await planLegacyStateMigrationsReadOnly({
    mode: "doctor",
    candidate: { root, version },
    snapshot: {
      homeDir: requireSnapshotPath(opts.snapshotHome, "--snapshot-home"),
      configPath: requireSnapshotPath(opts.snapshotConfig, "--snapshot-config"),
      stateDir: requireSnapshotPath(opts.snapshotState, "--snapshot-state"),
    },
  });
  const observedVersion = await readPackageVersion(root);
  if (observedVersion !== version) {
    plan = refuseLegacyStateMigrationPlan(plan, {
      code: "candidate-identity-changed",
      message: `Update version changed while migration planning was in progress: expected ${version}, observed ${observedVersion ?? "unknown"}.`,
    });
  }
  defaultRuntime.writeJson(plan);
  if (plan.outcome === "refused") {
    defaultRuntime.exit(1);
  }
}
