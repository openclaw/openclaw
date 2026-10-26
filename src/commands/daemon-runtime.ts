import { isStandaloneRuntimeExecutable } from "../../cli-invocation.mjs";
import { isBunRuntime } from "../daemon/runtime-binary.js";

export type GatewayDaemonRuntime = "bun" | "node" | "standalone";

export const DEFAULT_GATEWAY_DAEMON_RUNTIME: GatewayDaemonRuntime = "node";

export const GATEWAY_DAEMON_RUNTIME_OPTIONS: Array<{
  value: GatewayDaemonRuntime;
  label: string;
  hint?: string;
}> = [
  {
    value: "node",
    label: "Node",
    hint: "Primary and recommended runtime for managed services.",
  },
  {
    value: "bun",
    label: "Bun 1.4.3+",
    hint: "Requires Bun 1.4.3 or newer with WAL-reset-safe node:sqlite.",
  },
];

export function isGatewayDaemonRuntime(value: string | undefined): value is GatewayDaemonRuntime {
  return value === "bun" || value === "node" || value === "standalone";
}

/** Detects the runtime selected by an installed daemon command. */
export function resolveGatewayDaemonRuntime(
  programArguments: string[] | undefined,
): GatewayDaemonRuntime {
  const executable = programArguments?.[0] ?? "";
  if (isStandaloneRuntimeExecutable(executable)) {
    return "standalone";
  }
  return isBunRuntime(executable) ? "bun" : DEFAULT_GATEWAY_DAEMON_RUNTIME;
}
