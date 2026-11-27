import { note } from "../../packages/terminal-core/src/note.js";
import type { DoctorMaintenancePending } from "../commands/doctor-maintenance-pending.js";
import { shouldManageGatewayService } from "../commands/doctor-service-repair-policy.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import { resolveDoctorMode } from "./doctor-health-contribution-utils.js";
import type { HealthCheckContext, HealthFinding } from "./health-checks.js";

// A user-scoped systemd Gateway needs lingering, or systemd stops it on logout.

async function shouldInspectSystemdLinger(
  ctx: Pick<HealthCheckContext, "cfg" | "env">,
): Promise<boolean> {
  if (
    process.platform !== "linux" ||
    resolveDoctorMode(ctx.cfg) !== "local" ||
    !(await shouldManageGatewayService(ctx.env ?? process.env))
  ) {
    return false;
  }
  const env = ctx.env ?? process.env;
  const { findInstalledSystemdGatewayScope } = await import("../daemon/systemd.js");
  return (await findInstalledSystemdGatewayScope(env))?.scope === "user";
}

/** Enabling lingering needs an operator confirmation. */
const repairsSystemdLinger = (ctx: DoctorHealthFlowContext) => ctx.options.nonInteractive !== true;

export async function runSystemdLingerHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  if (!repairsSystemdLinger(ctx) || !(await shouldInspectSystemdLinger(ctx))) {
    return;
  }
  const { readGatewayServiceState, resolveGatewayService } = await import("../daemon/service.js");
  const { ensureSystemdUserLingerInteractive } = await import("../commands/systemd-linger.js");
  const service = resolveGatewayService();
  const state = await readGatewayServiceState(service, { env: process.env });
  if (state.loadState.status !== "loaded") {
    return;
  }
  await ensureSystemdUserLingerInteractive({
    runtime: ctx.runtime,
    prompter: {
      confirm: async (p) => ctx.prompter.confirm(p),
      note,
    },
    reason:
      "Gateway runs as a systemd user service. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
    requireConfirm: true,
  });
}

export async function detectSystemdLingerFindings(
  ctx: Pick<HealthCheckContext, "cfg" | "env">,
): Promise<readonly HealthFinding[]> {
  if (!(await shouldInspectSystemdLinger(ctx))) {
    return [];
  }
  const { readGatewayServiceState, resolveGatewayService } = await import("../daemon/service.js");
  const service = resolveGatewayService();
  const state = await readGatewayServiceState(service, { env: process.env });
  if (state.loadState.status !== "loaded") {
    return [];
  }
  const {
    isSystemdUserServiceAvailable,
    readSystemdUserLingerStatus,
    resolveSystemdUserServiceAccount,
  } = await import("../daemon/systemd.js");
  if (!(await isSystemdUserServiceAvailable(process.env))) {
    return [];
  }
  // Doctor must inspect the same user manager as the Gateway service operation.
  const user = resolveSystemdUserServiceAccount(process.env);
  if (!user) {
    return [];
  }
  const status = await readSystemdUserLingerStatus({ env: process.env, user });
  if (!status || status.linger === "yes") {
    return [];
  }
  return [
    {
      checkId: "core/doctor/systemd-linger",
      severity: "warning",
      source: "doctor",
      message: `Systemd lingering is disabled for ${status.user}.`,
      target: `systemd.user.${status.user}`,
      requirement: "systemd user lingering enabled",
      fixHint: `Run: sudo loginctl enable-linger ${status.user}`,
    },
  ];
}

export async function checkSystemdLingerRepairPending(
  ctx: DoctorHealthFlowContext,
): Promise<DoctorMaintenancePending> {
  return repairsSystemdLinger(ctx) && (await detectSystemdLingerFindings(ctx)).length > 0
    ? "work"
    : "none";
}
