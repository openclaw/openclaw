import { bindProviderRenameAuthProfiles } from "../commands/doctor/shared/provider-rename-auth.js";
import {
  applyProviderRenames,
  planProviderRenames,
} from "../commands/doctor/shared/provider-rename.js";
import { resolvePluginDoctorProviderRenames } from "../plugins/doctor-contract-registry.js";
import {
  configValidationIssuesToHealthFindings,
  configValidationWarningsToHealthFindings,
  FINAL_CONFIG_VALIDATION_CHECK_ID,
} from "./doctor-config-validation-findings.js";
import type { DoctorHealthCheckContext } from "./doctor-health-contribution-types.js";
import type { DoctorHealthCheck } from "./health-check-runner-types.js";

export const finalConfigValidationCheck: DoctorHealthCheck = {
  id: FINAL_CONFIG_VALIDATION_CHECK_ID,
  updateReadiness: "post-plugin",
  kind: "core",
  description: "Active openclaw.jsonc parses and conforms to the config schema.",
  source: "doctor",
  async detect(ctx: DoctorHealthCheckContext) {
    let snap = ctx.mode === "lint" ? ctx.lintConfigSnapshot : undefined;
    if (!snap) {
      const { readConfigFileSnapshot } = await import("../config/config.js");
      snap = await readConfigFileSnapshot({ observe: false });
    }
    if (!snap.exists) {
      return [];
    }
    const renames =
      ctx.mode === "lint"
        ? planProviderRenames(
            ctx.cfg,
            resolvePluginDoctorProviderRenames({ config: ctx.cfg, env: ctx.env }),
          )
        : [];
    const migration = applyProviderRenames(
      ctx.cfg,
      bindProviderRenameAuthProfiles(ctx.cfg, renames, ctx.env),
    );
    return [
      ...configValidationIssuesToHealthFindings(snap.issues),
      ...configValidationWarningsToHealthFindings(snap.warnings),
      ...migration.changes.map((message) => ({
        checkId: FINAL_CONFIG_VALIDATION_CHECK_ID,
        severity: "warning" as const,
        message,
        fixHint: "Run openclaw doctor --fix to migrate the provider and its model references.",
      })),
    ];
  },
};
