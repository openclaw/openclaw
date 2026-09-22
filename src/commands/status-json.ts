// Thin `openclaw status --json` wrapper.
// Command wiring lives here; scan/payload behavior lives in the shared JSON command runner.

import type { RuntimeEnv } from "../runtime.js";
import { runStatusJsonCommand } from "./status-json-command.ts";
import { createStatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import { scanStatusJsonFast } from "./status.scan.fast-json.js";

/** Runs status JSON with the standard fast scan and all-mode security audit behavior. */
export async function statusJsonCommand(
  opts: {
    deep?: boolean;
    usage?: boolean;
    agent?: string;
    timeoutMs?: number;
    all?: boolean;
  },
  runtime: RuntimeEnv,
) {
  await runStatusJsonCommand({
    opts: { ...opts, ...createStatusGatewayProbeBudget(opts.timeoutMs) },
    runtime,
    scanStatusJsonFast,
    includeSecurityAudit: opts.all === true || opts.deep === true,
    includePluginCompatibility: opts.all === true,
    suppressHealthErrors: true,
  });
}
