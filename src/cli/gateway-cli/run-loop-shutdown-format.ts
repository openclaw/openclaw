import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import type {
  GatewayDrainReason,
  GatewayShutdownTrigger,
} from "../../process/gateway-work-admission.js";

export function formatShutdownReason(request: {
  action: "stop" | "restart" | "external-restart";
  signal: GatewayShutdownTrigger;
  restartReason?: string;
}): GatewayDrainReason {
  const { action, signal, restartReason } = request;
  const trigger =
    restartReason && restartReason !== signal
      ? (`${signal}: ${truncateUtf16Safe(restartReason.replaceAll(/\s+/g, " "), 200)}` as const)
      : signal;
  return `${action === "stop" ? "stop" : "restart"} (${trigger})`;
}

// Blocker descriptions can contain task identities and request origins.
export function formatDrainCounts(snapshot: GatewayActiveWorkSnapshot): string {
  return Object.entries(snapshot.counts)
    .filter(([name, count]) => name !== "totalActive" && count > 0)
    .map(([name, count]) => `${name}=${count}`)
    .join(" ");
}
