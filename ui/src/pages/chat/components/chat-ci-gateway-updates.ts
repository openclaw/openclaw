import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../../../app/gateway.ts";
import { subscribeGatewaySnapshot } from "../../../lib/gateway-snapshot-observation.ts";

/** Native CI retains its connection-only read and authority-sensitive mutation interests. */
export function subscribeCiGatewayUpdates(
  gateway: ApplicationGateway,
  kind: "details" | "automation",
  listener: (snapshot: ApplicationGatewaySnapshot) => void,
): () => void {
  return subscribeGatewaySnapshot(
    gateway,
    kind === "details" ? "connection" : "authority",
    listener,
  );
}
