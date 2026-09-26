/** Inspect captured native service commands for repairable start drift. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTcpPort, parseTcpPortFromArgs } from "../infra/tcp-port.js";
import { resolveServiceEntrypoint } from "./service-layout.js";
import type { GatewayServiceStartRepairIssue, GatewayServiceState } from "./service-types.js";

const TEMP_PROGRAM_ROOTS = [os.tmpdir(), "/tmp", "/private/tmp", "/var/tmp"].map((entry) =>
  path.resolve(entry),
);
export function collectGatewayServiceStartRepairIssues(
  state: GatewayServiceState,
  expectedPort?: number,
): GatewayServiceStartRepairIssue[] {
  const command = state.command;
  if (state.loadState.status !== "loaded" || !command) {
    return [];
  }
  const issues: GatewayServiceStartRepairIssue[] = [];
  const servicePort =
    parseTcpPortFromArgs(command.programArguments) ??
    parseTcpPort(command.environment?.OPENCLAW_GATEWAY_PORT ?? "");
  if (expectedPort !== undefined && servicePort !== null && servicePort !== expectedPort) {
    issues.push({
      code: "port-mismatch",
      message: `service port ${servicePort} does not match current gateway config port ${expectedPort}`,
    });
  }
  for (const candidate of new Set([
    command.programArguments[0],
    resolveServiceEntrypoint(command),
  ])) {
    if (!candidate || !path.isAbsolute(candidate)) {
      continue;
    }
    const resolved = path.resolve(candidate);
    if (
      TEMP_PROGRAM_ROOTS.some(
        (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
      )
    ) {
      issues.push({
        code: "temporary-program",
        message: `service command points at a temporary path: ${candidate}`,
      });
      continue;
    }
    if (!fs.existsSync(candidate)) {
      issues.push({
        code: "missing-program",
        message: `service command points at a missing path: ${candidate}`,
      });
    }
  }
  return issues;
}

export function formatGatewayServiceStartRepairIssues(
  issues: GatewayServiceStartRepairIssue[],
): string {
  return issues.map((issue) => issue.message).join("; ");
}
