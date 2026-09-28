// Process coverage for health failures and unreachable Gateway commands.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import type { ChannelsStatusResult } from "../../packages/gateway-protocol/src/schema/channels.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import type { GatewayEventLoopHealth } from "../gateway/server/event-loop-health.js";
import { seedOriginDeviceToken } from "../infra/device-auth-store.test-support.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { getFreePort } from "../test-utils/ports.js";
import {
  prepareGatewayCliFixture,
  prepareUnreachableGatewayCliFixture,
  runIsolatedGatewayCli,
  snapshotDirectoryContents,
  snapshotSharedStateArtifacts,
  tempDirs,
  UNREACHABLE_GATEWAY_URL,
} from "./gateway-backed-exit.process.test-support.js";
import { startRateLimitedGateway } from "./gateway-backed-exit.test-helpers.js";

function expectUnreachableGatewayTransportFailure(
  result: Awaited<ReturnType<typeof runIsolatedGatewayCli>>,
  output: "json" | "text",
): void {
  expect(result).toMatchObject({ code: 1, signal: null });
  if (output === "json") {
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        type: "gateway_transport_error",
        kind: "closed",
        message: expect.stringContaining("Gateway not reachable"),
      },
      gateway: { url: UNREACHABLE_GATEWAY_URL },
    });
    return;
  }
  expect(result.stderr).toContain("Gateway not reachable");
  expect(result.stderr).toContain(UNREACHABLE_GATEWAY_URL);
  expect(result.stderr).not.toContain("gateway timeout");
}

// Custody is an ordering/integrity contract, not a two-second handshake SLO.
// The real child also loads device auth through a SQLite worker before connect.
// Keep a bounded integration budget; call.test.ts enforces short deadlines with a fake clock.
const STATE_CUSTODY_RPC_BUDGET_MS = 10_000;
const CHANNEL_PROBE_TIMEOUT_MS = 2_000;

