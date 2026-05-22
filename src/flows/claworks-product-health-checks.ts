import {
  CLAWORKS_STANDARD_GATEWAY_PORT,
  OPENCLAW_RESERVED_GATEWAY_PORT,
  repairClaworksGatewayPortInConfig,
  claworksGatewayPortConflict,
} from "../config/claworks-gateway.js";
import {
  detectClaworksLaunchAgentPortConflict,
  detectMisplacedOpenClawLaunchAgent,
} from "../config/claworks-product-guard.js";
import { isClaworksProduct } from "../config/paths.js";
import { repairClaworksLaunchAgentIsolation } from "../daemon/claworks-launch-agent-repair.js";
import { registerHealthCheck } from "./health-check-registry.js";
import type { HealthCheck, HealthFinding, HealthRepairContext } from "./health-checks.js";

const MISENTRY_CHECK_ID = "claworks/product/misentry";

const claworksMisentryCheck: HealthCheck = {
  id: MISENTRY_CHECK_ID,
  kind: "core",
  description: "ClaWorks was inferred from ~/.claworks env without the claworks CLI entry.",
  source: "doctor",
  async detect() {
    if (process.env._CLAWORKS_INFERRED_PRODUCT !== "1") {
      return [];
    }
    return [
      {
        checkId: MISENTRY_CHECK_ID,
        severity: "warning",
        message:
          "ClaWorks product mode was inferred from OPENCLAW_STATE_DIR/config. Prefer `node claworks.mjs` so gateway install uses ai.claworks.gateway and port 18800 consistently.",
        fixHint: "node claworks.mjs gateway install --force",
      },
    ] satisfies HealthFinding[];
  },
};

const CHECK_ID = "claworks/product/gateway-port";

const claworksGatewayPortCheck: HealthCheck = {
  id: CHECK_ID,
  kind: "core",
  description: "ClaWorks gateway.port does not collide with OpenClaw (18789).",
  source: "doctor",
  async detect(ctx) {
    if (!isClaworksProduct(process.env)) {
      return [];
    }
    if (!claworksGatewayPortConflict(ctx.cfg)) {
      return [];
    }
    return [
      {
        checkId: CHECK_ID,
        severity: "error",
        message: `gateway.port is ${OPENCLAW_RESERVED_GATEWAY_PORT}, which is reserved for OpenClaw. ClaWorks must use ${CLAWORKS_STANDARD_GATEWAY_PORT}.`,
        path: "gateway.port",
        fixHint: `claworks config set gateway.port ${CLAWORKS_STANDARD_GATEWAY_PORT}`,
      },
    ] satisfies HealthFinding[];
  },
  async repair(ctx: HealthRepairContext, _findings: readonly HealthFinding[]) {
    if (!isClaworksProduct(process.env)) {
      return { status: "skipped", reason: "not ClaWorks product mode", changes: [] };
    }
    if (!claworksGatewayPortConflict(ctx.cfg)) {
      return { status: "skipped", reason: "no port conflict", changes: [] };
    }
    const next = repairClaworksGatewayPortInConfig(ctx.cfg);
    return {
      status: "repaired",
      config: next,
      changes: [
        `gateway.port: ${OPENCLAW_RESERVED_GATEWAY_PORT} -> ${CLAWORKS_STANDARD_GATEWAY_PORT} (ClaWorks isolation from OpenClaw)`,
      ],
    };
  },
};

const LAUNCH_AGENT_CHECK_ID = "claworks/product/launch-agent";

const claworksLaunchAgentCheck: HealthCheck = {
  id: LAUNCH_AGENT_CHECK_ID,
  kind: "core",
  description: "ClaWorks LaunchAgent labels and ports do not collide with OpenClaw.",
  source: "doctor",
  async detect() {
    if (!isClaworksProduct(process.env)) {
      return [];
    }
    const findings: HealthFinding[] = [];
    const misplaced = detectMisplacedOpenClawLaunchAgent(process.env);
    if (misplaced) {
      findings.push({
        checkId: LAUNCH_AGENT_CHECK_ID,
        severity: "error",
        message: `${misplaced} LaunchAgent points at ~/.claworks — it steals port 18789 from OpenClaw.`,
        fixHint: "claworks doctor --fix",
      });
    }
    if (detectClaworksLaunchAgentPortConflict(process.env)) {
      findings.push({
        checkId: LAUNCH_AGENT_CHECK_ID,
        severity: "error",
        message: `ai.claworks.gateway service still uses port ${OPENCLAW_RESERVED_GATEWAY_PORT}. Reinstall on ${CLAWORKS_STANDARD_GATEWAY_PORT}.`,
        fixHint: "claworks doctor --fix",
      });
    }
    return findings;
  },
  async repair(ctx: HealthRepairContext, findings: readonly HealthFinding[]) {
    if (!isClaworksProduct(process.env) || findings.length === 0) {
      return { status: "skipped", reason: "no launch agent findings", changes: [] };
    }
    const result = repairClaworksLaunchAgentIsolation(process.env, { dryRun: ctx.dryRun });
    if (result.changes.length === 0) {
      return {
        status: "skipped",
        reason: "nothing to repair",
        changes: [],
        warnings: result.warnings,
      };
    }
    return {
      status: result.warnings.some((w) => w.includes("failed")) ? "failed" : "repaired",
      changes: result.changes,
      warnings: result.warnings,
      effects: result.changes.map((change) => ({
        kind: "service" as const,
        action: change,
        dryRunSafe: ctx.dryRun === true,
      })),
    };
  },
};

export function registerClaworksProductHealthChecks(): void {
  registerHealthCheck(claworksMisentryCheck);
  registerHealthCheck(claworksLaunchAgentCheck);
  registerHealthCheck(claworksGatewayPortCheck);
}
