import { resolveGatewayPort } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { readGatewayServiceState, resolveGatewayService } from "../daemon/service.js";
import { type UpdateCheckResult } from "../infra/update-check.js";
import {
  detectCoreInstallPathIssue,
  formatCoreInstallPathIssue,
  type CoreInstallPathIssue,
} from "../infra/core-install-path-check.js";
import { buildGatewayInstallPlan } from "./daemon-install-helpers.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME, type GatewayDaemonRuntime } from "./daemon-runtime.js";

export type InstallPathStatusSummary = {
  issue: CoreInstallPathIssue;
  formatted: string;
};

function detectGatewayRuntime(programArguments: string[] | undefined): GatewayDaemonRuntime {
  const first = programArguments?.[0];
  if (first) {
    const base = first.split(/[\\/]/).at(-1)?.toLowerCase();
    if (base === "bun" || base === "bun.exe") {
      return "bun";
    }
    if (base === "node" || base === "node.exe") {
      return "node";
    }
  }
  return DEFAULT_GATEWAY_DAEMON_RUNTIME;
}

export async function readInstallPathStatusSummary(params: {
  cfg: OpenClawConfig;
  update: UpdateCheckResult;
}): Promise<InstallPathStatusSummary> {
  const service = resolveGatewayService();
  const state = await readGatewayServiceState(service, { env: process.env }).catch(() => null);
  const runtimeChoice = detectGatewayRuntime(state?.command?.programArguments);
  const port = resolveGatewayPort(params.cfg, process.env);
  const expectedPlan = await buildGatewayInstallPlan({
    env: process.env,
    port,
    runtime: runtimeChoice,
    config: params.cfg,
  }).catch(() => null);

  const issue = await detectCoreInstallPathIssue({
    packageRoot: params.update.root,
    expectedProgramArguments: expectedPlan?.programArguments,
    serviceProgramArguments: state?.command?.programArguments,
    configPathCli: process.env.OPENCLAW_CONFIG ?? null,
    configPathService: state?.env?.OPENCLAW_CONFIG ?? null,
  });

  return {
    issue,
    formatted: formatCoreInstallPathIssue(issue),
  };
}
