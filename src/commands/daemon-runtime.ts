export type GatewayDaemonRuntime = "node" | "bun";

/** Default daemon runtime used when install/configure flows do not ask. */
export const DEFAULT_GATEWAY_DAEMON_RUNTIME: GatewayDaemonRuntime = "node";

/** Runtime choices exposed by daemon install prompts. */
export const GATEWAY_DAEMON_RUNTIME_OPTIONS: Array<{
  value: GatewayDaemonRuntime;
  label: string;
  hint?: string;
}> = [
  {
    value: "node",
    label: "Node (recommended)",
    hint: "Required for WhatsApp + Telegram. Bun can corrupt memory on reconnect.",
  },
];

/** Narrows untrusted runtime input to the daemon runtime enum. */
export function isGatewayDaemonRuntime(value: string | undefined): value is GatewayDaemonRuntime {
  return value === "node" || value === "bun";
}
