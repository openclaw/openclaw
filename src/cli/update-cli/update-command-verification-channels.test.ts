import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gatewayService from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-swap-contract.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
} from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import {
  callGateway,
  inspectPortUsage,
  makeGatewayService,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
} from "../daemon-cli/restart-health.test-helpers.js";
import { recordUpdatePackageCompletion } from "./update-command-terminal.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

let server: Server;
async function listen(readiness?: { ready: false; coreReady?: boolean; failing: string[] }) {
  server = createServer((req, res) =>
    res
      .writeHead(req.url === "/readyz" && readiness ? 503 : 200)
      .end(readiness ? JSON.stringify(readiness) : undefined),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing loopback listener");
  }
  return address.port;
}
beforeEach(() => {
  resetRestartHealthMocks();
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});
afterEach(async () => {
  restoreRestartHealthMocks();
  server?.closeAllConnections();
  if (server?.listening) {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
});

describe("update repair channel warnings", () => {
  it.each(["channel probe", "plugin load"] as const)(
    "completes verified activation with a named warning (%s)",
    async (fault) => {
      const service = makeGatewayService({ status: "running", pid: 8000 });
      service.isLoaded = vi.fn(async () => true);
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: "busy",
        listeners: [{ pid: 8000 }],
        hints: [],
      }));
      callGateway.mockImplementation(
        gatewayHealthResponse({
          server: { version: "2026.10.3", buildId: "candidate", bootId: "candidate-boot" },
          health: {
            channels:
              fault === "channel probe"
                ? { whatsapp: { probe: { ok: false, error: "re-pair required" } } }
                : {},
            ...(fault === "plugin load"
              ? {
                  plugins: {
                    errors: [{ id: "whatsapp", activated: true, error: "dependency missing" }],
                  },
                }
              : {}),
          },
        }),
      );
      const result: UpdateRunResult = {
        status: "ok",
        mode: "npm",
        after: { version: "2026.10.3", buildId: "candidate" },
        steps: [],
        durationMs: 0,
      };
      const onVerified = vi.fn();
      const validation = await verifyUpdatedGateway({
        result,
        opts: { json: true },
        serviceEnv: { HOME: "/synthetic-home" },
        gatewayPort: await listen(),
        expectedVersion: "2026.10.3",
        expectedBuildId: "candidate",
        requireRunningService: true,
        settle: { probes: 2 },
        onVerified,
      });
      expect(validation).toMatchObject({ ok: true, score: 7 });
      if (fault === "plugin load") {
        expect(validation.summary).toBe(
          "Gateway service, version, channels, and readiness verified; plugin failures need a retry.",
        );
        expect(validation.pluginWarnings).toEqual([
          expect.objectContaining({
            pluginId: "whatsapp",
            reason: "dependency missing",
            message:
              'Plugin "whatsapp" could not be loaded. Run `openclaw doctor --fix` to check and repair the load problem.',
            guidance: ["openclaw doctor --fix"],
          }),
        ]);
      } else {
        expect(validation.summary).toContain("channel warnings need attention");
        expect(validation.pluginWarnings).toBeUndefined();
      }
      expect(onVerified).toHaveBeenCalledOnce();
      expect(result.steps[0]).toMatchObject({ exitCode: 0 });
      expect(result.steps[0]?.failureFacts).toBeUndefined();
      const complete = vi.fn<PackageUpdateTransaction["complete"]>(async () => undefined);
      await expect(
        recordUpdatePackageCompletion(
          {
            root: "/synthetic-package",
            opts: { json: true },
            packageTransaction: {
              backupRoot: "/synthetic-backup",
              complete,
              rollback: vi.fn(),
            },
          },
          result,
          () => {},
        ),
      ).resolves.toBeUndefined();
      expect(complete).toHaveBeenCalledExactlyOnceWith(
        { activationVerified: true },
        expect.any(Function),
      );
      const report = renderUpdateRunReport(updateRunReportInputFromResult(result)).markdown;
      if (fault === "channel probe") {
        expect(report).toContain("whatsapp: re-pair required");
        expect(report).toContain("openclaw channels status --probe");
        expect(report).toContain("openclaw health --json");
      }
      expect(report).not.toContain("restart remains unsafe");
    },
  );

  it.each([true, false, undefined])(
    "completes an update during a channel outage only with core readiness (%s)",
    async (coreReady) => {
      const service = makeGatewayService({ status: "running", pid: 8000 });
      service.isLoaded = vi.fn(async () => true);
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: "busy",
        listeners: [{ pid: 8000 }],
        hints: [],
      }));
      callGateway.mockImplementation(
        gatewayHealthResponse({
          server: { version: "2026.10.3", buildId: "candidate", bootId: "candidate-boot" },
          health: { channels: { telegram: { configured: true, running: false } } },
        }),
      );
      const result: UpdateRunResult = {
        status: "ok",
        mode: "npm",
        after: { version: "2026.10.3", buildId: "candidate" },
        steps: [],
        durationMs: 0,
      };
      const validation = await verifyUpdatedGateway({
        result,
        opts: { json: true },
        serviceEnv: { HOME: "/synthetic-home" },
        gatewayPort: await listen({ ready: false, coreReady, failing: ["telegram"] }),
        expectedVersion: "2026.10.3",
        expectedBuildId: "candidate",
        purpose: "recovery",
        waitForStartup: false,
      });
      expect(validation.ok).toBe(coreReady === true);
      expect(result.verification).toMatchObject({ readyz: false, channelsReady: false });
      if (coreReady === true) {
        expect(result.steps[0]).toMatchObject({ exitCode: 0 });
        expect(renderUpdateRunReport(updateRunReportInputFromResult(result)).markdown).toContain(
          "telegram",
        );
        expect(result.verification).toMatchObject({ coreReady: true, settled: true });
      }
    },
  );

  it.each([false, true])("warns about stopped channels after repair (json=%s)", async (json) => {
    const service = makeGatewayService({ status: "stopped" });
    vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
    inspectPortUsage.mockImplementation(async (port) => ({
      port,
      status: "busy",
      listeners: [{ pid: 8000 }],
      hints: [],
    }));
    callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "2026.9.8", buildId: "candidate", bootId: "candidate-boot" },
        health: {
          channels: {
            telegram: {
              configured: true,
              running: true,
              probe: { ok: true },
              accounts: {
                default: { configured: true, running: true },
                suppressed: {
                  configured: true,
                  running: false,
                  lastError: "restart-loop breaker tripped",
                },
                stopped: { configured: true, running: false },
                disabled: { enabled: false, configured: true, running: false },
                unconfigured: { configured: false, running: false },
              },
            },
            discord: { configured: true, running: false },
          },
        },
      }),
    );
    const result: UpdateRunResult = { status: "error", mode: "npm", steps: [], durationMs: 0 };
    const validation = await verifyUpdatedGateway({
      result,
      opts: { json },
      purpose: "recovery",
      serviceEnv: { HOME: "/synthetic-home" },
      gatewayPort: await listen(),
      expectedVersion: "2026.9.8",
      expectedBuildId: "candidate",
      waitForStartup: false,
    });
    expect(validation.ok).toBe(true);
    expect(result.steps[0]).toMatchObject({ exitCode: 0 });
    const report = renderUpdateRunReport(updateRunReportInputFromResult(result)).markdown;
    for (const id of ["telegram/suppressed", "telegram/stopped", "discord"]) {
      expect(report).toContain(id);
    }
    expect(report).toContain("restart-loop breaker tripped");
    expect(report).not.toContain("telegram/disabled");
    expect(report).not.toContain("telegram/unconfigured");
    expect(validation.summary).toContain("channel warnings");
    if (json) {
      expect(defaultRuntime.log).not.toHaveBeenCalled();
    } else {
      expect(vi.mocked(defaultRuntime.log).mock.calls.flat().join("\n")).toContain(
        "Channel health warning (telegram/suppressed: restart-loop breaker tripped)",
      );
    }
  });
});
