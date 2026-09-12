/** Checks the executable recorded in a Gateway service against the runtime contract. */
import { SUPPORTED_NODE_VERSIONS } from "../../node-version.mjs";
import { isBunRuntime, isNodeRuntime } from "./runtime-binary.js";
import {
  isSystemNodePath,
  isVersionManagedNodePath,
  resolveBunRuntimeInfo,
  resolveNodeRuntimeInfo,
  resolveSystemNodePath,
} from "./runtime-paths.js";
import type { GatewayServiceCommand, ServiceConfigIssue } from "./service-audit-types.js";

export const SERVICE_RUNTIME_AUDIT_CODES = {
  gatewayRuntimeBun: "gateway-runtime-bun",
  gatewayRuntimeNode: "gateway-runtime-node",
  gatewayRuntimeProbeFailed: "gateway-runtime-probe-failed",
  gatewayRuntimeNodeVersionManager: "gateway-runtime-node-version-manager",
  gatewayRuntimeNodeSystemMissing: "gateway-runtime-node-system-missing",
} as const;

export async function auditGatewayRuntime(
  env: Record<string, string | undefined>,
  command: GatewayServiceCommand,
  issues: ServiceConfigIssue[],
  platform: NodeJS.Platform,
  timeoutMs?: number,
): Promise<string | undefined> {
  const execPath = command?.programArguments?.[0];
  if (!execPath) {
    return undefined;
  }

  if (isBunRuntime(execPath)) {
    const runtime = await resolveBunRuntimeInfo(execPath);
    if (runtime.status !== "supported") {
      issues.push({
        code:
          runtime.status === "probe-failed"
            ? SERVICE_RUNTIME_AUDIT_CODES.gatewayRuntimeProbeFailed
            : SERVICE_RUNTIME_AUDIT_CODES.gatewayRuntimeBun,
        message:
          runtime.status === "probe-failed"
            ? "Gateway service Bun runtime probe failed."
            : "Gateway service uses an unsupported Bun runtime; Bun 1.4+ with WAL-reset-safe node:sqlite is required.",
        detail:
          runtime.status === "probe-failed"
            ? runtime.error.message
            : runtime.sqliteSelectionError
              ? `${execPath}: ${runtime.sqliteSelectionError}`
              : execPath,
        level: "recommended",
      });
    }
    return undefined;
  }

  if (!isNodeRuntime(execPath)) {
    return undefined;
  }

  const runtime = await resolveNodeRuntimeInfo(execPath, env, timeoutMs);
  if (runtime.status !== "supported") {
    issues.push({
      code:
        runtime.status === "probe-failed"
          ? SERVICE_RUNTIME_AUDIT_CODES.gatewayRuntimeProbeFailed
          : SERVICE_RUNTIME_AUDIT_CODES.gatewayRuntimeNode,
      message:
        runtime.status === "probe-failed"
          ? "Gateway service Node runtime probe failed."
          : (runtime.capabilityError ?? "Gateway service Node failed its capability probe."),
      detail: runtime.status === "probe-failed" ? runtime.error.message : execPath,
      level: "recommended",
    });
  }

  if (isVersionManagedNodePath(execPath, platform)) {
    issues.push({
      code: SERVICE_RUNTIME_AUDIT_CODES.gatewayRuntimeNodeVersionManager,
      message: "Gateway service uses Node from a version manager; it can break after upgrades.",
      detail: execPath,
      level: "recommended",
    });
    if (!isSystemNodePath(execPath, env, platform)) {
      const systemNode = await resolveSystemNodePath(env, platform);
      if (!systemNode) {
        issues.push({
          code: SERVICE_RUNTIME_AUDIT_CODES.gatewayRuntimeNodeSystemMissing,
          message: `System Node ${SUPPORTED_NODE_VERSIONS} not found; install it before migrating away from version managers.`,
          level: "recommended",
        });
      }
    }
  }
  return runtime.status === "supported" ? runtime.note : undefined;
}
