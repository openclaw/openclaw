import type { DoctorHealthCheck } from "./health-check-runner-types.js";
import type { HealthFinding } from "./health-checks.js";

export const legacyStateCheck: Omit<DoctorHealthCheck, "kind" | "source"> = {
  id: "core/doctor/legacy-state",
  description: "Legacy sessions, agent state, and channel auth paths have been migrated.",
  defaultEnabled: false,
  async detect(ctx) {
    const { detectLegacyStateMigrations } = await import("../infra/state-migrations.doctor.js");
    const { prepareLegacySessionSurfaces } = await import("../plugins/legacy-session-surfaces.js");
    const legacySessionSurfaces = prepareLegacySessionSurfaces({ config: ctx.cfg });
    const detected = await detectLegacyStateMigrations({
      cfg: ctx.cfg,
      doctorOnlyStateMigrations: true,
      artifactPreservingReadOnly: true,
      legacySessionSurfaces,
    });
    return [
      ...detected.preview.map((line): HealthFinding => ({
        checkId: "core/doctor/legacy-state",
        severity: "warning",
        message: line.replace(/^- /, ""),
        path: detected.stateDir,
        fixHint: "Run `openclaw doctor --fix` to migrate legacy state.",
      })),
      ...detected.warnings.map((warning): HealthFinding => ({
        checkId: "core/doctor/legacy-state",
        severity: "warning",
        message: warning,
        path: detected.stateDir,
        fixHint: "Resolve the warning, then rerun `openclaw doctor --fix`.",
      })),
    ];
  },
};
