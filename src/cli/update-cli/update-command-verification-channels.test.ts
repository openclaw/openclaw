import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gatewayService from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
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
import { verifyUpdatedGateway } from "./update-command-verification.js";

let server: Server;
async function listen() {
  server = createServer((_req, res) => res.writeHead(200).end());
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
