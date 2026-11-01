import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import nodePath from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  prepareGatewaySuspend,
  resumeGatewaySuspend,
} from "../infra/gateway-suspend-coordinator.js";
import { isGatewayDraining } from "../process/command-queue.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  createAgentDatabaseInspectionRefusal,
  type AgentDatabaseAdmissionRefusal,
} from "../state/agent-database-admission.js";
import { resolveRuntimeServiceBuildId, resolveRuntimeServiceVersion } from "../version.js";
import {
  AUTH_TOKEN,
  AUTH_NONE,
  createRequest,
  createResponse,
  dispatchRequest,
  sendRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";
import { createReadinessChecker, createStartupChecker } from "./server/readiness.js";
import { withTempConfig } from "./test-temp-config.js";

type ServerFixture = Parameters<typeof withGatewayServer>[0];
type ProbeRequest = string | Parameters<typeof sendRequest>[1];
function probeClient(server: Parameters<typeof sendRequest>[0]) {
  const request = (input: ProbeRequest) =>
    sendRequest(server, typeof input === "string" ? { path: input } : input);
  return {
    server,
    request,
    async json(input: ProbeRequest, status: number, body: object, exact = false) {
      const response = await request(input);
      expect(response.res.statusCode).toBe(status);
      const assertion = expect(JSON.parse(response.getBody()));
      if (exact) {
        assertion.toEqual(body);
      } else {
        assertion.toMatchObject(body);
      }
    },
    async text(input: ProbeRequest, status: number, body: string) {
      const response = await request(input);
      expect([response.res.statusCode, response.getBody()]).toEqual([status, body]);
    },
    async getAndHead(input: ProbeRequest, status: number, body: object) {
      const json = JSON.stringify(body);
      for (const method of ["GET", "HEAD"]) {
        const response = await request({
          ...(typeof input === "string" ? { path: input } : input),
          method,
        });
        expect([response.res.statusCode, response.getBody()]).toEqual([
          status,
          method === "HEAD" ? "" : json,
        ]);
        expect(response.setHeader).toHaveBeenCalledWith(
          "Content-Length",
          String(Buffer.byteLength(json)),
        );
      }
    },
  };
}
function withProbeServer(
  overrides: ServerFixture["overrides"],
  run: (probe: ReturnType<typeof probeClient>) => Promise<void>,
  resolvedAuth = AUTH_NONE,
) {
  return withGatewayServer({
    prefix: "http-probe",
    resolvedAuth,
    overrides,
    run: (server) => run(probeClient(server)),
  });
}

const remote = (path: string, authorization?: string) => ({
  path,
  remoteAddress: "10.0.0.8",
  host: "gateway.test",
  authorization,
});
const readyState = (failing: string[], coreReady = true) => ({
  ready: failing.length === 0,
  coreReady,
  failing,
});
const unready = {
  ready: false,
  coreReady: true,
  failing: ["discord", "telegram"],
  uptimeMs: 8_000,
};
const startupDetails = (status: "starting" | "started" | "draining", pendingReason?: string) => ({
  ok: status === "started",
  status,
  version: resolveRuntimeServiceVersion(process.env),
  buildId: resolveRuntimeServiceBuildId(),
  uptimeMs: expect.any(Number),
  ...(pendingReason ? { pendingReason } : {}),
});

const idleInspectors = {
  getQueueSize: () => 0,
  getPendingReplies: () => 0,
  getEmbeddedRuns: () => 0,
  getCronRuns: () => 0,
  getAgentRuns: () => 0,
  getAcpRuns: () => 0,
  getMediaRuns: () => 0,
  getSessionAdmissions: () => 0,
  getSessionMutations: () => 0,
  getChatRuns: () => 0,
  getQueuedTurns: () => 0,
  getTerminalPersistence: () => 0,
  getTerminalSessions: () => 0,
};

async function withControlUi(
  overrides: ServerFixture["overrides"],
  run: (probe: ReturnType<typeof probeClient>) => Promise<void>,
) {
  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "openclaw-http-routing-"));
  try {
    await fs.writeFile(nodePath.join(root, "index.html"), "<html>spa fallback</html>\n");
    await withProbeServer(
      {
        controlUiEnabled: true,
        controlUiBasePath: "",
        controlUiRoot: { kind: "resolved", path: root },
        ...overrides,
      },
      run,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

it("uses Accept to route only the unclaimed Control UI SPA fallback", async () => {
  let sidecarsReady = false;
  await withControlUi(
    {
      handlePluginRequest: async () => false,
      shouldEnforcePluginGatewayAuth: () => false,
      isStartupPluginRuntimeReady: () => sidecarsReady,
    },
    async (probe) => {
      // Negotiation variants belong to control-ui-routing.test.ts; retain both
      // dispatch branches here, before and after plugin startup.
      for (const ready of [false, true]) {
        sidecarsReady = ready;
        for (const [accept, html] of [
          ["text/html", true],
          ["application/json", false],
        ] as const) {
          const { res, getBody, setHeader } = await probe.request({
            path: "/unclaimed-spa-route",
            method: "GET",
            headers: { accept },
          });
          const label = `${accept} ready=${ready}`;
          expect(res.statusCode, label).toBe(html ? 200 : ready ? 404 : 503);
          if (html) {
            expect(getBody(), label).toContain("spa fallback");
          } else {
            expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
            expect(getBody()).toBe(ready ? "Not Found" : "Plugin runtime is starting");
            if (ready) {
              expect(setHeader).not.toHaveBeenCalledWith("Retry-After", "1");
            } else {
              expect(setHeader).toHaveBeenCalledWith("Retry-After", "1");
            }
          }
        }
      }
    },
  );
});

it.each([
  ["disabled shell", false, "/__openclaw__/mcp-app"],
  ["disabled view", false, "/__openclaw__/mcp-app/view"],
  ["enabled malformed child", true, "/__openclaw__/mcp-app/other"],
] as const)("returns 404 for the %s instead of Control UI HTML", async (_name, enabled, path) => {
  await withControlUi(
    {
      getRuntimeConfig: () => ({ gateway: { trustedProxies: [] }, mcp: { apps: { enabled } } }),
    },
    (probe) => probe.text(path, 404, "Not Found"),
  );
});

describe("gateway probe endpoints", () => {
  it("returns 404 for probe namespace variants instead of false-green Control UI HTML", async () => {
    await withControlUi(
      {
        getReadiness: () => ({
          ready: false,
          coreReady: false,
          failing: ["gateway-draining"],
          uptimeMs: 1_000,
        }),
      },
      async (probe) => {
        await probe.json("/readyz", 503, { ready: false });
        for (const path of [
          "/health/",
          "/healthz/details",
          "/ready/",
          "/readyz/details",
          "/startup/",
          "/startupz/details",
        ]) {
          await probe.text(path, 404, "Not Found");
        }
      },
    );
  });

  it("keeps liveness green while a prepared suspension lease makes readiness red", async () => {
    resetGatewayWorkAdmission();
    const channelManager = {
      getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
      getAutostartSuppression: () => null,
      isAmbientAutostartSuppressed: () => false,
    };
    const getReadiness = createReadinessChecker({
      channelManager,
      startedAt: Date.now(),
      getGatewayDraining: isGatewayDraining,
    });
    try {
      await withProbeServer({ getReadiness, openAiChatCompletionsEnabled: true }, async (probe) => {
        const prepared = prepareGatewaySuspend({
          requestId: "request-readiness-probe",
          pauseScheduling: vi.fn(),
          resumeScheduling: vi.fn(),
          createSuspensionId: () => "suspension-readiness-probe",
          inspect: { ...idleInspectors, getRootRequests: () => 0 },
        });
        if (prepared.status !== "ready") {
          throw new Error(`expected prepared suspension, received ${prepared.status}`);
        }

        await probe.json("/healthz", 200, { ok: true, status: "live" }, true);

        await probe.json("/readyz", 503, readyState(["gateway-draining"], false));

        for (const [path, method] of [
          ["/v1/chat/completions", "POST"],
          ["/__openclaw__/board/agent%3Amain%3Amain/status/index.html?bt=garbage", "GET"],
        ] as const) {
          await probe.json({ path, method }, 503, { error: { code: "gateway_unavailable" } });
        }

        expect(resumeGatewaySuspend(prepared.suspensionId)).toEqual({
          ok: true,
          status: "running",
          resumed: true,
        });

        await probe.json("/readyz", 200, readyState([]));
      });
    } finally {
      resetGatewayWorkAdmission();
    }
  });

  it("keeps in-flight core HTTP work visible to suspension preparation", async () => {
    resetGatewayWorkAdmission();
    const watchStarted = createDeferred();
    const heldWatch = createDeferred();
    const handleWatchNodeRequest = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      watchStarted.resolve();
      await heldWatch.promise;
      res.statusCode = 200;
      res.end("ok");
      return true;
    });
    try {
      await withProbeServer({ handleWatchNodeRequest }, async (probe) => {
        const request = createRequest({ path: "/api/nodes/watch/node-1" });
        const response = createResponse();
        const pendingRequest = dispatchRequest(probe.server, request, response.res);
        await watchStarted.promise;
        expect(getActiveGatewayRootWorkCount()).toBe(1);

        const prepared = prepareGatewaySuspend({
          requestId: "request-http-work",
          pauseScheduling: vi.fn(),
          resumeScheduling: vi.fn(),
          inspect: idleInspectors,
        });
        expect(prepared).toMatchObject({
          status: "busy",
          reason: "active-work",
          activeCount: 1,
        });

        heldWatch.resolve();
        await pendingRequest;
        expect(response.res.statusCode).toBe(200);
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      });
    } finally {
      heldWatch.resolve();
      resetGatewayWorkAdmission();
    }
  });

  it("serves bounded probes from headerless trusted proxies while protecting other routes", async () => {
    const cfg = { gateway: { trustedProxies: ["10.0.0.0/24"] } };
    let healthy = true;
    await withProbeServer(
      {
        getRuntimeConfig: () => cfg,
        getReadiness: () => ({ ...unready, ready: healthy }),
        getStartup: () =>
          healthy
            ? { ok: true, status: "started", uptimeMs: 8_000 }
            : {
                ok: false,
                status: "starting",
                uptimeMs: 8_000,
                pendingReason: "private-startup-detail",
              },
      },
      async (probe) => {
        for (const ready of [true, false]) {
          healthy = ready;
          for (const path of ["/ready", "/readyz", "/startup", "/startupz"]) {
            const body = path.startsWith("/ready")
              ? { ready }
              : { ok: ready, status: ready ? "started" : "starting" };
            await probe.getAndHead(remote(path), ready ? 200 : 503, body);
          }
        }
        const protectedResponse = await probe.request(remote("/tools/invoke"));
        expect(protectedResponse.res.statusCode).toBe(403);
        expect(protectedResponse.getBody()).toContain("proxy_attribution_required");
      },
      AUTH_TOKEN,
    );
  });

  it("rejects untrusted proxy ingress before probes, hooks, and watch-node handlers", async () => {
    const handleHooksRequest = vi.fn(async () => true);
    const handleWatchNodeRequest = vi.fn(async () => true);
    await withProbeServer(
      { handleHooksRequest, handleWatchNodeRequest },
      async (probe) => {
        for (const path of ["/readyz", "/startupz", "/hooks/test", "/api/nodes/watch/node-1"]) {
          const { res, getBody } = await probe.request({
            path,
            remoteAddress: "127.0.0.1",
            headers: { "x-forwarded-for": "203.0.113.10" },
          });
          expect(res.statusCode, path).toBe(403);
          expect(getBody(), path).toContain("proxy_attribution_required");
        }
      },
      AUTH_TOKEN,
    );
    expect(handleHooksRequest).not.toHaveBeenCalled();
    expect(handleWatchNodeRequest).not.toHaveBeenCalled();
  });

  it("re-resolves auth for remote /ready requests after shared auth rotation", async () => {
    let currentAuth = AUTH_TOKEN;
    await withProbeServer(
      {
        getReadiness: () => unready,
        getResolvedAuth: () => currentAuth,
      },
      async (probe) => {
        await probe.json(remote("/ready", "Bearer test-token"), 503, unready, true);
        currentAuth = { ...AUTH_TOKEN, token: "rotated-token" };
        await probe.json(remote("/ready", "Bearer test-token"), 503, { ready: false }, true);
        await probe.json(remote("/ready", "Bearer rotated-token"), 503, unready, true);
      },
      AUTH_TOKEN,
    );
  });

  it("hides readiness details when trusted-proxy auth violates browser origin policy", async () => {
    const cfg = {
      gateway: {
        trustedProxies: ["10.0.0.1"],
        controlUi: { allowedOrigins: ["https://control.example"] },
      },
    };
    await withTempConfig({
      prefix: "probe-remote-origin-rejected",
      cfg,
      run: () =>
        withProbeServer(
          {
            getReadiness: () => unready,
            getRuntimeConfig: () => cfg,
          },
          (probe) =>
            probe.json(
              {
                path: "/ready",
                remoteAddress: "10.0.0.1",
                host: "gateway.test",
                headers: {
                  origin: "https://evil.example",
                  forwarded: "for=203.0.113.10;proto=https;host=gateway.test",
                  "x-forwarded-for": "203.0.113.10",
                  "x-forwarded-user": "user@example.com",
                  "x-forwarded-proto": "https",
                },
              },
              503,
              { ready: false },
              true,
            ),
          {
            mode: "trusted-proxy",
            allowTailscale: false,
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
        ),
    });
  });

  it("returns typed internal error payload when readiness evaluation throws", async () => {
    await withProbeServer(
      {
        getReadiness: () => {
          throw new Error("boom");
        },
      },
      (probe) =>
        probe.json(
          "/ready",
          503,
          { ready: false, coreReady: false, failing: ["internal"], uptimeMs: 0 },
          true,
        ),
    );
  });

  it("reports startup lifecycle independently of hard channel failures", async () => {
    let startupPending = true;
    let gatewayDraining = false;
    let channelFailed = false;
    const pending = createAgentDatabaseInspectionRefusal({
      agentId: "optional-worker",
      paths: ["/isolated/optional-worker.sqlite"],
      reason: "Inspection continues in the background.",
      pending: true,
    });
    let refusals: AgentDatabaseAdmissionRefusal[] = [pending];
    const startedAt = Date.now() - 5_000;
    const startupDeps = {
      startedAt,
      getStartupPending: () => startupPending,
      getStartupPendingReason: () => "plugin-convergence",
      getGatewayDraining: () => gatewayDraining,
    };
    const getStartup = createStartupChecker(startupDeps, () => refusals);
    // Channel-health policy is covered by server/readiness.test.ts; here the
    // contract is that HTTP startup uses its own lifecycle, not readiness.
    const getReadiness = () => ({ ...unready, ...readyState(channelFailed ? ["whatsapp"] : []) });
    await withProbeServer({ getReadiness, getStartup }, async (probe) => {
      await probe.json("/startupz", 503, startupDetails("starting", "plugin-convergence"));

      gatewayDraining = true;
      await probe.json("/startupz", 503, startupDetails("draining"));

      gatewayDraining = false;

      startupPending = false;
      await probe.json("/startupz", 503, {
        ok: false,
        status: "starting",
        pendingReason: "agent-database-inspection",
      });
      await probe.json("/readyz", 200, { ready: true });
      await probe.json("/healthz", 200, { ok: true });

      refusals = [createAgentDatabaseInspectionRefusal({ ...pending, pending: false })];
      await probe.json("/startupz", 200, startupDetails("started"));

      refusals = [];
      channelFailed = true;
      await probe.json("/readyz", 503, readyState(["whatsapp"]));

      await probe.json("/startupz", 200, { ok: true, status: "started" });

      gatewayDraining = true;
      await probe.json("/startupz", 503, startupDetails("draining"));
    });
  });

  it("gates startup details to local or authenticated callers", async () => {
    const getStartup = createStartupChecker({
      startedAt: Date.now() - 8_000,
      getStartupPending: () => true,
      getStartupPendingReason: () => "startup-sidecars",
      getGatewayDraining: () => false,
    });
    await withProbeServer(
      { getStartup },
      async (probe) => {
        await probe.json(remote("/startupz"), 503, { ok: false, status: "starting" }, true);
        await probe.json(
          remote("/startupz", "Bearer test-token"),
          503,
          startupDetails("starting", "startup-sidecars"),
        );
      },
      AUTH_TOKEN,
    );
  });

  it("serves liveness probes before loading gateway config or resolving auth", async () => {
    const getRuntimeConfig = vi.fn(() => {
      throw new Error("config load blocked");
    });
    const getResolvedAuth = vi.fn(() => {
      getRuntimeConfig();
      return AUTH_NONE;
    });
    await withProbeServer({ getRuntimeConfig, getResolvedAuth }, async (probe) => {
      for (const path of ["/health", "/healthz"]) {
        await probe.getAndHead(path, 200, { ok: true, status: "live" });
      }
      expect(getRuntimeConfig).not.toHaveBeenCalled();
      expect(getResolvedAuth).not.toHaveBeenCalled();
    });
  });

  it("serves unauthenticated probes before stalled stages, Control UI, and catch-all plugins", async () => {
    const handleHooksRequest = vi.fn((): Promise<boolean> => new Promise(() => {}));
    const handlePluginRequest = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.end("plugin-owned");
      return true;
    });
    const shouldEnforcePluginGatewayAuth = vi.fn(() => true);
    const getReadiness = vi.fn(() => ({
      ready: true,
      coreReady: true,
      failing: [],
      uptimeMs: 123,
    }));
    await withProbeServer(
      {
        getReadiness,
        handleHooksRequest,
        controlUiEnabled: true,
        controlUiBasePath: "",
        controlUiRoot: { kind: "missing" },
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth,
      },
      async (probe) => {
        for (const [path, body, exact] of [
          ["/health", { ok: true, status: "live" }, true],
          ["/ready", { ready: true, coreReady: true, failing: [], uptimeMs: 123 }, true],
          [
            "/startup",
            {
              ok: true,
              status: "started",
              version: expect.any(String),
              uptimeMs: expect.any(Number),
            },
            false,
          ],
        ] as const) {
          for (const suffix of ["", "z"]) {
            await probe.json(path + suffix, 200, body, exact);
          }
        }
        expect(handleHooksRequest).not.toHaveBeenCalled();
        expect(handlePluginRequest).not.toHaveBeenCalled();
        expect(shouldEnforcePluginGatewayAuth).not.toHaveBeenCalled();
      },
      AUTH_TOKEN,
    );
  });
});
