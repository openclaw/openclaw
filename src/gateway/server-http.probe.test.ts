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
      await withGatewayServer({
        prefix: "startup-plugin-get-accept-root-control-ui",
        resolvedAuth: AUTH_NONE,
        overrides: {
          controlUiEnabled: true,
          controlUiBasePath: "",
          controlUiRoot: { kind: "resolved", path: controlUiRoot },
          handlePluginRequest: async () => false,
          shouldEnforcePluginGatewayAuth: () => false,
          isStartupPluginRuntimeReady: () => sidecarsReady,
        },
        run: async (server) => {
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
      });
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
  ])(
    "returns 404 for the $name instead of Control UI HTML",
    async ({ name, enabled, requestPath }) => {
      await withMarkedControlUiRoot(async (controlUiRoot) => {
        await withGatewayServer({
          prefix: `mcp-app-routing-${name}`,
          resolvedAuth: AUTH_NONE,
          overrides: {
            controlUiEnabled: true,
            controlUiBasePath: "",
            controlUiRoot: { kind: "resolved", path: controlUiRoot },
            getRuntimeConfig: () => ({
              gateway: { trustedProxies: [] },
              mcp: { apps: { enabled } },
            }),
          },
          run: async (server) => {
            const { res, getBody } = await sendRequest(server, {
              path: requestPath,
              method: "GET",
            });

            expect(res.statusCode).toBe(404);
            expect(getBody()).toBe("Not Found");
          },
        });
      });
    },
  );
});

