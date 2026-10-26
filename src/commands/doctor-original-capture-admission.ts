import { measureGatewayBootstrapStep } from "../cli/startup-trace.js";
import { withDoctorProgress } from "../flows/doctor-health-startup.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import type { DoctorMaintenanceParams } from "./doctor-maintenance-types.js";
import type { preserveDoctorOriginalState } from "./doctor-original-capture.js";

/** The admitted owner checks deferred schemas before original capture or repair effects. */
export function createDoctorOriginalCaptureHook(
  params: Pick<
    Parameters<typeof preserveDoctorOriginalState>[0],
    "root" | "runtime" | "writeAuthority" | "fullIntegrityCheck"
  > & {
    rehearsalRoot?: string;
    json?: boolean;
    reportFindings: (findings: readonly HealthFinding[], warnings?: readonly string[]) => void;
  },
): NonNullable<DoctorMaintenanceParams["beforeStateMutation"]> {
  return async ({ env, signal }) => {
    const [{ preserveDoctorOriginalState }, { getOpenClawDatabaseMaintenanceScope }] =
      await Promise.all([
        import("./doctor-original-capture.js"),
        import("../state/openclaw-state-db-async-lifecycle.js"),
      ]);
    const scope = getOpenClawDatabaseMaintenanceScope();
    if (!scope) {
      throw new Error("Original state capture requires Doctor's admitted maintenance scope.");
    }
    if (params.rehearsalRoot !== undefined) {
      try {
        if (resolveUpdateRehearsalRoot(env) !== params.rehearsalRoot) {
          throw new Error("Disposable Doctor namespace changed before maintenance admission.");
        }
        const { guardUpdateDoctorSchemaUpgrade } = await import("./doctor-update-schema-guard.js");
        scope.assertOwnerCurrent();
        if (resolveUpdateRehearsalRoot(process.env) !== params.rehearsalRoot) {
          throw new Error("Disposable Doctor namespace changed before maintenance admission.");
        }
        // Namespace flags selected read-only deferral, never writer authority.
        // Reject uncovered agent paths under the actual owner before capture
        // or prepareRepair can relocate state or admit live authority reads.
        const guarded = await guardUpdateDoctorSchemaUpgrade({
          runtime: params.runtime,
          json: params.json,
          preserveSourceArtifacts: params.writeAuthority?.databaseGenerations ? true : undefined,
        });
        scope.assertOwnerCurrent();
        if (guarded?.updateSchemaRehearsal) {
          throw new Error(
            "Deferred schema rehearsal cannot authorize repair of agents outside this disposable namespace.",
          );
        }
        // Canary state is disposable; external plugin data is deferred by its resource owner.
        return;
      } catch (cause) {
        throw new DoctorMaintenanceRefusalError(
          `Doctor rehearsal admission refused: ${cause instanceof Error ? cause.message : String(cause)}`,
          { kind: "data-at-risk", reason: "incomplete-migration" },
          { cause },
        );
      }
    }
    const { findings, warnings } = await withDoctorProgress(
      "Preserve original state",
      () =>
        measureGatewayBootstrapStep("doctor.maintenance.preserve-original-state", () =>
          preserveDoctorOriginalState({
            root: params.root,
            env,
            runtime: params.runtime,
            signal,
            assertCurrent: () => scope.assertOwnerCurrent(),
            writeAuthority: params.writeAuthority,
            fullIntegrityCheck: params.fullIntegrityCheck,
          }),
        ),
      params.json !== true,
    );
    params.reportFindings(findings, warnings);
  };
}
