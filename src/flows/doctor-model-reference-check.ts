/** Doctor check for configured model references that have no installed provider owner. */
import { resolveKnownModelRefMigrationTarget } from "../commands/doctor/shared/codex-route-warnings.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

export function createModelReferenceCheck(): HealthCheck {
  return {
    id: "core/doctor/model-references",
    kind: "core",
    description: "Configured model references have installed or configured provider owners.",
    source: "doctor",
    async detect(ctx) {
      const { inspectConfiguredModelReferences } =
        await import("../commands/models/model-reference-validation.js");
      return inspectConfiguredModelReferences({
        cfg: ctx.cfg,
        env: ctx.env,
        workspaceDir: ctx.cwd,
      }).flatMap((inspection): HealthFinding[] => {
        const migrationTarget = resolveKnownModelRefMigrationTarget(ctx.cfg, inspection.ref);
        const migrationFinding = migrationTarget
          ? {
              message: `Configured model "${inspection.ref}" is a legacy reference. Doctor can migrate it to "${migrationTarget}".`,
              requirement: `canonical model reference "${migrationTarget}"`,
              fixHint: `Run \`openclaw doctor --fix\` to migrate this model reference to "${migrationTarget}".`,
            }
          : undefined;
        if (inspection.status === "unknown-provider") {
          return [
            {
              checkId: "core/doctor/model-references",
              severity: "warning",
              source: "doctor",
              target: inspection.ref,
              ...(migrationFinding ?? {
                message: `Configured model "${inspection.ref}" uses unknown provider "${inspection.provider}". No installed plugin manifest or models.providers entry declares it.`,
                requirement: "an installed plugin manifest or models.providers configuration",
                fixHint:
                  "Install a plugin that declares this provider, configure it under models.providers, or remove the model reference.",
              }),
            },
          ];
        }
        // A provider that ships no catalog rows cannot confirm or deny a model
        // id offline; the generic advisory would be unactionable there, so only
        // a legacy-reference migration is still worth reporting.
        if (inspection.status === "uncatalogued-provider" && !migrationFinding) {
          return [];
        }
        if (
          (inspection.status === "unknown-model" ||
            inspection.status === "uncatalogued-provider") &&
          inspection.active
        ) {
          return [
            {
              checkId: "core/doctor/model-references",
              severity: "info",
              source: "doctor",
              target: inspection.ref,
              ...(migrationFinding ?? {
                message: `Configured model "${inspection.ref}" uses a known provider but is not in the local model catalog. It may be newly released or self-hosted.`,
                requirement: "a provider-supported model id",
                fixHint:
                  "Verify the model id with the provider, or rerun with --severity-min info after refreshing the local catalog.",
              }),
            },
          ];
        }
        return [];
      });
    },
  };
}
