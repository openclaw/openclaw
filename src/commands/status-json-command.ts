// Shared command runner for `openclaw status --json`.
// It keeps scan execution separate from JSON payload assembly so CLI variants can reuse the same output path.

import { readUpdateRunStatus } from "../infra/update-run-status.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { resolveStatusJsonOutput } from "./status-json-runtime.ts";
import { reportStatusScanFailure } from "./status-runtime-shared.ts";
import type { StatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";

type StatusJsonCommandOptions = {
  deep?: boolean;
  usage?: boolean;
  agent?: string;
  timeoutMs?: number;
  all?: boolean;
};

/** Prevents --agent from implying that the aggregate status report itself is agent-scoped. */
export function assertStatusUsageAgentScope(opts: StatusJsonCommandOptions): void {
  if (opts.agent !== undefined && opts.usage !== true) {
    throw new Error("--agent is only valid with --usage");
  }
}

/** Runs the fast status scan, resolves optional deep fields, and writes JSON through the runtime. */
export async function runStatusJsonCommand(params: {
  opts: StatusJsonCommandOptions & StatusGatewayProbeBudget;
  runtime: RuntimeEnv;
  includeSecurityAudit: boolean;
  includePluginCompatibility?: boolean;
  suppressHealthErrors?: boolean;
  scanStatusJsonFast: (
    opts: StatusGatewayProbeBudget & { all?: boolean },
    runtime: RuntimeEnv,
  ) => Promise<Parameters<typeof resolveStatusJsonOutput>[0]["scan"]>;
}) {
  assertStatusUsageAgentScope(params.opts);
  const scan = await params
    .scanStatusJsonFast(
      {
        timeoutMs: params.opts.timeoutMs,
        gatewayProbeDeadlineMs: params.opts.gatewayProbeDeadlineMs,
        all: params.opts.all,
      },
      params.runtime,
    )
    .catch((error: unknown) =>
      reportStatusScanFailure(error, params.runtime, params.opts.timeoutMs),
    );
  const updateRunStatus = readUpdateRunStatus();
  writeRuntimeJson(params.runtime, {
    ...(await resolveStatusJsonOutput({
      scan,
      opts: params.opts,
      includeSecurityAudit: params.includeSecurityAudit,
      includePluginCompatibility: params.includePluginCompatibility,
      suppressHealthErrors: params.suppressHealthErrors,
    })),
    ...(Object.keys(updateRunStatus).length ? { updateRunStatus } : {}),
  });
}
