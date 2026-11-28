import { copyConfigResolutionFactsThroughRewrite } from "../config/resolution-facts.js";
import {
  listMissingMemberRolePresets,
  withMissingMemberRolePresets,
} from "../gateway/openclaw-id/member-role-presets.js";
import { createRoleSandboxReadinessCheck } from "../gateway/openclaw-id/sandbox-availability.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isOpenClawIdEnabled } from "../shared/openclaw-id-policy.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { readOpenClawIdUserProfiles } from "../state/user-profile-openclaw-id.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import {
  recordDoctorHealthWarnings,
  renderStructuredHealthFindings,
} from "./doctor-health-contribution.js";
import { readDoctorMemberRoles } from "./doctor-member-roles.store.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

const CHECK_ID = "core/doctor/member-roles";

/** Offline diagnostics inspect stored membership and use the shared engine availability probe. */
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
    const enabled = isOpenClawIdEnabled(cfg.gateway?.openclawId);
    let members: Map<string, string> | undefined;
    if (enabled) {
      try {
        members = await readDoctorMemberRoles(cfg, env);
      } catch {
        warn(
          "membership-unreadable",
          "Doctor could not read OpenClaw ID membership from the local claw record.",
          "Check the local claw storage and linking status on Access, then rerun Doctor; membership was not verified.",
        );
      }
    }
    // Without a default, stored assignments are active only for linked current members.
    if (
      roles.default === undefined &&
      Object.keys(roles.definitions).length &&
      (!enabled || members)
    ) {
      try {
        const stored = await executeExistingOpenClawStateRead(
          { env },
          { type: "userProfiles.catalog" },
        );
        const linked = await readOpenClawIdUserProfiles([...(members?.keys() ?? [])], { env });
        const memberProfiles = new Set(Object.values(linked).map(({ id }) => id));
        const inactive =
          stored?.profiles.filter(
            ([id, row]) => !row.merged_into && row.role && !memberProfiles.has(id),
          ) ?? [];
        if (inactive.length) {
          warn(
            "assignments-inactive",
            `${inactive.length} profile(s) have inactive stored role assignments because gateway.roles.default is absent and they are not current linked OpenClaw ID members.`,
            "Set gateway.roles.default to a defined role to enforce non-member profile assignments, or clear unused assignments with users.setRole (role: null).",
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
    if (!enabled) {
      return findings;
    }
    for (const name of listMissingMemberRolePresetRepairs(cfg)) {
      warn(
        "missing-preset",
        `OpenClaw ID preset role "${name}" has no definition.`,
        "Accept Doctor's missing-preset repair, or define the role in gateway.roles.definitions.",
        name,
      );
    }
    const sandboxUsers = new Map<string, string[]>();
    const addSandboxUser = (role: string, user: string) =>
      sandboxUsers.set(role, [...(sandboxUsers.get(role) ?? []), user]);
    for (const [accountId, role] of members ?? []) {
      const definition = Object.hasOwn(roles.definitions, role)
        ? roles.definitions[role]
        : undefined;
      if (!definition) {
        warn(
          "member-role-undefined",
          `OpenClaw ID member "${accountId}" has undefined role "${role}" and cannot connect.`,
          `Define "${role}" in gateway.roles.definitions, or change this member's role on the Access page.`,
          accountId,
        );
      } else if (definition.sandbox === "required") {
        addSandboxUser(role, `member "${accountId}" (role "${role}")`);
      }
    }
    if (roles.default && roles.definitions[roles.default]?.sandbox === "required") {
      addSandboxUser(roles.default, `people using the named default "${roles.default}"`);
    }
    const readiness = createRoleSandboxReadinessCheck(cfg);
    for (const [role, users] of sandboxUsers) {
      const result = await readiness(roles.definitions[role]!.agents);
      if (result.ready !== false) {
        continue;
      }
      const engine = result.backend === "podman" ? "Podman" : "Docker";
      if (result.reason === "engine_unavailable") {
        warn(
          "sandbox-unavailable",
          `Sandbox required for ${users.join(", ")}, but the configured ${engine} backend is unavailable; their runs will fail.`,
          `Make the configured ${engine} sandbox backend available. Required exec and file tools do not fall back to the host; see https://docs.openclaw.ai/gateway/sandboxing.`,
          role,
        );
      } else {
        warn(
          "sandbox-image-missing",
          `Sandbox required for ${users.join(", ")}, but the sandbox image ${result.image} is missing; their runs will fail.`,
          result.doctorBuilds
            ? `Accept Doctor's sandbox image build (openclaw doctor --fix); see https://docs.openclaw.ai/gateway/sandboxing.`
            : `Build or pull ${result.image} with ${engine}; see https://docs.openclaw.ai/gateway/sandboxing.`,
          role,
        );
      }
    }
    return findings;
  },
};

/** Preset roles the check reports and the repair adds: only with roles and OpenClaw ID on. */
function listMissingMemberRolePresetRepairs(cfg: DoctorHealthFlowContext["cfg"]) {
  return cfg.gateway?.roles && isOpenClawIdEnabled(cfg.gateway.openclawId)
    ? listMissingMemberRolePresets(cfg)
    : [];
}

/** Read-only: whether {@link runMemberRolesHealth} would offer to add missing presets. */
export function hasMemberRolePresetRepair(
  ctx: Pick<DoctorHealthFlowContext, "cfg" | "sourceConfigValid">,
): boolean {
  return ctx.sourceConfigValid && listMissingMemberRolePresetRepairs(ctx.cfg).length > 0;
}

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
    hasMemberRolePresetRepair(ctx) &&
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
