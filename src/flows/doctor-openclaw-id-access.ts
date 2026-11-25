import { copyConfigResolutionFactsThroughRewrite } from "../config/resolution-facts.js";
import {
  openClawIdAccessBlockReason,
  openClawIdAccessWarning,
  withOpenClawIdAccessAllowed,
} from "../gateway/openclaw-id/access-plugin.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import {
  recordDoctorHealthWarnings,
  renderStructuredHealthFindings,
} from "./doctor-health-contribution.js";
import type { HealthCheck } from "./health-checks.js";

export const openClawIdAccessCheck: HealthCheck = {
  id: "core/doctor/openclaw-id-access",
  kind: "core",
  source: "doctor",
  description: "OpenClaw ID Access page plugin policy.",
  async detect({ cfg }) {
    const message = openClawIdAccessWarning(cfg);
    return message
      ? [
          {
            checkId: "core/doctor/openclaw-id-access",
            severity: "warning",
            requirement:
              openClawIdAccessBlockReason(cfg) === "not in allowlist"
                ? "allowlist"
                : "explicit-policy",
            message,
            fixHint:
              "Doctor can add only openclaw-id-access to plugins.allow with consent; explicit disables and deny entries are never changed.",
          },
        ]
      : [];
  },
};

export async function runOpenClawIdAccessHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  let findings = await openClawIdAccessCheck.detect({
    mode: "doctor",
    cfg: ctx.cfg,
    runtime: ctx.runtime,
  });
  if (
    findings.some(({ requirement }) => requirement === "allowlist") &&
    ctx.sourceConfigValid &&
    (await ctx.prompter.confirmAutoFix({
      message:
        "Add openclaw-id-access to plugins.allow so the OpenClaw ID Access page can load? The config file is rewritten as JSON and comments are removed. All other plugin policy is preserved.",
      initialValue: false,
    }))
  ) {
    const config = withOpenClawIdAccessAllowed(ctx.cfg);
    copyConfigResolutionFactsThroughRewrite(ctx.cfg, config);
    ctx.cfg = config;
    ctx.configResult.pendingChangePanels = [
      ...(ctx.configResult.pendingChangePanels ?? []),
      "Added openclaw-id-access to plugins.allow.",
    ];
    findings = [];
  }
  renderStructuredHealthFindings(ctx, findings);
  recordDoctorHealthWarnings(ctx, findings);
}
