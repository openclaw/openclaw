import { onTestFinished } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { createUsageDetails } from "./usage-details.ts";
import { contextWithClient } from "./usage-page.test-support.ts";

export function createUsageDetailFixture(
  client: GatewayBrowserClient,
  context = contextWithClient(client),
) {
  const gateway = new GatewayPageBinding(() => {}, { getGateway: () => context.gateway });
  const details = createUsageDetails(
    () => {},
    gateway,
    () => ({ startDate: "2026-08-07", endDate: "2026-08-07", scope: "family", timeZone: "local" }),
    () => [],
    () => {},
  );
  gateway.connect();
  onTestFinished(() => {
    details.cancel();
    gateway.dispose();
  });
  return { details };
}
