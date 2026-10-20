import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gatewayService from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { defaultRuntime } from "../../runtime.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { createGatewayRestartDeadline } from "../daemon-cli/restart-health-deadline.js";
import {
  callGateway,
  inspectPortUsage,
  makeGatewayService,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
  sleep,
} from "../daemon-cli/restart-health.test-helpers.js";
import * as servicePlan from "./update-command-service-plan.js";
import { verifyPreviousManagedGatewayForUpdate } from "./update-command-verification.js";

vi.mock("../../infra/package-json.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/package-json.js")>()),
  readPackageVersion: async () => "2026.9.5",
}));
vi.mock("../../infra/update-git-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-git-runtime.js")>()),
  readBuiltGatewayBuildId: async () => "previous-build",
}));
vi.mock("../../infra/update-run-ledger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-run-ledger.js")>()),
  recordUpdateRunStep: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  resetRestartHealthMocks();
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});

afterEach(() => {
  restoreRestartHealthMocks();
});

describe("previous Gateway readiness before update activation", () => {
  it.each([
    { readyz: 503, owned: true, verified: false },
    { readyz: 200, owned: true, verified: true },
    { readyz: 200, owned: false, verified: false },
  ])(
    "observes the incumbent once without spending activation's budget (HTTP $readyz, owned=$owned)",
    async ({ readyz, owned, verified }) => {
      const service = {
        ...makeGatewayService({ status: "running", pid: 8000 }),
        isLoaded: vi.fn(async () => false),
      };
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
      vi.spyOn(servicePlan, "gatewayServiceCommandUsesRoot").mockResolvedValue(owned);
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: "busy",
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      }));
      callGateway.mockImplementation((params) =>
        gatewayHealthResponse({
          server: { version: "2026.9.5", buildId: "previous-build", bootId: "previous-boot" },
          health: { channels: { discord: { probe: { ok: false, error: "4014" } } } },
        })(params),
      );
      const requests: string[] = [];
      const listener = await reserveTestPortListener({
        offsets: [0],
        createListener: () =>
          createServer((request, response) => {
            requests.push(request.url ?? "");
            response.writeHead(request.url === "/readyz" ? readyz : 200).end();
          }),
      });
      const deadline = createGatewayRestartDeadline({ timeoutMs: 60_000 });
      const onVerification = vi.fn();
      try {
        await verifyPreviousManagedGatewayForUpdate({
          root: "/synthetic-installation",
          config: {},
          env: { HOME: "/synthetic-home" },
          opts: { json: true, run: { runId: "previous-observation", env: {}, deadline } },
          timeoutMs: 60_000,
          service: {
            stopped: false,
            inspected: true,
            runtimeInspected: true,
            running: true,
            servicePort: listener.claim.port,
          },
          onVerification,
        });
        expect(onVerification).toHaveBeenLastCalledWith(verified);
        expect(requests.toSorted()).toEqual(["/healthz", "/readyz"]);
        expect(sleep).not.toHaveBeenCalled();
        expect(deadline.remainingMs()).toBe(60_000);
      } finally {
        deadline.dispose();
        listener.listener.closeAllConnections();
        await listener.releaseListener();
        await listener.claim.release();
      }
    },
  );
});
