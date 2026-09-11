import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import * as gatewayService from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { recordUpdateRunVerification } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import {
  callGateway,
  inspectPortUsage,
  makeGatewayService,
  monotonicClock,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
} from "../daemon-cli/restart-health.test-helpers.js";
import {
  GatewayRestartHealthError,
  runUpdatedInstallGatewayCommand,
} from "./update-command-service-command.js";
import { maybeRestartService } from "./update-command-service.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

vi.mock("../../infra/update-run-ledger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-run-ledger.js")>()),
  recordUpdateRunStep: vi.fn(),
  recordUpdateRunVerification: vi.fn(),
}));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn() },
}));
vi.mock("./restart-helper.js", () => ({ runRestartScript: vi.fn(async () => true) }));
vi.mock("../../infra/gateway-supervision.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-supervision.js")>()),
  assertGatewayServiceMutationAllowed: vi.fn(),
}));
vi.mock("./update-command-config-snapshot.js", () => ({
  createUpdateConfigSnapshot: vi.fn(async () => undefined),
}));
vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: vi.fn(async () => "accepted"),
}));

let server: Server;
let controller: AbortController;
let pendingVerification: Promise<unknown> | undefined;
beforeEach(() => {
  controller = new AbortController();
  pendingVerification = undefined;
  vi.clearAllMocks();
  resetRestartHealthMocks();
});
afterEach(async () => {
  controller.abort();
  await pendingVerification?.catch(() => {});
  restoreRestartHealthMocks();
  server?.closeAllConnections();
  if (server?.listening) {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
});

describe("update readiness generation", () => {
  it.each(["restart script", "service refresh", "child readiness timeout", "legacy update marker"])(
    "lets a 90-second startup finish within the update budget (%s)",
    async (activation) => {
      const refreshServiceEnv = activation === "service refresh";
      const childTimeout = activation === "child readiness timeout";
      if (childTimeout) {
        vi.mocked(runUpdatedInstallGatewayCommand).mockImplementationOnce(async () => {
          monotonicClock.nowMs = 60_000;
          throw new GatewayRestartHealthError(
            "Gateway restart timed out after 60s waiting for health checks.",
          );
        });
      }
      mockProcessPlatform("linux");
      const service = makeGatewayService({ status: "running", pid: 8000 });
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: monotonicClock.nowMs < 90_000 ? "free" : "busy",
        listeners: monotonicClock.nowMs < 90_000 ? [] : [{ pid: 8000 }],
        hints: [],
      }));
      callGateway.mockImplementation(
        gatewayHealthResponse({
          server: { version: "2026.9.4", buildId: "candidate-build", bootId: "slow-boot" },
        }),
      );
      server = createServer((_req, res) => res.writeHead(200).end());
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing loopback listener");
      }
      const result =
        activation === "legacy update marker"
          ? (
              await verifyUpdatedGateway({
                result: { status: "ok", mode: "npm", steps: [], durationMs: 0 },
                opts: { json: true },
                serviceEnv: { HOME: "/synthetic-home", OPENCLAW_UPDATE_IN_PROGRESS: "1" },
                gatewayPort: address.port,
                expectedVersion: "2026.9.4",
                expectedBuildId: "candidate-build",
                requireRunningService: true,
              })
            ).ok
            ? "ok"
            : "restart-health-failed"
          : await maybeRestartService({
              shouldRestart: true,
              result: {
                status: "ok",
                mode: "npm",
                steps: [],
                durationMs: 0,
                after: { version: "2026.9.4", buildId: "candidate-build" },
              },
              opts: { json: true },
              refreshServiceEnv,
              serviceEnv: { HOME: "/synthetic-home" },
              gatewayPort: address.port,
              restartScriptPath: childTimeout ? undefined : "/synthetic-restart.sh",
              requireRunningServiceAfterRestart: true,
              timeoutMs: 120_000,
            });
      expect(result, JSON.stringify(vi.mocked(defaultRuntime.error).mock.calls)).toBe("ok");
      expect(monotonicClock.nowMs).toBe(95_500);
      expect(callGateway).toHaveBeenCalledTimes(14);
      const { runRestartScript } = await import("./restart-helper.js");
      expect(runRestartScript).toHaveBeenCalledTimes(
        refreshServiceEnv || childTimeout || activation === "legacy update marker" ? 0 : 1,
      );
    },
  );

  it.each([
    { transition: "unchanged", supplied: false },
    { transition: "replacement", supplied: false },
    { transition: "same-pid-new-boot", supplied: false },
    { transition: "replacement-during-final-health", supplied: false },
    { transition: "same-pid-new-boot-during-native", supplied: false },
    { transition: "pidless-new-boot-during-native", supplied: false },
    { transition: "unchanged-pidless", supplied: false },
    { transition: "first-final-health-error", supplied: false },
    { transition: "last-final-health-error", supplied: false },
    { transition: "unchanged", supplied: true },
    { transition: "replacement", supplied: true },
  ] as const)(
    "binds final readiness to the settled generation: $transition, supplied=$supplied",
    async ({ transition, supplied }) => {
      // Keep the real settle, health/hello interpretation and HTTP readiness loop.
      // Only the service manager/health RPC are synthetic; HTTP uses a local socket.
      const pidless = transition.includes("pidless");
      const unchanged = transition.startsWith("unchanged");
      if (pidless) {
        mockProcessPlatform("win32");
      }
      let runtime: GatewayServiceRuntime = { status: "running", ...(pidless ? {} : { pid: 8000 }) };
      let bootId = "boot-a";
      const service = makeGatewayService({ status: "running", pid: 8000 });
      vi.mocked(service.readRuntime).mockImplementation(async () => {
        if (transition.endsWith("during-native") && callGateway.mock.calls.length === 13) {
          bootId = "boot-b";
        }
        return { ...runtime };
      });
      service.isLoaded = vi.fn(async () => true);
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: "busy",
        listeners: [{ pid: runtime.pid, commandLine: "openclaw-gateway" }],
        hints: [],
      }));
      callGateway.mockImplementation(async (opts) => {
        const response = await gatewayHealthResponse({
          server: { version: "2026.9.1", buildId: "candidate-build", bootId },
          ...((transition === "first-final-health-error" && callGateway.mock.calls.length === 13) ||
          (transition === "last-final-health-error" && callGateway.mock.calls.length === 14)
            ? { error: new Error("synthetic health failed") }
            : {}),
        })(opts);
        if (
          transition === "replacement-during-final-health" &&
          callGateway.mock.calls.length > 12
        ) {
          runtime = { status: "running", pid: 8001 };
        }
        return response;
      });
      const reached = createDeferred();
      const release = createDeferred();
      server = createServer((req, res) => {
        if (req.url === "/readyz") {
          reached.resolve();
          void release.promise.then(() => res.writeHead(200).end());
        } else {
          res.writeHead(200).end();
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing loopback listener");
      }
      const probeParams = {
        service,
        port: address.port,
        env: { HOME: "/synthetic-home" },
        expectedVersion: "2026.9.1",
        expectedBuildId: "candidate-build",
        requireRunningService: true,
        settle: { probes: 12 },
        signal: controller.signal,
      };
      const { waitForGatewayHealthyRestart } = await import("../daemon-cli/restart-health.js");
      const health = supplied ? await waitForGatewayHealthyRestart(probeParams) : undefined;
      const onVerified = vi.fn();
      const verification = verifyUpdatedGateway({
        result: { status: "ok", mode: "npm", steps: [], durationMs: 0 },
        opts: { json: true, run: { runId: "synthetic-update", env: {} } },
        serviceEnv: probeParams.env,
        signal: controller.signal,
        health,
        gatewayPort: address.port,
        expectedVersion: "2026.9.1",
        expectedBuildId: "candidate-build",
        requireRunningService: true,
        onVerified,
      });
      pendingVerification = verification;
      await Promise.race([
        reached.promise,
        verification.then(() => {
          throw new Error("Verifier returned before HTTP readiness");
        }),
      ]);
      expect(callGateway).toHaveBeenCalledTimes(12);
      if (transition === "replacement" || transition === "same-pid-new-boot") {
        bootId = "boot-b";
        runtime = { status: "running", pid: transition === "replacement" ? 8001 : 8000 };
      }
      release.resolve();
      const result = await verification;
      expect(result.ok).toBe(unchanged);
      if (unchanged) {
        expect(onVerified).toHaveBeenCalledOnce();
        expect(recordUpdateRunVerification).toHaveBeenLastCalledWith(
          "synthetic-update",
          expect.objectContaining({
            ...(pidless ? {} : { pid: 8000 }),
            settled: true,
            readyz: true,
          }),
          expect.anything(),
        );
      } else {
        expect(onVerified).not.toHaveBeenCalled();
        expect(recordUpdateRunVerification).not.toHaveBeenCalledWith(
          "synthetic-update",
          expect.objectContaining({ settled: true, readyz: true }),
          expect.anything(),
        );
      }
    },
  );
});
