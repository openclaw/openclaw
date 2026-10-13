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
import { readDaemonRuntimePin } from "./runtime-pin-state.js";
import type { GatewayServiceCommand, ServiceConfigIssue } from "./service-audit-types.js";
import { normalizeServicePathEntry } from "./service-path-policy.js";

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

  const bun = isBunRuntime(execPath);
  if (!bun && !isNodeRuntime(execPath)) {
    return undefined;
  }
  const runtime = bun
    ? await resolveBunRuntimeInfo(execPath)
    : await resolveNodeRuntimeInfo(execPath, env, timeoutMs);
  if (runtime.status !== "supported") {
    issues.push({
      code:
        runtime.status === "probe-failed"
          ? SERVICE_RUNTIME_AUDIT_CODES.gatewayRuntimeProbeFailed
          : bun
            ? SERVICE_RUNTIME_AUDIT_CODES.gatewayRuntimeBun
            : SERVICE_RUNTIME_AUDIT_CODES.gatewayRuntimeNode,
      message:
        runtime.status === "probe-failed"
          ? `Gateway service ${bun ? "Bun" : "Node"} runtime check failed.`
          : bun
            ? "Gateway service uses an unsupported Bun runtime; Bun 1.4+ with WAL-reset-safe node:sqlite is required."
            : (runtime.capabilityError ?? "Gateway service Node failed its capability check."),
      detail:
        runtime.status === "probe-failed"
          ? runtime.error.message
          : bun && runtime.sqliteSelectionError
            ? `${execPath}: ${runtime.sqliteSelectionError}`
            : execPath,
      level: "recommended",
    });
  }
  if (bun) {
    return undefined;
  }

  const pinnedPath = readDaemonRuntimePin({ kind: "gateway", env }, command).pin?.path;
  const explicitlyPinned =
    pinnedPath &&
    normalizeServicePathEntry(pinnedPath, platform) ===
      normalizeServicePathEntry(execPath, platform);
  if (!explicitlyPinned && isVersionManagedNodePath(execPath, platform)) {
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
