import { once } from "node:events";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { ConnectParams } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayAuthConfig } from "../../config/types.gateway.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../../gateway/minimal-gateway.test-helpers.js";
import {
  evaluateMissingDeviceIdentity,
  shouldClearUnboundScopesForMissingDeviceIdentity,
} from "../../gateway/server/ws-connection/connect-policy.js";
import {
  resolveDeviceSignaturePayloadVersion,
  shouldPreserveLocalCliSharedAuthScopes,
  shouldSkipLocalBackendSelfPairing,
} from "../../gateway/server/ws-connection/handshake-auth-helpers.js";
import {
  loadDeviceAuthTokenReadOnly,
  storeDeviceAuthToken,
} from "../../infra/device-auth-store.js";
import { loadOrCreateDeviceIdentity } from "../../infra/device-identity.js";
import { captureEnv } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withGatewayMaintenanceDrain } from "../update-cli/update-command-service-drain.js";
import { waitForGatewayHealthyRestart } from "./restart-health.js";

vi.mock("../../daemon/systemd-maintenance.js", () => ({
  readSystemdGatewayStopTimeout: async () => 330_000,
}));

const version = "2026.8.1";
const buildId = "fixture-build";
const pluginError = { id: "fixture-plugin", error: "fixture load failure" };
const unavailable = {
  id: "unavailable-plugin",
  reason: "missing-extension-entry",
  detail: "Fixture entry missing",
};
const channelError = { id: "fixture", error: "fixture channel failure" };
it.each([
  { mode: "token", requirePluginHealth: true, host: "127.0.0.1" },
  { mode: "password", requirePluginHealth: true, host: "127.0.0.1" },
  { mode: "none", requirePluginHealth: true, host: "127.0.0.1" },
  { mode: "token", requirePluginHealth: false, host: "127.0.0.1" },
  { mode: "trusted-proxy", requirePluginHealth: false, host: "127.0.0.1" },
  { mode: "token", requirePluginHealth: false, host: "0.0.0.0" },
  ...(["token", "password", "none", "trusted-proxy"] as const).map((mode) => ({
    mode,
    requirePluginHealth: false,
    host: "127.0.0.1",
    drain: true,
  })),
] as const)(
  "local control on $host with $mode auth (drain=$drain, requirePluginHealth=$requirePluginHealth)",
  async (scenario) => {
    const { mode, requirePluginHealth, host } = scenario;
    const drain = "drain" in scenario && scenario.drain;
    const paired = drain && mode === "trusted-proxy";
    await withOpenClawTestState(
      {
        env: {
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_GATEWAY_URL: "wss://remote.example.invalid",
        },
      },
      async (state) => {
        const credential = mode === "trusted-proxy" ? "password" : mode;
        const auth: GatewayAuthConfig =
          mode === "none"
            ? { mode }
            : {
                mode,
                ...(!paired ? { [credential]: "fixture-restart-secret" } : {}),
                ...(mode === "trusted-proxy" ? { trustedProxy: { userHeader: "x-user" } } : {}),
              };
        const gateway = new WebSocketServer({ host, port: 0 });
        await once(gateway, "listening");
        const port = (gateway.address() as AddressInfo).port;
        const requests: string[] = [];
        const failures: string[] = [];
        const connections: ConnectParams[] = [];
        gateway.on("connection", (socket) => {
          let scopes: string[] = [];
          sendMinimalGatewayConnectChallenge(socket);
          socket.on("message", (data) => {
            const request = parseMinimalGatewayRequestFrame(data);
            if (request.type !== "req" || !request.id || !request.method) {
              return;
            }
            requests.push(request.method);
            const reply = (payload: unknown) =>
              sendMinimalGatewayResponse(socket, request.id!, payload);
            const reject = (message: string) => {
              failures.push(message);
              socket.send(
                JSON.stringify({
                  type: "res",
                  id: request.id,
                  ok: false,
                  error: { code: "FORBIDDEN", message },
                }),
              );
            };
            const rejectIdentity = () => {
              reject("device identity required");
              socket.close(1008, "device identity required");
            };
            if (request.method === "connect") {
              const connect = request.params as ConnectParams;
              connections.push(connect);
              const sharedAuthOk =
                credential !== "none" && connect.auth?.[credential] === "fixture-restart-secret";
              if (
                paired &&
                (!connect.device ||
                  connect.device.id !== identity?.deviceId ||
                  connect.auth?.deviceToken !== "fixture-paired-token" ||
                  !resolveDeviceSignaturePayloadVersion({
                    device: connect.device,
                    connectParams: connect,
                    role: "operator",
                    scopes: connect.scopes ?? [],
                    signedAtMs: connect.device.signedAt,
                    nonce: "test-nonce",
                  }))
              ) {
                rejectIdentity();
                return;
              }
              const policy = {
                connectParams: connect,
                locality: "direct_local" as const,
                hasBrowserOriginHeader: false,
                sharedAuthOk,
                authMethod: credential,
              };
              const backend = shouldSkipLocalBackendSelfPairing(policy);
              const decision = evaluateMissingDeviceIdentity({
                hasDeviceIdentity: Boolean(connect.device),
                role: "operator",
                isControlUi: false,
                localBackendSelfPairingOk: backend,
                sharedAuthOk,
                authOk: mode === "none" || sharedAuthOk,
                hasSharedAuth: mode !== "none",
              });
              if (decision.kind !== "allow") {
                rejectIdentity();
                return;
              }
              const clearScopes =
                !backend &&
                !shouldPreserveLocalCliSharedAuthScopes(policy) &&
                shouldClearUnboundScopesForMissingDeviceIdentity({
                  decision,
                  authMethod: credential,
                });
              scopes = clearScopes ? [] : (connect.scopes ?? []);
              const hello = buildMinimalGatewayHelloOkPayload({
                auth: { role: "operator", scopes },
              });
              reply({
                ...hello,
                server: { ...hello.server, version, buildId },
              });
              return;
            }
            if (drain) {
              reply(
                request.method === "status"
                  ? { pid: process.pid, shutdownBudget: { timeoutMs: 25_000 } }
                  : {
                      status: "ready",
                      suspensionId: "fixture-suspension",
                      expiresAtMs: Date.now() + 60_000,
                      activeCount: 0,
                      blockers: [],
                      writeCustody: [],
                    },
              );
              return;
            }
            if (request.method !== "health" && !scopes.includes("operator.read")) {
              reject("missing scope: operator.read");
              return;
            }
            reply({
              ok: true,
              plugins: {
                errors: [{ ...pluginError, origin: "bundled", activated: true }],
                unavailable: [
                  {
                    id: unavailable.id,
                    state: "configured-unavailable",
                    diagnostic: {
                      kind: "plugin-verification",
                      reason: unavailable.reason,
                      detail: unavailable.detail,
                    },
                  },
                ],
              },
              channels: requirePluginHealth
                ? { fixture: { probe: { ok: false, error: channelError.error } } }
                : {},
            });
          });
        });
        await state.writeConfig({
          gateway: {
            mode: "remote",
            remote: {
              url: "wss://remote.example.invalid",
              token: "fixture-peer-token",
              password: "fixture-peer-password",
            },
            auth,
            port,
          },
        });
        const identity = paired ? loadOrCreateDeviceIdentity({ env: state.env }) : null;
        if (identity) {
          await storeDeviceAuthToken({
            env: state.env,
            deviceId: identity.deviceId,
            role: "operator",
            token: "fixture-paired-token",
            scopes: ["operator.admin"],
          });
        }
        const service = createMockGatewayService({
          readRuntime: async () => ({ status: "running", pid: process.pid }),
        });
        const before = (await fs.readdir(state.stateDir, { recursive: true })).toSorted();
        const expectUnchangedState = async () =>
          expect((await fs.readdir(state.stateDir, { recursive: true })).toSorted()).toEqual(
            before,
          );
        const callerEnv = captureEnv(["OPENCLAW_STATE_DIR"]);
        if (paired) {
          process.env.OPENCLAW_STATE_DIR = state.path("unrelated-caller");
        }
        try {
          if (drain) {
            const stop = vi.fn(async () => "stopped");
            const warn = vi.fn();
            const stopped = await withGatewayMaintenanceDrain(
              {
                state: {
                  installed: true,
                  loadState: { status: "loaded" },
                  running: true,
                  env: state.env,
                  command: null,
                  runtime: { status: "running", pid: process.pid },
                },
                assertCurrent: () => {},
                warn,
                timeoutMs: 0,
              },
              stop,
            );
            expect(stopped).toBe("stopped");
            expect(requests).toEqual(["connect", "status", "connect", "gateway.suspend.prepare"]);
            expect(failures).toEqual([]);
            expect(stop).toHaveBeenCalledOnce();
            expect(warn).not.toHaveBeenCalled();
            if (identity) {
              expect(
                await loadDeviceAuthTokenReadOnly({
                  env: state.env,
                  deviceId: identity.deviceId,
                  role: "operator",
                }),
              ).toMatchObject({ token: "fixture-paired-token" });
            }
            await expectUnchangedState();
            return;
          }
          const result = await waitForGatewayHealthyRestart({
            service,
            port,
            env: state.env,
            probeHosts: ["127.0.0.1"],
            expectedVersion: version,
            expectedBuildId: buildId,
            requirePluginHealth,
            attempts: 0,
            delayMs: 1,
          });
          expect(result).toMatchObject({
            healthy: !requirePluginHealth,
            waitOutcome: requirePluginHealth ? "plugin-errors" : "healthy",
            gatewayVersion: version,
            gatewayBuildId: buildId,
            activatedPluginErrors: [pluginError],
            unavailablePlugins: [unavailable],
            ...(requirePluginHealth ? { channelProbeErrors: [channelError] } : {}),
          });
          expect(failures).toEqual([]);
          expect(requests).toEqual(["connect", "health"]);
          expect(connections).toHaveLength(1);
          expect(connections[0]?.device).toBeUndefined();
          expect(connections[0]).toMatchObject({
            client:
              mode === "none"
                ? { id: "gateway-client", mode: "backend" }
                : { id: "cli", mode: "cli" },
            scopes: ["operator.read"],
          });
          expect(connections[0]?.auth).toEqual(
            credential === "none" ? undefined : { [credential]: "fixture-restart-secret" },
          );
          await expectUnchangedState();
        } finally {
          callerEnv.restore();
          await closeMinimalGatewayServer(gateway);
        }
      },
    );
  },
);
