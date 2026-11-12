import { copyConfigResolutionFactsThroughRewrite } from "../config/resolution-facts.js";
import { readStoredClaw } from "../gateway/openclaw-id/claw-store.js";
import {
  MEMBER_ROLE_PRESETS,
  withMissingMemberRolePresets,
} from "../gateway/openclaw-id/member-role-presets.js";
import { readSandboxBackendAvailability } from "../gateway/openclaw-id/sandbox-availability.js";
import { isNamedOperatorRoleEnforcementEnabled } from "../gateway/operator-role-enforcement.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isOpenClawIdEnabled } from "../shared/openclaw-id-policy.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import {
  recordDoctorHealthWarnings,
  renderStructuredHealthFindings,
} from "./doctor-health-contribution.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

const CHECK_ID = "core/doctor/member-roles";

/** Offline diagnostics consume the same local membership and engine owners as Access. */
export const memberRolesCheck: HealthCheck = {
  id: CHECK_ID,
  kind: "core",
  source: "doctor",
  description: "Member role definitions, preset availability, and inactive profile assignments.",
  async detect({ cfg, env }) {
    const roles = cfg.gateway?.roles;
    // Catalog-free installations keep their existing Doctor behavior; activation seeds their roles.
    if (!roles) {
      return [];
    }
    const findings: HealthFinding[] = [];
    const warn = (requirement: string, message: string, fixHint: string, target?: string) => {
      findings.push({
        checkId: CHECK_ID,
        severity: "warning",
        requirement,
        message,
        fixHint,
        docsUrl: "https://docs.openclaw.ai/gateway/operator-scopes#openclaw-id-member-roles",
        ...(target ? { target } : {}),
      });
    };
    const enforced = isNamedOperatorRoleEnforcementEnabled(cfg);
    if (!enforced && Object.keys(roles.definitions).length > 0) {
      try {
        const stored = await executeExistingOpenClawStateRead(
          { env },
          { type: "userProfiles.catalog" },
        );
        const assigned = stored?.profiles.filter(([, row]) => !row.merged_into && row.role) ?? [];
        if (assigned.length) {
          warn(
            "assignments-inactive",
            `Named-role enforcement is off: ${assigned.length} profile(s) have stored role assignments. These assignments have no effect because gateway.roles.default is absent.`,
            "Set gateway.roles.default to a defined role to enforce profile assignments, or clear unused assignments with users.setRole (role: null). OpenClaw ID member roles still apply.",
          );
        }
      } catch (error) {
        warn(
          "profiles-unreadable",
          `Doctor could not read stored profile role assignments: ${formatErrorMessage(error)}`,
          "Restore access to the local profile store and rerun Doctor.",
        );
      }
    }
    // Existing default-enforced Gateways with OpenClaw ID off retain their current diagnostics.
    if (!isOpenClawIdEnabled(cfg.gateway?.openclawId)) {
      return findings;
    }
    for (const name of Object.keys(MEMBER_ROLE_PRESETS)) {
      if (!Object.hasOwn(roles.definitions, name)) {
        warn(
          "missing-preset",
          `OpenClaw ID preset role "${name}" has no definition.`,
          "Accept Doctor's missing-preset repair, or define the role in gateway.roles.definitions.",
          name,
        );
      }
    }
    const sandboxUsers: string[] = [];
    try {
      const claw = await readStoredClaw();
      if (!claw) {
        throw new Error("the local claw record is missing");
      }
      for (const [accountId, member] of Object.entries(claw.authority?.members ?? {})) {
        const definition = Object.hasOwn(roles.definitions, member.role)
          ? roles.definitions[member.role]
          : undefined;
        if (!definition) {
          warn(
            "member-role-undefined",
            `OpenClaw ID member "${accountId}" has undefined role "${member.role}" and cannot connect.`,
            `Define "${member.role}" in gateway.roles.definitions, or change this member's role on the Access page.`,
            accountId,
          );
        } else if (definition.sandbox === "required") {
          sandboxUsers.push(`member "${accountId}" (role "${member.role}")`);
        }
      }
    } catch (error) {
      warn(
        "membership-unreadable",
        `Doctor could not read OpenClaw ID membership from the local claw record: ${formatErrorMessage(error)}`,
        "Check the local claw storage and linking status on Access, then rerun Doctor; membership was not verified.",
      );
    }
    if (roles.default && roles.definitions[roles.default]?.sandbox === "required") {
      sandboxUsers.push(`people using the named default "${roles.default}"`);
    }
    if (sandboxUsers.length) {
      const availability = await readSandboxBackendAvailability(cfg);
      if (availability.available === false) {
        const engine = availability.backend === "podman" ? "Podman" : "Docker";
        warn(
          "sandbox-unavailable",
          `Sandbox required for ${sandboxUsers.join(", ")}, but the configured ${engine} backend is unavailable; their runs will fail.`,
          `Make the configured ${engine} sandbox backend available. Required exec and file tools do not fall back to the host; see https://docs.openclaw.ai/gateway/sandboxing.`,
        );
      }
    }
    return findings;
  },
};

/** Stage an accepted preset repair for Doctor's normal revision-fenced config writer. */
export async function runMemberRolesHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  let findings = await memberRolesCheck.detect({
    mode: "doctor",
    cfg: ctx.cfg,
    env: ctx.env,
    runtime: ctx.runtime,
  });
  const missing = findings.filter(({ requirement }) => requirement === "missing-preset");
  if (
    missing.length &&
    ctx.sourceConfigValid &&
    (await ctx.prompter.confirmAutoFix({
      message: `Add missing OpenClaw ID role presets (${missing.map(({ target }) => target).join(", ")})? The config file is rewritten as JSON and comments are removed. Existing definitions, default, and assignments are preserved.`,
      initialValue: false,
    }))
  ) {
    const config = withMissingMemberRolePresets(ctx.cfg);
    copyConfigResolutionFactsThroughRewrite(ctx.cfg, config);
    ctx.cfg = config;
    ctx.configResult.pendingChangePanels = [
      ...(ctx.configResult.pendingChangePanels ?? []),
      `Added missing OpenClaw ID role presets: ${missing.map(({ target }) => target).join(", ")}.`,
    ];
    findings = await memberRolesCheck.detect({
      mode: "doctor",
      cfg: ctx.cfg,
      env: ctx.env,
      runtime: ctx.runtime,
    });
  }
  renderStructuredHealthFindings(ctx, findings);
  recordDoctorHealthWarnings(ctx, findings);
}
