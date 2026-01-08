export type GatewayDaemonRuntime = "node" | "bun";

export const DEFAULT_GATEWAY_DAEMON_RUNTIME: GatewayDaemonRuntime = "node";

export const GATEWAY_DAEMON_RUNTIME_OPTIONS: Array<{
  value: GatewayDaemonRuntime;
  label: string;
  hint?: string;
}> = [
  {
    value: "node",
    label: "Node (recommended)",
    hint: "Required for WhatsApp (Baileys WebSocket). Bun can corrupt memory on reconnect.",
  },
  {
    value: "bun",
    label: "Bun (faster)",
    hint: "Use only when WhatsApp is disabled",
  },
];

export function isGatewayDaemonRuntime(
  value: string | undefined,
): value is GatewayDaemonRuntime {
  return value === "node" || value === "bun";
}
