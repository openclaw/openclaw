import {
  applyClawMcpRecovery,
  buildClawMcpRecoveryPlan,
  CLAW_MCP_RECOVERY_PLAN_SCHEMA_VERSION,
  CLAW_MCP_RECOVERY_RESULT_SCHEMA_VERSION,
  ClawMcpRecoveryError,
} from "../claws/mcp-recovery.js";
import { CLAW_OUTPUT_STABILITY } from "../claws/types.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { emitClawFailure, logClawExperimentalWarning } from "./claws-cli-output.js";
import type { ClawsMcpRecoverOptions } from "./claws-cli.js";

export async function runClawsMcpRecoverCommand(
  agentId: string,
  name: string,
  opts: ClawsMcpRecoverOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  if (!opts.dryRun && (!opts.yes || !opts.planIntegrity)) {
    const message = opts.yes
      ? "MCP recovery requires --plan-integrity from the exact dry-run preview."
      : "MCP recovery requires consent; preview with --dry-run, then apply with --yes and --plan-integrity.";
    emitClawFailure(runtime, opts.json, message, {
      schemaVersion: CLAW_MCP_RECOVERY_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      ok: false,
      error: { code: opts.yes ? "plan_integrity_required" : "consent_required", message },
    });
    return;
  }

  try {
    if (opts.dryRun) {
      const plan = await buildClawMcpRecoveryPlan(agentId, name);
      if (opts.json) {
        writeRuntimeJson(runtime, plan);
      } else {
        logClawExperimentalWarning(runtime);
        runtime.log(`Claw MCP reference: ${plan.agentId}/${plan.name}`);
        runtime.log(`Recovery action: ${plan.action}`);
        runtime.log(`Recorded digest: ${plan.ref.configDigest}`);
        runtime.log(
          `Live MCP config: ${plan.liveConfig.state}${plan.liveConfig.digest ? ` (${plan.liveConfig.digest})` : ""}`,
        );
        if (plan.blocker) {
          runtime.log(`Recovery blocked: ${plan.blocker.message}`);
        }
        runtime.log("Live MCP config will be retained unchanged.");
        runtime.log(`Plan integrity: ${plan.planIntegrity}`);
      }
      return;
    }

    const result = await applyClawMcpRecovery(agentId, name, opts.planIntegrity!);
    if (opts.json) {
      writeRuntimeJson(runtime, result);
    } else {
      logClawExperimentalWarning(runtime);
      runtime.log(`Recovered Claw MCP reference: ${result.agentId}/${result.name}`);
      runtime.log(`Action: ${result.action}`);
      runtime.log("Live MCP config was retained unchanged.");
    }
  } catch (error) {
    const code = error instanceof ClawMcpRecoveryError ? error.code : "mcp_recovery_failed";
    const message = error instanceof Error ? error.message : String(error);
    emitClawFailure(runtime, opts.json, message, {
      schemaVersion: CLAW_MCP_RECOVERY_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      status: "failed",
      error: { code, message },
    });
  }
}