describe("gateway-backed CLI process exit", () => {
  it.each([
    {
      label: "channels status",
      method: "channels.status",
      args: ["channels", "status", "--probe"],
    },
    {
      label: "gateway call system.info",
      method: "system.info",
      args: ["gateway", "call", "system.info"],
    },
    {
      label: "gateway call channels.status",
      method: "channels.status",
      args: [
        "gateway",
        "call",
        "channels.status",
        "--params",
        JSON.stringify({ probe: true, timeoutMs: CHANNEL_PROBE_TIMEOUT_MS }),
      ],
    },
  ])("reads $label while another process owns state maintenance", async ({ method, args }) => {
    const startedAt = performance.now();
    const phases: Array<{ phase: string; elapsedMs: number }> = [];
    const recordPhase = (phase: string) => {
      phases.push({ phase, elapsedMs: Math.round(performance.now() - startedAt) });
    };
    const root = tempDirs.make("openclaw-status-state-custody-");
    const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let stateOwner: ReturnType<typeof acquireGatewayStateOwner> | undefined;
    try {
      await once(gateway, "listening");
      const address = gateway.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP Gateway fixture");
      }
      const url = `ws://127.0.0.1:${address.port}`;
      const { stateDir, configPath } = await prepareGatewayCliFixture(root, {
        mode: "remote",
        auth: { mode: "none" },
        remote: { url },
      });
      const env = { ...process.env, HOME: root, OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: stateDir };
      const identity = loadOrCreateDeviceIdentity({ env });
      seedOriginDeviceToken({
        gatewayScope: gatewayOriginScope(url),
        deviceId: identity.deviceId,
        role: "operator",
        token: "synthetic-stored-device-token",
        scopes: ["operator.admin"],
        env,
      });
      closeOpenClawStateDatabaseForTest();
      const before = await snapshotDirectoryContents(stateDir);
      const expectedAfter = { ...before };
      const canonicalStateDir = await fs.realpath(stateDir);
      const eventLoop = {
        degraded: false,
        degradedSinceMs: null,
        reasons: [],
        intervalMs: 1_000,
        delayP99Ms: 1,
        delayMaxMs: 2,
        utilization: 0.01,
        cpuCoreRatio: 0.01,
      } satisfies GatewayEventLoopHealth;
      const channelStatus = {
        ts: 1_800_000_000_000,
        channelOrder: [],
        channelLabels: {},
        channelDetailLabels: {},
        channelSystemImages: {},
        channelMeta: [],
        channels: {},
        channelAccounts: {},
        channelDefaultAccountId: {},
        eventLoop,
      } satisfies ChannelsStatusResult;
      const payload =
        method === "channels.status"
          ? channelStatus
          : { pid: 123, runtimeVersion: "synthetic-runtime" };
      const calls: string[] = [];

      gateway.on("connection", (ws) => {
        recordPhase("connection");
        ws.on("close", () => recordPhase("close"));
        sendMinimalGatewayConnectChallenge(ws);
        recordPhase("challenge-sent");
        ws.on("message", (data) => {
          const frame = parseMinimalGatewayRequestFrame(data);
          recordPhase(`message:${frame.method}`);
          if (frame.type !== "req" || !frame.id) {
            return;
          }
          if (frame.method === "connect") {
            expect(frame.params?.auth).toEqual({ deviceToken: "synthetic-stored-device-token" });
            expect(frame.params?.device).toMatchObject({
              id: identity.deviceId,
              nonce: "test-nonce",
            });
            recordPhase("auth-checked");
            // Auth loading has finished; hold native custody before the hello can trigger storage.
            stateOwner ??= acquireGatewayStateOwner({
              databasePath: resolveOpenClawStateSqlitePath(env),
            });
            const ownerPath = path.relative(canonicalStateDir, stateOwner.path);
            if (
              ownerPath &&
              ownerPath !== ".." &&
              !ownerPath.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(ownerPath)
            ) {
              // Preserve the pre-CLI snapshot; add only the parent's actual custody artifacts.
              expectedAfter[ownerPath] = `file:${createHash("sha256")
                .update(readFileSync(stateOwner.path))
                .digest("hex")}`;
              for (let directory = path.dirname(ownerPath); directory !== ".";) {
                expectedAfter[directory] ??= "directory";
                directory = path.dirname(directory);
              }
            }
            recordPhase("custody-acquired");
            sendMinimalGatewayResponse(
              ws,
              frame.id,
              buildMinimalGatewayHelloOkPayload({
                methods: [method],
                auth: {
                  role: "operator",
                  scopes: ["operator.read"],
                  deviceToken: "synthetic-issued-device-token",
                },
              }),
            );
            recordPhase("hello-sent");
            return;
          }
          expect(stateOwner).toBeDefined();
          stateOwner!.assertCurrent();
          expect(frame.method).toBe(method);
          if (method === "channels.status") {
            const timeoutMs = frame.params?.timeoutMs;
            expect(frame.params).toEqual({ probe: true, timeoutMs });
            expect(Number.isInteger(timeoutMs)).toBe(true);
            expect(timeoutMs).toBeGreaterThan(0);
            expect(timeoutMs).toBeLessThanOrEqual(STATE_CUSTODY_RPC_BUDGET_MS);
            if (args[0] === "gateway") {
              expect(timeoutMs).toBe(CHANNEL_PROBE_TIMEOUT_MS);
            }
          }
          calls.push(method);
          sendMinimalGatewayResponse(ws, frame.id, payload);
        });
      });
      recordPhase("child-start");
      const result = await runIsolatedGatewayCli({
        args: [...args, "--json", "--timeout", String(STATE_CUSTODY_RPC_BUDGET_MS)],
        root,
        stateDir,
        configPath,
      });
      recordPhase("child-exited");
      const after = await snapshotDirectoryContents(stateDir);
      const evidence = JSON.stringify({
        result,
        calls,
        phases,
        stateOwnerPath: stateOwner?.path,
        stateBefore: before,
        stateExpected: expectedAfter,
        stateAfter: after,
      });
      expect(JSON.parse(result.stdout), evidence).toEqual(payload);
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
      expect(calls, evidence).toEqual([method]);
      expect(
        phases.map(({ phase }) => phase).filter((phase) => phase !== "close"),
        evidence,
      ).toEqual([
        "child-start",
        "connection",
        "challenge-sent",
        "message:connect",
        "auth-checked",
        "custody-acquired",
        "hello-sent",
        `message:${method}`,
        "child-exited",
      ]);
      expect(stateOwner, evidence).toBeDefined();
      stateOwner!.assertCurrent();
      expect(after).toEqual(expectedAfter);
    } finally {
      try {
        stateOwner?.release();
      } finally {
        await closeMinimalGatewayServer(gateway);
      }
    }
  });

  // One child per case: the deadlock guard is sized against a single cold CLI start.
  it.each(
    [
      {
        label: "root-health-json",
        args: ["health", "--json", "--timeout", "250"],
        output: "json" as const,
      },
      {
        label: "gateway-health-text",
        args: ["gateway", "health", "--timeout", "250"],
        output: "text" as const,
      },
      {
        label: "gateway-health-json",
        args: ["gateway", "health", "--json", "--timeout", "250"],
        output: "json" as const,
      },
      {
        label: "gateway-suspend-json",
        args: ["gateway", "suspend", "--json", "--timeout", "250"],
        output: "json" as const,
      },
      {
        label: "gateway-resume-json",
        args: ["gateway", "resume", "suspension-1", "--json", "--timeout", "250"],
        output: "json" as const,
      },
    ].flatMap((command) =>
      [
        { stateLabel: "absent", seeded: false },
        { stateLabel: "seeded", seeded: true },
      ].map((state) => ({
        args: command.args,
        label: command.label,
        output: command.output,
        seeded: state.seeded,
        stateLabel: state.stateLabel,
      })),
    ),
  )(
    "leaves $stateLabel shared state byte-identical after unreachable $label",
    async ({ label, args, output, seeded, stateLabel }) => {
      const fixture = await prepareUnreachableGatewayCliFixture({
        label: `${label}-${stateLabel}`,
        seeded,
      });
      const before = await snapshotSharedStateArtifacts(fixture.stateDir);
      expect(Object.keys(before).includes("openclaw.sqlite")).toBe(seeded);

      const result = await runIsolatedGatewayCli({ ...fixture, args });

      expectUnreachableGatewayTransportFailure(result, output);
      expect(await snapshotSharedStateArtifacts(fixture.stateDir)).toEqual(before);
    },
  );

  it("keeps gateway auth failures machine-readable through the real health entry point", async () => {
    const root = tempDirs.make("openclaw-gateway-auth-json-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const port = await getFreePort();
    await fs.mkdir(stateDir, { recursive: true });

    const result = await runIsolatedGatewayCli({
      args: ["health", "--json", "--timeout", "250"],
      root,
      stateDir,
      configPath,
      env: { OPENCLAW_GATEWAY_PORT: String(port) },
    });

    expect(result, result.stderr).toMatchObject({ code: 1, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        type: "gateway_credentials_required",
        message: expect.stringContaining("requires"),
      },
    });
  });

  it("preserves pre-hello rate-limit details through the real health entry point", async () => {
    const root = tempDirs.make("openclaw-gateway-rate-limit-json-");
    const gateway = await startRateLimitedGateway();
    const { stateDir, configPath } = await prepareGatewayCliFixture(root, {
      mode: "remote",
      remote: { url: gateway.url, token: "test-token" },
    });

    const result = await runIsolatedGatewayCli({
      args: ["health", "--json", "--timeout", "2000"],
      root,
      stateDir,
      configPath,
    });

    expect(result, result.stderr).toMatchObject({ code: 1, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        type: "gateway_request_error",
        code: "AUTH_RATE_LIMITED",
        message:
          "Gateway authentication is temporarily rate-limited. Wait for the temporary lockout to expire, then retry.",
        retryable: true,
        retryAfterMs: 60_000,
      },
      gateway: { reachable: true },
    });
    expect(result.stdout).not.toContain("gateway.remote.token");
    expect(result.stdout).not.toContain("devices rotate");
  });
});
