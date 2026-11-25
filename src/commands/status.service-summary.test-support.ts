import { vi } from "vitest";
import * as nodeService from "../daemon/node-service.js";
import * as gatewayService from "../daemon/service.js";
import { createMockGatewayService } from "../daemon/service.test-helpers.js";
import * as packageRoot from "../infra/openclaw-root.js";
import { resolveStatusServiceSummaries } from "./status-runtime-shared.ts";

export async function readGatewayServiceStatusForTest(
  service: gatewayService.GatewayService,
  activePackageRoot: string | null = null,
) {
  vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
  vi.spyOn(nodeService, "resolveNodeService").mockReturnValue(createMockGatewayService());
  vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(activePackageRoot);
  return (await resolveStatusServiceSummaries())[0];
}
