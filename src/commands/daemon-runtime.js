export const DEFAULT_GATEWAY_DAEMON_RUNTIME = "node";
export const GATEWAY_DAEMON_RUNTIME_OPTIONS = [
    {
        value: "node",
        label: "Node (recommended)",
        hint: "Required for WhatsApp + Telegram. Bun can corrupt memory on reconnect.",
    },
];
export function isGatewayDaemonRuntime(value) {
    return value === "node" || value === "bun";
}
