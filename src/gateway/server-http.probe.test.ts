import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import nodePath from "node:path";
import { describe, expect, it, vi } from "vitest";
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
import { resolveRuntimeServiceVersion } from "../version.js";
import type { ChannelManager } from "./server-channels.js";
import {
  AUTH_TOKEN,
  AUTH_NONE,
  createRequest,
  createResponse,
  dispatchRequest,
  sendRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";
import {
  createReadinessChecker,
  createStartupChecker,
  type ReadinessChecker,
} from "./server/readiness.js";
import { withTempConfig } from "./test-temp-config.js";

type ServerFixture = Parameters<typeof withGatewayServer>[0];
function withProbeServer(
  overrides: ServerFixture["overrides"],
  run: ServerFixture["run"],
  resolvedAuth = AUTH_NONE,
) {
  return withGatewayServer({ prefix: "http-probe", resolvedAuth, overrides, run });
}

async function expectProbe(
  server: Parameters<typeof sendRequest>[0],
  request: string | Parameters<typeof sendRequest>[1],
  status: number,
  body: unknown,
  exact = false,
) {
  const response = await sendRequest(
    server,
    typeof request === "string" ? { path: request } : request,
  );
  expect(response.res.statusCode).toBe(status);
  if (exact) {
    expect(JSON.parse(response.getBody())).toEqual(body);
  } else {
    expect(JSON.parse(response.getBody())).toMatchObject(body);
  }
}

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

async function withMarkedControlUiRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "openclaw-http-routing-"));
  try {
    await fs.writeFile(nodePath.join(root, "index.html"), "<html>spa fallback</html>\n");
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("startup plugin HTTP routing", () => {
  it("uses Accept to route only the unclaimed Control UI SPA fallback", async () => {
    await withMarkedControlUiRoot(async (controlUiRoot) => {
      let sidecarsReady = false;
      await withProbeServer(
        {
          controlUiEnabled: true,
          controlUiBasePath: "",
          controlUiRoot: { kind: "resolved", path: controlUiRoot },
          handlePluginRequest: async () => false,
          shouldEnforcePluginGatewayAuth: () => false,
          isStartupPluginRuntimeReady: () => sidecarsReady,
        },
        async (server) => {
          const htmlCases = [
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "*/*",
            undefined,
            "",
            "text/html;q=0.5",
            "text/*",
            "application/xhtml+xml;q=0, text/*",
            "application/xhtml+xml",
            "text/html;profile=alternate;q=0, */*;q=1",
            "text/html;charset=utf-16;q=0, text/html;q=1",
            'text/html;note="x; q=0; y", */*',
          ];
          const nonHtmlCases = [
            "application/json",
            "text/event-stream",
            "text/html;q=0",
            "text/html;q=0, */*",
            "text/html;q=0, text/*",
            "text/html;profile=alternate;q=1, */*;q=0",
            "text/html;charset=utf-8;q=0, text/html;q=1",
            "text/html;q=0, text/*;charset=utf-8;q=1",
            "*/*;q=0",
            "text/html;Q=0",
            "text/*;q=0",
          ];
          for (const ready of [false, true]) {
            sidecarsReady = ready;
            for (const accept of htmlCases) {
              const { res, getBody } = await sendRequest(server, {
                path: "/unclaimed-spa-route",
                method: "GET",
                headers: accept === undefined ? undefined : { accept },
              });

              expect(res.statusCode, `${accept} ready=${ready}`).toBe(200);
              expect(getBody(), `${accept} ready=${ready}`).toContain("spa fallback");
            }

            for (const accept of nonHtmlCases) {
              const response = createResponse();
              await dispatchRequest(
                server,
                createRequest({
                  path: "/unclaimed-spa-route",
                  method: "GET",
                  headers: { accept },
                }),
                response.res,
              );

              expect(response.res.statusCode, `${accept} ready=${ready}`).toBe(ready ? 404 : 503);
              expect(response.setHeader).toHaveBeenCalledWith(
                "Content-Type",
                "text/plain; charset=utf-8",
              );
              expect(response.getBody()).toBe(ready ? "Not Found" : "Plugin runtime is starting");
              if (ready) {
                expect(response.setHeader).not.toHaveBeenCalledWith("Retry-After", "1");
              } else {
                expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "1");
              }
            }
          }
        },
      );
    });
  });
});

