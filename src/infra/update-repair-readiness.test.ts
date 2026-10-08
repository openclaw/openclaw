import { once } from "node:events";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import {
  inspectGatewayRestart,
  waitForGatewayHealthyRestart,
} from "../cli/daemon-cli/restart-health.js";
import { createMockGatewayService } from "../daemon/service.test-helpers.js";
import type { HealthSummary } from "../gateway/health/types.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import { healthHandlers } from "../gateway/server-methods/health.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { createGatewayRequestContext } from "../gateway/server-request-context.js";
import {
  makeContextParams,
  makeGatewayClient,
} from "../gateway/server-request-context.test-support.js";
import type { GatewayEventLoopHealth } from "../gateway/server/event-loop-health.js";
import { createReadinessChecker, createStartupChecker } from "../gateway/server/readiness.js";
import * as childRuntime from "../infra/child-runtime-viability.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";

it("uses the health RPC's operational facts for restart acceptance and recovery", async ({
  signal,
}) => {
  await withOpenClawTestState(
    {
      env: {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_URL: undefined,
        OPENCLAW_UPDATE_RUN_ID: undefined,
        OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
        OPENCLAW_UPDATE_IN_PROGRESS: undefined,
      },
    },
    async (state) => {
      await using cleanup = new AsyncDisposableStack();
      const claim = await acquireTestPortBlock({ offsets: [0], signal });
      cleanup.defer(() => claim.release());
      const port = claim.port;
      const gateway = new WebSocketServer({ host: "127.0.0.1", port });
      cleanup.defer(() => closeMinimalGatewayServer(gateway));
      await once(gateway, "listening");
      const config = { gateway: { auth: { mode: "none" as const }, port } };
      await state.writeConfig(config);
      let accounts: Record<string, ChannelAccountSnapshot> = {};
      let startupPending = false;
      let runtimeUnavailable = false;
      let suppressed = false;
      let skipChannels = false;
      let connectError: string | undefined;
      let snapshot: HealthSummary & { eventLoop?: GatewayEventLoopHealth };
      const channelManager = {
        getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: { telegram: accounts } }),
        getAutostartSuppression: () =>
          suppressed
            ? { reason: "crash-loop-breaker" as const, message: "Fixture suppression" }
            : null,
        isAmbientAutostartSuppressed: () => false,
      };
      const startup = {
        startedAt: Date.now(),
        getStartupPending: () => startupPending,
        getStartupPendingReason: () => "startup-sidecars",
      };
      const getReadiness = createReadinessChecker({
        ...startup,
        channelManager,
        cacheTtlMs: 0,
        shouldSkipChannelReadiness: () => skipChannels,
      });
      const getStartup = createStartupChecker(startup);
      const context = Object.assign(createGatewayRequestContext(makeContextParams()), {
        getHealthCache: () => snapshot,
        refreshHealthSnapshot: async () => snapshot,
        getRuntimeSnapshot: () => {
          if (runtimeUnavailable) {
            throw new Error("Fixture observation unavailable");
          }
          return channelManager.getRuntimeSnapshot();
        },
        getEventLoopHealth: () => snapshot.eventLoop,
        getGatewayReadiness: getReadiness,
        getGatewayStartup: getStartup,
        logHealth: { error: () => {} },
      } satisfies Partial<GatewayRequestContext>);
      const payloads: unknown[] = [];
      gateway.on("connection", (socket) => {
        sendMinimalGatewayConnectChallenge(socket);
        socket.on("message", (data) => {
          const request = parseMinimalGatewayRequestFrame(data);
          if (request.type !== "req" || !request.id) {
            return;
          }
          if (request.method === "connect") {
            if (connectError) {
              socket.send(
                JSON.stringify({
                  type: "res",
                  id: request.id,
                  ok: false,
                  error: { code: "FORBIDDEN", message: connectError },
                }),
              );
              return;
            }
            const hello = buildMinimalGatewayHelloOkPayload();
            sendMinimalGatewayResponse(socket, request.id, {
              ...hello,
              server: { ...hello.server, buildId: "fixture-build" },
            });
            return;
          }
          const handling = healthHandlers.health!({
            req: { type: "req", id: request.id, method: "health" },
            params: {},
            context,
            client: makeGatewayClient({
              connId: "readiness-proof",
              clientId: "cli",
              scopes: ["operator.read"],
            }),
            isWebchatConnect: () => false,
            respond: (ok, payload, error) => {
              payloads.push(payload);
              socket.send(JSON.stringify({ type: "res", id: request.id, ok, payload, error }));
            },
          });
          void Promise.resolve(handling).catch((error: unknown) => {
            socket.send(
              JSON.stringify({
                type: "res",
                id: request.id,
                ok: false,
                error: { code: "UNAVAILABLE", message: String(error) },
              }),
            );
          });
        });
      });
      const service = createMockGatewayService({
        readRuntime: async () => ({ status: "running", pid: process.pid }),
      });
      const child = vi.spyOn(childRuntime, "readChildRuntimeViability");
      const verify = (requirePluginHealth = true, operational = true) =>
        waitForGatewayHealthyRestart({
          service,
          port,
          expectedVersion: "test",
          signal,
          env: state.env,
          probeContext: { config, auth: undefined },
          probeHosts: ["127.0.0.1"],
          attempts: 0,
          delayMs: 1,
          requirePluginHealth,
          purpose: operational ? "verification" : "diagnostic",
        });
      try {
        const authProbe = {
          signal,
          service,
          port,
          env: state.env,
          probeContext: { config, auth: undefined },
          probeHosts: ["127.0.0.1"],
          attempts: 0,
          delayMs: 1,
          requirePluginHealth: false,
        };
        connectError = "pairing required";
        for (const purpose of ["lifecycle", "verification"] as const) {
          expect(await waitForGatewayHealthyRestart({ ...authProbe, purpose })).toMatchObject({
            healthy: purpose === "lifecycle",
            readiness: { state: "reachable", reasons: ["health-unavailable"] },
          });
        }
        expect(
          // Observe the marker policy once; do not run its five-minute startup watchdog.
          await inspectGatewayRestart({
            ...authProbe,
            purpose: "lifecycle",
            env: { ...state.env, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
          }),
        ).toMatchObject({ healthy: false, readiness: { state: "reachable" } });
        connectError = "unrecognized fixture rejection";
        expect(
          await waitForGatewayHealthyRestart({
            ...authProbe,
            purpose: "lifecycle",
          }),
        ).toMatchObject({ healthy: false });
        connectError = undefined;
        for (const scenario of [
          "event-loop",
          "ready",
          "missing-account",
          "missing-account-cached-ready",
          "starting",
          "channel-starting",
          "channel-starting-untimed",
          "channel-recovering-expired",
          "legacy-connected",
          "legacy-running",
          "busy-disconnected",
          "disconnected",
          "plugin-error",
          "probe-failed",
          "optional-timeout",
          "child-runtime",
          "recovered",
        ] as const) {
          startupPending = scenario === "starting";
          accounts =
            scenario === "channel-starting" ||
            scenario === "channel-starting-untimed" ||
            scenario === "channel-recovering-expired" ||
            scenario === "legacy-connected" ||
            scenario === "legacy-running" ||
            scenario === "busy-disconnected" ||
            scenario === "disconnected"
              ? {
                  secondary: {
                    accountId: "secondary",
                    enabled: true,
                    configured: true,
                    running: true,
                    connected:
                      scenario === "legacy-running" ||
                      scenario === "channel-starting-untimed" ||
                      scenario === "channel-recovering-expired"
                        ? undefined
                        : scenario === "legacy-connected",
                    lifecycle:
                      scenario === "channel-starting" || scenario === "channel-starting-untimed"
                        ? "starting"
                        : scenario === "channel-recovering-expired"
                          ? "recovering"
                          : scenario === "legacy-connected" || scenario === "legacy-running"
                            ? undefined
                            : "ready",
                    lastStartAt:
                      scenario === "channel-starting-untimed"
                        ? undefined
                        : Date.now() -
                          (scenario === "disconnected" ||
                          scenario === "busy-disconnected" ||
                          scenario === "channel-recovering-expired"
                            ? 180_000
                            : 0),
                    ...(scenario === "busy-disconnected"
                      ? {
                          busy: true,
                          lastRunActivityAt: Date.now(),
                          activeRunStartedAt: Date.now(),
                        }
                      : {}),
                  },
                }
              : {};
          snapshot = {
            ok: true,
            ts: Date.now(),
            durationMs: 0,
            channels: { telegram: { accountId: "default", accounts } },
            channelOrder: ["telegram"],
            channelLabels: { telegram: "Telegram" },
            heartbeatSeconds: 0,
            agents: [],
            sessions: { path: state.path("sessions"), count: 0, recent: [] },
            ...(scenario === "plugin-error"
              ? {
                  plugins: {
                    loaded: [],
                    errors: [
                      {
                        id: "fixture",
                        origin: "bundled",
                        activated: false,
                        activationSource: "explicit",
                        error: "Fixture start failed",
                      },
                    ],
                  },
                }
              : {}),
            ...(scenario === "event-loop"
              ? {
                  eventLoop: {
                    degraded: true,
                    degradedSinceMs: 0,
                    reasons: ["event_loop_delay"],
                    intervalMs: 2_000,
                    delayP99Ms: 1_200,
                    delayMaxMs: 1_500,
                    utilization: 0.9,
                    cpuCoreRatio: 0.8,
                  },
                }
              : {}),
          };
          if (scenario === "missing-account" || scenario === "missing-account-cached-ready") {
            expectDefined(snapshot.channels.telegram, "telegram channel").accounts = {
              default: {
                accountId: "default",
                enabled: true,
                configured: true,
                ...(scenario === "missing-account-cached-ready"
                  ? { running: true, connected: true, lifecycle: "ready" as const }
                  : {}),
              },
            };
          }
          if (scenario === "probe-failed") {
            accounts.default = {
              accountId: "default",
              running: true,
              connected: true,
              lifecycle: "ready",
              probe: { ok: true },
            };
            expectDefined(snapshot.channels.telegram, "telegram channel").accounts = {
              default: {
                accountId: "default",
                probe: { ok: false, error: "Fixture probe failed" },
              },
            };
          }
          if (scenario === "optional-timeout") {
            accounts.default = {
              accountId: "default",
              running: true,
              configured: true,
              enabled: true,
              lifecycle: "ready",
              probe: { timedOut: true, error: "Optional check timed out" },
            };
          }
          child.mockReturnValue({
            execPath: "/synthetic/node",
            available: scenario !== "child-runtime",
          });
          const result = await verify();
          const ready = [
            "ready",
            "legacy-connected",
            "legacy-running",
            "optional-timeout",
            "recovered",
          ].includes(scenario);
          expect(result.healthy, scenario).toBe(ready);
          expect(result.readiness?.state, scenario).toBe(
            ready
              ? "ready"
              : scenario === "missing-account" || scenario === "missing-account-cached-ready"
                ? "reachable"
                : scenario === "child-runtime"
                  ? "failed"
                  : scenario === "starting" ||
                      scenario === "channel-starting" ||
                      scenario === "channel-starting-untimed" ||
                      scenario === "channel-recovering-expired"
                    ? "starting"
                    : "degraded",
          );
          expect(payloads.at(-1)).toMatchObject({ ok: true, readiness: result.readiness });
          if (scenario === "event-loop" || scenario === "ready" || scenario === "recovered") {
            for (const updateMarker of [undefined, "1"]) {
              expect(
                await inspectGatewayRestart({
                  ...authProbe,
                  expectedVersion: "test",
                  purpose: "lifecycle",
                  env: { ...state.env, OPENCLAW_UPDATE_IN_PROGRESS: updateMarker },
                }),
              ).toMatchObject({
                healthy: updateMarker ? ready : true,
                readiness: result.readiness,
              });
            }
          }
          if (scenario === "missing-account" || scenario === "missing-account-cached-ready") {
            expect(result.readiness?.reasons).toEqual([
              "channel:telegram:default:observation-unavailable",
              "readiness-unavailable",
            ]);
            const required = expectDefined(
              snapshot.channels.telegram?.accounts?.default,
              "account",
            );
            required.enabled = false;
            expect(await verify()).toMatchObject({ healthy: true, readiness: { state: "ready" } });
            required.enabled = true;
            accounts.default = { accountId: "default", running: true, lifecycle: "ready" };
            expect(await verify()).toMatchObject({ healthy: true, readiness: { state: "ready" } });
          } else if (scenario === "optional-timeout") {
            expect(result.readiness?.warnings).toContain("channel:telegram:default:probe-timeout");
            expect(result.channelProbeErrors).toBeUndefined();
            expect(result.channelProbeTimeouts).toEqual([
              { id: "telegram", error: "Optional check timed out" },
            ]);
            // The optional timeout cannot erase a current channel's startup observation.
            accounts.default = {
              ...expectDefined(accounts.default, "default account"),
              lifecycle: "starting",
              connected: false,
              lastStartAt: Date.now(),
            };
            expectDefined(snapshot.channels.telegram, "telegram channel").accounts = {
              default: { accountId: "default", probe: { timedOut: true } },
            };
            expect(await verify()).toMatchObject({
              healthy: false,
              readiness: { state: "starting" },
            });
          } else if (scenario === "channel-starting") {
            expect(await verify(true, false)).toMatchObject({
              healthy: false,
              waitOutcome: "gateway-not-ready",
              readiness: { state: "starting" },
            });
          } else if (scenario === "plugin-error") {
            expect(await verify(false)).toMatchObject({
              healthy: true,
              readiness: { state: "degraded" },
            });
            runtimeUnavailable = true;
            expect(await verify(false)).toMatchObject({
              healthy: false,
              readiness: { reasons: expect.arrayContaining(["readiness-unavailable"]) },
            });
            runtimeUnavailable = false;
          } else if (scenario === "disconnected") {
            expectDefined(accounts.secondary, "secondary account").enabled = false;
            expect(await verify()).toMatchObject({ healthy: true, readiness: { state: "ready" } });
            expectDefined(accounts.secondary, "secondary account").enabled = true;
            expectDefined(accounts.secondary, "secondary account").running = false;
            suppressed = true;
            expect(await verify()).toMatchObject({
              healthy: true,
              readiness: {
                state: "ready",
                warnings: ["channel:telegram:secondary:autostart-suppressed"],
              },
            });
            suppressed = false;
            skipChannels = true;
            runtimeUnavailable = true;
            expectDefined(accounts.secondary, "secondary account").lifecycle = "blocked";
            expect(await verify()).toMatchObject({
              healthy: true,
              readiness: {
                state: "ready",
                warnings: ["channel:telegram:secondary:readiness-skipped"],
              },
            });
            skipChannels = false;
            runtimeUnavailable = false;
          }
        }
      } finally {
        child.mockRestore();
      }
    },
  );
});