describe("gateway probe endpoints", () => {
  it("returns 404 for probe namespace variants instead of false-green Control UI HTML", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["gateway-draining"],
      uptimeMs: 1_000,
    });
    await withMarkedControlUiRoot(async (controlUiRoot) => {
      await withGatewayServer({
        prefix: "probe-namespace-root-control-ui",
        resolvedAuth: AUTH_NONE,
        overrides: {
          controlUiEnabled: true,
          controlUiBasePath: "",
          controlUiRoot: { kind: "resolved", path: controlUiRoot },
          getReadiness,
        },
        run: async (server) => {
          const exact = await sendRequest(server, { path: "/readyz" });
          expect(exact.res.statusCode).toBe(503);
          expect(JSON.parse(exact.getBody())).toMatchObject({ ready: false });

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
      });
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
      await withGatewayServer({
        prefix: "probe-suspension-lease",
        resolvedAuth: AUTH_NONE,
        overrides: { getReadiness, openAiChatCompletionsEnabled: true },
        run: async (server) => {
          const prepared = prepareGatewaySuspend({
            requestId: "request-readiness-probe",
            pauseScheduling: vi.fn(),
            resumeScheduling: vi.fn(),
            createSuspensionId: () => "suspension-readiness-probe",
            inspect: {
              getQueueSize: () => 0,
              getPendingReplies: () => 0,
              getEmbeddedRuns: () => 0,
              getCronRuns: () => 0,
              getAgentRuns: () => 0,
              getAcpRuns: () => 0,
              getMediaRuns: () => 0,
              getRootRequests: () => 0,
              getSessionAdmissions: () => 0,
              getSessionMutations: () => 0,
              getChatRuns: () => 0,
              getQueuedTurns: () => 0,
              getTerminalPersistence: () => 0,
              getTerminalSessions: () => 0,
            },
          });
          if (prepared.status !== "ready") {
            throw new Error(`expected prepared suspension, received ${prepared.status}`);
          }

          const health = await sendRequest(server, { path: "/healthz" });
          expect(health.res.statusCode).toBe(200);
          expect(JSON.parse(health.getBody())).toEqual({ ok: true, status: "live" });

          const suspendedReadiness = await sendRequest(server, { path: "/readyz" });
          expect(suspendedReadiness.res.statusCode).toBe(503);
          expect(JSON.parse(suspendedReadiness.getBody())).toMatchObject({
            ready: false,
            failing: ["gateway-draining"],
          });

          const blockedChat = await sendRequest(server, {
            path: "/v1/chat/completions",
            method: "POST",
          });
          expect(blockedChat.res.statusCode).toBe(503);
          expect(JSON.parse(blockedChat.getBody())).toMatchObject({
            error: { code: "gateway_unavailable" },
          });

          const blockedBoard = await sendRequest(server, {
            path: "/__openclaw__/board/agent%3Amain%3Amain/status/index.html?bt=garbage",
          });
          expect(blockedBoard.res.statusCode).toBe(503);
          expect(JSON.parse(blockedBoard.getBody())).toMatchObject({
            error: { code: "gateway_unavailable" },
          });

          expect(resumeGatewaySuspend(prepared.suspensionId)).toEqual({
            ok: true,
            status: "running",
            resumed: true,
          });

          const resumedReadiness = await sendRequest(server, { path: "/readyz" });
          expect(resumedReadiness.res.statusCode).toBe(200);
          expect(JSON.parse(resumedReadiness.getBody())).toMatchObject({
            ready: true,
            failing: [],
          });
        },
      });
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
      await withGatewayServer({
        prefix: "probe-http-work-admission",
        resolvedAuth: AUTH_NONE,
        overrides: { handleWatchNodeRequest },
        run: async (server) => {
          const request = createRequest({ path: "/api/nodes/watch/node-1" });
          const response = createResponse();
          const pendingRequest = dispatchRequest(server, request, response.res);
          await watchStarted;
          expect(getActiveGatewayRootWorkCount()).toBe(1);

          const prepared = prepareGatewaySuspend({
            requestId: "request-http-work",
            pauseScheduling: vi.fn(),
            resumeScheduling: vi.fn(),
            inspect: {
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
            },
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
        },
      });
    } finally {
      releaseWatch();
      resetGatewayWorkAdmission();
    }
  });

  it("serves healthy readiness with cleanup details only to local or authenticated callers", async () => {
    const agentCleanup = ["main", "optional"].map((agentId) => ({
      agentId,
      reason: "retained worker cleanup failure",
      repairHint: "Retry this agent or restart without deleting its lease.",
    }));
    const getReadiness: ReadinessChecker = () => ({
      ready: true,
      failing: [],
      uptimeMs: 8_000,
      agentCleanup,
    });
    await withGatewayServer({
      prefix: "probe-retained-agent-cleanup",
      resolvedAuth: AUTH_TOKEN,
      overrides: { getReadiness },
      run: async (server) => {
        const local = await sendRequest(server, { path: "/readyz" });
        expect(local.res.statusCode).toBe(200);
        expect(JSON.parse(local.getBody())).toEqual(getReadiness());
        const remote = await sendRequest(server, {
          path: "/readyz",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
        });
        expect(remote.res.statusCode).toBe(200);
        expect(JSON.parse(remote.getBody())).toEqual({ ready: true });
        const authenticated = await sendRequest(server, {
          path: "/readyz",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
          authorization: "Bearer test-token",
        });
        expect(authenticated.res.statusCode).toBe(200);
        expect(JSON.parse(authenticated.getBody())).toEqual(getReadiness());
      },
    });
  });

  it("returns only readiness state for unauthenticated remote /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
      agentCleanup: [{ agentId: "main", reason: "retained cleanup", repairHint: "Restart." }],
    });

    await withGatewayServer({
      prefix: "probe-not-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const { res, getBody } = await sendRequest(server, {
          path: "/ready",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
        });

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ ready: false });
      },
    });
  });

  it("rejects unattributable proxy ingress before hooks and watch-node handlers", async () => {
    const handleHooksRequest = vi.fn(async () => true);
    const handleWatchNodeRequest = vi.fn(async () => true);

    await withGatewayServer({
      prefix: "probe-unattributable-owned-routes",
      resolvedAuth: AUTH_TOKEN,
      overrides: { handleHooksRequest, handleWatchNodeRequest },
      run: async (server) => {
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
    });

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

    await withGatewayServer({
      prefix: "probe-remote-rotated-auth",
      // `resolvedAuth` remains the static fallback; `getResolvedAuth` drives the rotated value.
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        getReadiness,
        getResolvedAuth: () => currentAuth,
      },
      run: async (server) => {
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
    });
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

    await withGatewayServer({
      prefix: "probe-throws",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const { res, getBody } = await sendRequest(server, { path: "/ready" });

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ ready: false, failing: ["internal"], uptimeMs: 0 });
      },
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

    await withGatewayServer({
      prefix: "probe-startup-lifecycle",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness, getStartup },
      run: async (server) => {
        const starting = await sendRequest(server, { path: "/startupz" });
        expect(starting.res.statusCode).toBe(503);
        expect(JSON.parse(starting.getBody())).toMatchObject({
          ok: false,
          status: "starting",
          version: resolveRuntimeServiceVersion(process.env),
          uptimeMs: expect.any(Number),
          pendingReason: "plugin-convergence",
        });

        gatewayDraining = true;
        const drainingDuringStartup = await sendRequest(server, { path: "/startupz" });
        expect(drainingDuringStartup.res.statusCode).toBe(503);
        expect(JSON.parse(drainingDuringStartup.getBody())).toMatchObject({
          ok: false,
          status: "draining",
          version: resolveRuntimeServiceVersion(process.env),
          uptimeMs: expect.any(Number),
        });

        const drainingReadiness = await sendRequest(server, { path: "/readyz" });
        expect(drainingReadiness.res.statusCode).toBe(503);
        expect(JSON.parse(drainingReadiness.getBody())).toMatchObject({
          ready: false,
          failing: ["gateway-draining"],
        });
        gatewayDraining = false;

        startupPending = false;
        const inspecting = await sendRequest(server, { path: "/startupz" });
        expect(inspecting.res.statusCode).toBe(503);
        expect(JSON.parse(inspecting.getBody())).toMatchObject({
          ok: false,
          status: "starting",
          pendingReason: "agent-database-inspection",
        });
        const readyWhileInspecting = await sendRequest(server, { path: "/readyz" });
        expect(readyWhileInspecting.res.statusCode).toBe(200);
        const liveWhileInspecting = await sendRequest(server, { path: "/healthz" });
        expect(liveWhileInspecting.res.statusCode).toBe(200);

        refusals = [createAgentDatabaseInspectionRefusal({ ...pending, pending: false })];
        const started = await sendRequest(server, { path: "/startupz" });
        expect(started.res.statusCode).toBe(200);
        expect(JSON.parse(started.getBody())).toMatchObject({
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
        const readiness = await sendRequest(server, { path: "/readyz" });
        expect(readiness.res.statusCode).toBe(503);
        expect(JSON.parse(readiness.getBody())).toMatchObject({
          ready: false,
          failing: ["whatsapp"],
        });

        const channelIndependentStartup = await sendRequest(server, {
          path: "/startupz",
        });
        expect(channelIndependentStartup.res.statusCode).toBe(200);
        expect(JSON.parse(channelIndependentStartup.getBody())).toMatchObject({
          ok: true,
          status: "started",
        });

        gatewayDraining = true;
        const draining = await sendRequest(server, { path: "/startupz" });
        expect(draining.res.statusCode).toBe(503);
        expect(JSON.parse(draining.getBody())).toMatchObject({
          ok: false,
          status: "draining",
          version: resolveRuntimeServiceVersion(process.env),
          uptimeMs: expect.any(Number),
        });
      },
    });
  });

  it("gates startup details to local or authenticated callers", async () => {
    const getStartup = createStartupChecker({
      startedAt: Date.now() - 8_000,
      getStartupPending: () => true,
      getStartupPendingReason: () => "startup-sidecars",
      getGatewayDraining: () => false,
    });

    await withGatewayServer({
      prefix: "probe-startup-details",
      resolvedAuth: AUTH_TOKEN,
      overrides: { getStartup },
      run: async (server) => {
        const remote = await sendRequest(server, {
          path: "/startupz",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
        });
        expect(remote.res.statusCode).toBe(503);
        expect(JSON.parse(remote.getBody())).toEqual({ ok: false, status: "starting" });

        const authenticated = await sendRequest(server, {
          path: "/startupz",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
          authorization: "Bearer test-token",
        });
        expect(authenticated.res.statusCode).toBe(503);
        expect(JSON.parse(authenticated.getBody())).toMatchObject({
          ok: false,
          status: "starting",
          version: resolveRuntimeServiceVersion(process.env),
          uptimeMs: expect.any(Number),
          pendingReason: "startup-sidecars",
        });
      },
    });
  });

  it("serves liveness probes before loading gateway config or resolving auth", async () => {
    const getRuntimeConfig = vi.fn(() => {
      throw new Error("config load blocked");
    });
    const getResolvedAuth = vi.fn(() => {
      getRuntimeConfig();
      return AUTH_NONE;
    });

    await withGatewayServer({
      prefix: "probe-liveness-before-config-auth",
      resolvedAuth: AUTH_NONE,
      overrides: { getRuntimeConfig, getResolvedAuth },
      run: async (server) => {
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
      },
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

    await withGatewayServer({
      prefix: "probe-before-stalled-stages",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        getReadiness,
        handleHooksRequest,
        controlUiEnabled: true,
        controlUiBasePath: "",
        controlUiRoot: { kind: "missing" },
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth,
      },
      run: async (server) => {
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
    });
  });
});
