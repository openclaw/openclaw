import { buildModelCatalogMergeKey } from "@openclaw/model-catalog-core/model-catalog-refs";
import { resolveKnownModelRefMigrationTarget } from "../commands/doctor/shared/codex-route-warnings.js";
import { getModelCatalogWarnings, readModelCatalog } from "../commands/models/catalog-warnings.js";
import { hasActiveGatewayExecCredential } from "./doctor-gateway-exec-credential.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

export const modelReferenceCheck: HealthCheck = {
  id: "core/doctor/model-references",
  kind: "core",
  description: "Configured model references have known providers and server catalog diagnostics.",
  source: "doctor",
  async detect(ctx) {
    const { inspectConfiguredModelReferences } =
      await import("../commands/models/model-reference-validation.js");
    const catalogSkipped =
      ctx.allowExecSecretRefs !== true &&
      (await hasActiveGatewayExecCredential({ cfg: ctx.cfg, env: ctx.env }));
    const catalog = catalogSkipped ? undefined : await readModelCatalog(ctx.cfg);
    const findings = inspectConfiguredModelReferences({
      cfg: ctx.cfg,
      env: ctx.env,
      workspaceDir: ctx.cwd,
    }).flatMap((inspection): HealthFinding[] => {
      const migrationTarget = resolveKnownModelRefMigrationTarget(ctx.cfg, inspection.ref);
      const migrationFinding = migrationTarget
        ? {
            message: `Configured model "${inspection.ref}" is a legacy reference. Doctor can migrate it to "${migrationTarget}".`,
            requirement: `full model reference "${migrationTarget}"`,
            fixHint: `Run \`openclaw doctor --fix\` to migrate this model reference to "${migrationTarget}".`,
          }
        : undefined;
      const unknownProvider = inspection.status === "unknown-provider";
      // Runtime discovery can publish models that offline metadata cannot enumerate.
      const modelKey = buildModelCatalogMergeKey(inspection.provider, inspection.model);
      const published = catalog?.models.some(
        ({ provider, id }) => buildModelCatalogMergeKey(provider, id) === modelKey,
      );
      const unknownModel = inspection.status === "unknown-model" && !published;
      const needsMigration =
        migrationFinding &&
        (inspection.status === "unknown-model" || inspection.status === "uncatalogued-provider");
      if (!unknownProvider && !(inspection.active && (unknownModel || needsMigration))) {
        return [];
      }
      return [
        {
          checkId: "core/doctor/model-references",
          severity: unknownProvider ? "warning" : "info",
          source: "doctor",
          target: inspection.ref,
          ...(migrationFinding ??
            (unknownProvider
              ? {
                  message: `Configured model "${inspection.ref}" uses unknown provider "${inspection.provider}". No installed plugin manifest or models.providers entry declares it.`,
                  requirement: "an installed plugin manifest or models.providers configuration",
                  fixHint:
                    "Install a plugin that declares this provider, configure it under models.providers, or remove the model reference.",
                }
              : {
                  message: `Configured model "${inspection.ref}" uses a known provider but is not in the local model catalog. It may be newly released or self-hosted.`,
                  requirement: "a provider-supported model id",
                  fixHint:
                    "Verify the model id with the provider, or rerun with --severity-min info after refreshing the local catalog.",
                })),
        },
      ];
    });
    if (catalogSkipped) {
      findings.push({
        checkId: "core/doctor/model-references",
        severity: "info",
        source: "doctor",
        message:
          "Server catalog inspection skipped because the selected Gateway uses an exec SecretRef.",
        fixHint: "Run openclaw doctor --allow-exec to permit configured secret execution.",
      });
      return findings;
    }
    for (const warning of getModelCatalogWarnings(catalog)) {
      findings.push({
        checkId: "core/doctor/model-references",
        severity: "warning",
        source: "doctor",
        target: warning.ref,
        message: warning.message,
        fixHint: warning.fixHint,
      });
    }
    return findings;
  },
};
