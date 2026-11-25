import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as gatewayService from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import * as packageJson from "../../infra/package-json.js";
import * as gitRuntime from "../../infra/update-git-runtime.js";
import * as ledger from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { createGatewayRestartDeadline } from "../daemon-cli/restart-health-deadline.js";
import * as health from "../daemon-cli/restart-health.test-helpers.js";
import * as servicePlan from "./update-command-service-plan.js";
import { verifyPreviousManagedGatewayForUpdate } from "./update-command-verification.js";

beforeEach(() => {
  health.resetRestartHealthMocks();
  vi.spyOn(packageJson, "readPackageVersion").mockResolvedValue("2026.9.5");
  vi.spyOn(gitRuntime, "readBuiltGatewayBuildId").mockResolvedValue("previous-build");
  vi.spyOn(ledger, "recordUpdateRunStep").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});

afterEach(health.restoreRestartHealthMocks);

it.each([
  { readyz: 503, owned: true, verified: false },
  { readyz: 200, owned: true, verified: true },
  { readyz: 200, owned: false, verified: false },
])("observes incumbent ($readyz/$owned) once", async ({ readyz, owned, verified }) => {
  vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(
    health.makeGatewayService({ status: "running", pid: 8000 }),
  );
  vi.spyOn(servicePlan, "gatewayServiceCommandUsesRoot").mockResolvedValue(owned);
  health.inspectPortUsage.mockImplementation(async (port) => ({
    port,
    status: "busy",
    listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
    hints: [],
  }));
  health.callGateway.mockImplementation(
    gatewayHealthResponse({
      server: { version: "2026.9.5", buildId: "previous-build", bootId: "previous-boot" },
      health: { channels: { discord: { probe: { ok: false, error: "4014" } } } },
    }),
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
    expect(health.sleep).not.toHaveBeenCalled();
    expect(deadline.remainingMs()).toBe(60_000);
  } finally {
    deadline.dispose();
    listener.listener.closeAllConnections();
    await listener.releaseListener();
    await listener.claim.release();
  }
});
