import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { client, createGatewayHarness, type RequestFn } from "./overlays-access.test-support.ts";

export const AUTO_UPDATE_SCHEDULE = {
  channel: "stable",
  autoEnabled: true,
  target: { kind: "package", version: "2.0.0" },
  campaign: {
    id: "campaign-auto",
    state: "countdown",
    announcedAtMs: 1_000,
    applyAtMs: 61_000,
    forceAtMs: 901_000,
    updatedAtMs: 1_000,
  },
} as const;

export function createAutomaticUpdateHarness(request: RequestFn) {
  const harness = createGatewayHarness(client(request));
  harness.update({
    hello: {
      auth: { role: "operator", scopes: ["operator.admin"] },
      snapshot: { updateSchedule: AUTO_UPDATE_SCHEDULE },
    } as ApplicationGatewaySnapshot["hello"],
  });
  return harness;
}