describe("standalone MCP App HTTP routing", () => {
  it.each([
    {
      name: "disabled shell",
      enabled: false,
      requestPath: "/__openclaw__/mcp-app",
    },
    {
      name: "disabled view",
      enabled: false,
      requestPath: "/__openclaw__/mcp-app/view",
    },
    {
      name: "enabled malformed child",
      enabled: true,
      requestPath: "/__openclaw__/mcp-app/other",
    },
  ])("returns 404 for the $name instead of Control UI HTML", async ({ enabled, requestPath }) => {
    await withMarkedControlUiRoot(async (controlUiRoot) => {
      await withProbeServer(
        {
          controlUiEnabled: true,
          controlUiBasePath: "",
          controlUiRoot: { kind: "resolved", path: controlUiRoot },
          getRuntimeConfig: () => ({
            gateway: { trustedProxies: [] },
            mcp: { apps: { enabled } },
          }),
        },
        async (server) => {
          const { res, getBody } = await sendRequest(server, {
            path: requestPath,
            method: "GET",
          });

          expect(res.statusCode).toBe(404);
          expect(getBody()).toBe("Not Found");
        },
      );
    });
  });
});

describe("gateway probe endpoints", () => {
  it("returns 404 for probe namespace variants instead of false-green Control UI HTML", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["gateway-draining"],
      uptimeMs: 1_000,
    });
    await withMarkedControlUiRoot(async (controlUiRoot) => {
      await withProbeServer(
        {
          controlUiEnabled: true,
          controlUiBasePath: "",
          controlUiRoot: { kind: "resolved", path: controlUiRoot },
          getReadiness,
        },
        async (server) => {
          await expectProbe(server, "/readyz", 503, { ready: false });

          for (const routePath of [
            "/health/",
            "/healthz/details",
            "/ready/",
            "/readyz/details",
            "/startup/",
            "/startupz/details",
          ]) {
            const { res, getBody } = await sendRequest(server, { path: routePath });
            expect(res.statusCode, routePath).toBe(404);
            expect(getBody(), routePath).toBe("Not Found");
          }
        },
      );
    });
  });

  it("keeps liveness green while a prepared suspension lease makes readiness red", async () => {
    resetGatewayWorkAdmission();
    const channelManager = {
      getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
      getAutostartSuppression: () => null,
    } as unknown as ChannelManager;
    const getReadiness = createReadinessChecker({
      channelManager,
      startedAt: Date.now(),
      getGatewayDraining: isGatewayDraining,
      cacheTtlMs: 0,
    });
    try {
      await withProbeServer(
        { getReadiness, openAiChatCompletionsEnabled: true },
        async (server) => {
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

          await expectProbe(server, "/healthz", 200, { ok: true, status: "live" }, true);

          await expectProbe(server, "/readyz", 503, {
            ready: false,
            failing: ["gateway-draining"],
          });

          await expectProbe(
            server,
            {
              path: "/v1/chat/completions",
              method: "POST",
            },
            503,
            {
              error: { code: "gateway_unavailable" },
            },
          );

          await expectProbe(
            server,
            "/__openclaw__/board/agent%3Amain%3Amain/status/index.html?bt=garbage",
            503,
            {
              error: { code: "gateway_unavailable" },
            },
          );

          expect(resumeGatewaySuspend(prepared.suspensionId)).toEqual({
            ok: true,
            status: "running",
            resumed: true,
          });

          await expectProbe(server, "/readyz", 200, {
            ready: true,
            failing: [],
          });
        },
      );
    } finally {
      resetGatewayWorkAdmission();
    }
  });

  it("keeps in-flight core HTTP work visible to suspension preparation", async () => {
    resetGatewayWorkAdmission();
    let releaseWatch = () => {};
    let markWatchStarted = () => {};
    const watchStarted = new Promise<void>((resolve) => {
      markWatchStarted = resolve;
    });
    const heldWatch = new Promise<void>((resolve) => {
      releaseWatch = resolve;
    });
    const handleWatchNodeRequest = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      markWatchStarted();
      await heldWatch;
      res.statusCode = 200;
      res.end("ok");
      return true;
    });
    try {
      await withProbeServer({ handleWatchNodeRequest }, async (server) => {
        const request = createRequest({ path: "/api/nodes/watch/node-1" });
        const response = createResponse();
        const pendingRequest = dispatchRequest(server, request, response.res);
        await watchStarted;
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

        releaseWatch();
        await pendingRequest;
        expect(response.res.statusCode).toBe(200);
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      });
    } finally {
      releaseWatch();
      resetGatewayWorkAdmission();
    }
  });

  it("rejects unattributable proxy ingress before hooks and watch-node handlers", async () => {
    const handleHooksRequest = vi.fn(async () => true);
    const handleWatchNodeRequest = vi.fn(async () => true);
    await withProbeServer(
      { handleHooksRequest, handleWatchNodeRequest },
      async (server) => {
        for (const path of ["/hooks/test", "/api/nodes/watch/node-1"]) {
          const { res, getBody } = await sendRequest(server, {
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
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });
    let currentAuth = AUTH_TOKEN;
    await withProbeServer(
      {
        getReadiness,
        getResolvedAuth: () => currentAuth,
      },
      async (server) => {
        const sendReady = async (authorization: string) => {
          const { res, getBody } = await sendRequest(server, {
            path: "/ready",
            remoteAddress: "10.0.0.8",
            host: "gateway.test",
            authorization,
          });
          return { statusCode: res.statusCode, body: JSON.parse(getBody()) };
        };

        await expect(sendReady("Bearer test-token")).resolves.toEqual({
          statusCode: 503,
          body: {
            ready: false,
            failing: ["discord", "telegram"],
            uptimeMs: 8_000,
          },
        });

        currentAuth = {
          ...AUTH_TOKEN,
          token: "rotated-token",
        };

        await expect(sendReady("Bearer test-token")).resolves.toEqual({
          statusCode: 503,
          body: { ready: false },
        });
        await expect(sendReady("Bearer rotated-token")).resolves.toEqual({
          statusCode: 503,
          body: {
            ready: false,
            failing: ["discord", "telegram"],
            uptimeMs: 8_000,
          },
        });
      },
      AUTH_TOKEN,
    );
  });

  it("hides readiness details when trusted-proxy auth violates browser origin policy", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });
    await withTempConfig({
      prefix: "probe-remote-origin-rejected",
      cfg: {
        gateway: {
          trustedProxies: ["10.0.0.1"],
          controlUi: {
            allowedOrigins: ["https://control.example"],
          },
        },
      },
      run: async () => {
        await withGatewayServer({
          prefix: "probe-remote-origin-rejected-server",
          resolvedAuth: {
            mode: "trusted-proxy",
            allowTailscale: false,
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
          overrides: {
            getReadiness,
            getRuntimeConfig: () => ({
              gateway: {
                trustedProxies: ["10.0.0.1"],
                controlUi: { allowedOrigins: ["https://control.example"] },
              },
            }),
          },
          run: async (server) => {
            const { res, getBody } = await sendRequest(server, {
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
            });

            expect(res.statusCode).toBe(503);
            expect(JSON.parse(getBody())).toEqual({ ready: false });
          },
        });
      },
    });
  });

  it("returns typed internal error payload when readiness evaluation throws", async () => {
    const getReadiness: ReadinessChecker = () => {
      throw new Error("boom");
    };
    await withProbeServer({ getReadiness }, async (server) => {
      const { res, getBody } = await sendRequest(server, { path: "/ready" });

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(getBody())).toEqual({ ready: false, failing: ["internal"], uptimeMs: 0 });
    });
  });

  it("reports startup lifecycle independently of hard channel failures", async () => {
    let startupPending = true;
    let gatewayDraining = false;
    const pending = createAgentDatabaseInspectionRefusal({
      agentId: "optional-worker",
      paths: ["/isolated/optional-worker.sqlite"],
      reason: "Inspection continues in the background.",
      pending: true,
    });
    let refusals: AgentDatabaseAdmissionRefusal[] = [pending];
    const startedAt = Date.now() - 5_000;
    const account = {
      accountId: "default",
      running: true,
      connected: true,
      enabled: true,
      configured: true,
      lifecycle: "ready" as "ready" | "blocked",
      linked: true,
      terminalDisconnect: false,
      lastStartAt: startedAt,
    };
    const channelManager = {
      getRuntimeSnapshot: () => ({
        channels: { whatsapp: account },
        channelAccounts: { whatsapp: { default: account } },
      }),
      getAutostartSuppression: () => null,
      isAmbientAutostartSuppressed: () => false,
    } as unknown as ChannelManager;
    const startupDeps = {
      startedAt,
      getStartupPending: () => startupPending,
      getStartupPendingReason: () => "plugin-convergence",
      getGatewayDraining: () => gatewayDraining,
    };
    const getStartup = createStartupChecker(startupDeps, () => refusals);
    const getReadiness = createReadinessChecker({
      channelManager,
      ...startupDeps,
      cacheTtlMs: 0,
    });
    await withProbeServer({ getReadiness, getStartup }, async (server) => {
      await expectProbe(server, "/startupz", 503, {
        ok: false,
        status: "starting",
        version: resolveRuntimeServiceVersion(process.env),
        uptimeMs: expect.any(Number),
        pendingReason: "plugin-convergence",
      });

      gatewayDraining = true;
      await expectProbe(server, "/startupz", 503, {
        ok: false,
        status: "draining",
        version: resolveRuntimeServiceVersion(process.env),
        uptimeMs: expect.any(Number),
      });

      await expectProbe(server, "/readyz", 503, {
        ready: false,
        failing: ["gateway-draining"],
      });
      gatewayDraining = false;

      startupPending = false;
      await expectProbe(server, "/startupz", 503, {
        ok: false,
        status: "starting",
        pendingReason: "agent-database-inspection",
      });
      const readyWhileInspecting = await sendRequest(server, { path: "/readyz" });
      expect(readyWhileInspecting.res.statusCode).toBe(200);
      const liveWhileInspecting = await sendRequest(server, { path: "/healthz" });
      expect(liveWhileInspecting.res.statusCode).toBe(200);

      refusals = [createAgentDatabaseInspectionRefusal({ ...pending, pending: false })];
      await expectProbe(server, "/startupz", 200, {
        ok: true,
        status: "started",
        version: resolveRuntimeServiceVersion(process.env),
        uptimeMs: expect.any(Number),
      });

      refusals = [];
      account.lifecycle = "blocked";
      account.running = false;
      account.connected = false;
      account.linked = false;
      account.terminalDisconnect = true;
      await expectProbe(server, "/readyz", 503, {
        ready: false,
        failing: ["whatsapp"],
      });

      await expectProbe(server, "/startupz", 200, {
        ok: true,
        status: "started",
      });

      gatewayDraining = true;
      await expectProbe(server, "/startupz", 503, {
        ok: false,
        status: "draining",
        version: resolveRuntimeServiceVersion(process.env),
        uptimeMs: expect.any(Number),
      });
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
      async (server) => {
        await expectProbe(
          server,
          {
            path: "/startupz",
            remoteAddress: "10.0.0.8",
            host: "gateway.test",
          },
          503,
          { ok: false, status: "starting" },
          true,
        );

        await expectProbe(
          server,
          {
            path: "/startupz",
            remoteAddress: "10.0.0.8",
            host: "gateway.test",
            authorization: "Bearer test-token",
          },
          503,
          {
            ok: false,
            status: "starting",
            version: resolveRuntimeServiceVersion(process.env),
            uptimeMs: expect.any(Number),
            pendingReason: "startup-sidecars",
          },
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
    await withProbeServer({ getRuntimeConfig, getResolvedAuth }, async (server) => {
      const liveBody = JSON.stringify({ ok: true, status: "live" });
      for (const path of ["/health", "/healthz"]) {
        for (const method of ["GET", "HEAD"] as const) {
          const { res, getBody, setHeader } = await sendRequest(server, { path, method });

          expect(res.statusCode, `${method} ${path}`).toBe(200);
          expect(getBody(), `${method} ${path}`).toBe(method === "HEAD" ? "" : liveBody);
          expect(setHeader).toHaveBeenCalledWith(
            "Content-Length",
            String(Buffer.byteLength(liveBody)),
          );
        }
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
      async (server) => {
        for (const path of ["/health", "/healthz", "/ready", "/readyz", "/startup", "/startupz"]) {
          const response = await sendRequest(server, { path });
          expect(response.res.statusCode, path).toBe(200);
          const body: unknown = JSON.parse(response.getBody());
          if (path.startsWith("/health")) {
            expect(body, path).toEqual({ ok: true, status: "live" });
          } else if (path.startsWith("/ready")) {
            expect(body, path).toEqual({ ready: true, failing: [], uptimeMs: 123 });
          } else {
            expect(body, path).toMatchObject({
              ok: true,
              status: "started",
              version: expect.any(String),
              uptimeMs: expect.any(Number),
            });
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
