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
    return [
      ...configValidationIssuesToHealthFindings(snap.issues),
      ...configValidationWarningsToHealthFindings(snap.warnings),
    ];
  },
};
