import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HelloOk } from "../../../packages/gateway-protocol/src/schema/frames.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import { callGatewayFromCliRuntime } from "../../cli/gateway-rpc.runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity, type DeviceIdentity } from "../../infra/device-identity.js";
import type { SqliteWalHealth } from "../../infra/sqlite-wal-checkpoint.js";
import { readOpenClawStateWalHealth } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureEnv } from "../../test-utils/env.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { GatewayClient } from "../client.js";
import { GatewayStartupCleanupError } from "../server-shutdown.js";
import { startGatewayServer } from "../server.js";
import { connectGatewayClient, disconnectGatewayClient } from "../test-helpers.e2e.js";
import { reserveGatewayTestListener } from "../test-helpers.listener.js";
import {
  configureManualGatewayBackgroundEnv,
  MANUAL_GATEWAY_ENV_KEYS,
} from "../test-helpers.manual-gateway-env.js";

const METHOD = "status.sqliteWal";
const TOKEN = "cached-wal-real-rpc-synthetic-token";
type Observation = Pick<
  SqliteWalHealth,
  | "state"
  | "observedAtMs"
  | "walBytes"
  | "databaseBytes"
  | "logFrames"
  | "checkpointedFrames"
  | "lastCompletedAtMs"
  | "consecutiveBlocked"
  | "warning"
>;
type Snapshot = {
  kind: string;
  scope: string;
  pid: number;
  readAtMs: number;
  available: boolean;
  observation: Observation | null;
};

describe("cached WAL over the real authenticated Gateway", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
  let listener: Awaited<ReturnType<typeof reserveGatewayTestListener>> | undefined;
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let reader: GatewayClient | undefined;
  let identity: DeviceIdentity;
  let config: OpenClawConfig;
  let hello: HelloOk | undefined;
  let recorded: SqliteWalHealth | undefined;
  let native: ReturnType<typeof requireNativeSqliteDatabase>;
  let startup: Promise<void> | undefined;
  let cleanupVerified = true;
  let environment: ReturnType<typeof captureEnv> | undefined;

  beforeAll(async () => {
    environment = captureEnv([
      ...MANUAL_GATEWAY_ENV_KEYS,
      "OPENCLAW_TEST_MINIMAL_GATEWAY",
      "OPENCLAW_GATEWAY_URL",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
    ]);
    state = await createOpenClawTestState({
      label: "cached-wal-real-rpc",
      layout: "home",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        OPENCLAW_GATEWAY_URL: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
      },
    });
    configureManualGatewayBackgroundEnv(state.home);
    config = {
      gateway: {
        mode: "local",
        auth: { mode: "token", token: TOKEN },
        controlUi: { enabled: false },
        reload: { mode: "off" },
      },
      agents: { defaults: { workspace: state.workspaceDir } },
      plugins: { enabled: false },
      cron: { enabled: false },
      hooks: { enabled: false },
      discovery: { mdns: { mode: "off" } },
      logging: { file: state.path("gateway.log"), level: "silent", consoleLevel: "silent" },
    };
    await state.writeConfig(config);
    state.applyEnv();
    listener = await reserveGatewayTestListener();
    startup = listener
      .start(async () => {
        server = await startGatewayServer(listener!.port, {
          bind: "loopback",
          auth: { mode: "token", token: TOKEN },
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        await server.startupSettled;
      })
      .catch((error: unknown) => {
        if (error instanceof GatewayStartupCleanupError) {
          cleanupVerified = false;
        }
        throw error;
      });
    await startup;
    identity = loadOrCreateDeviceIdentity({
      path: state.statePath("client", "credentials.sqlite"),
    });
    reader = await connectGatewayClient({
      url: `ws://127.0.0.1:${listener.port}`,
      token: TOKEN,
      deviceIdentity: identity,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
      role: "operator",
      scopes: ["operator.read"],
      timeoutMs: 10_000,
      requestTimeoutMs: 5_000,
      onHelloOk: (value) => {
        hello = value;
      },
    });
    // Real synthetic setup records a native observation. The RPC does no checkpointing.
    const owner = openOpenClawStateDatabase();
    expect(owner.path).toBe(resolveOpenClawStateSqlitePath());
    expect(owner.walMaintenance.checkpoint()).toBe(true);
    // Minimal Gateway disables sidecars; this separate native timer also belongs to the fixture.
    await owner.walMaintenance.stop();
    recorded = readOpenClawStateWalHealth();
    expect(recorded?.state).toBe("complete");
    native = requireNativeSqliteDatabase(owner.db);
  }, 60_000);

  afterAll(async () => {
    await runQaGatewayFixture(
      async () => {
        await startup?.catch(() => undefined);
      },
      async () => {
        if (reader) {
          await disconnectGatewayClient(reader);
          expect(reader.connected).toBe(false);
        }
      },
      async () => {
        if (server) {
          cleanupVerified = false;
          await server.close({ reason: "cached WAL real RPC proof complete" });
          cleanupVerified = true;
        }
      },
      async () => {
        if (!cleanupVerified) {
          throw new Error("Gateway cleanup unverified; retaining the synthetic state and claim");
        }
        await listener?.closeUnadopted();
        expect(listener?.listener.listening ?? false).toBe(false);
        await state?.cleanup();
        if (state) {
          await expect(fs.access(state.root)).rejects.toMatchObject({ code: "ENOENT" });
        }
        environment?.restore();
      },
    );
  }, 60_000);

  function expectRecordedObservation(snapshot: Snapshot) {
    expect(Object.keys(snapshot).toSorted()).toEqual([
      "available",
      "kind",
      "observation",
      "pid",
      "readAtMs",
      "scope",
    ]);
    expect(snapshot).toMatchObject({
      kind: "cached-sqlite-wal.v1",
      scope: "canonical-shared-cache",
      pid: process.pid,
      available: recorded !== undefined,
    });
    expect(Number.isFinite(snapshot.readAtMs)).toBe(true);
    expect(snapshot.observation).toEqual(
      recorded === undefined
        ? null
        : {
            state: recorded.state,
            observedAtMs: recorded.observedAtMs,
            walBytes: recorded.walBytes,
            databaseBytes: recorded.databaseBytes,
            logFrames: recorded.logFrames,
            checkpointedFrames: recorded.checkpointedFrames,
            lastCompletedAtMs: recorded.lastCompletedAtMs,
            consecutiveBlocked: recorded.consecutiveBlocked,
            warning: recorded.warning,
          },
    );
  }

  it("serves operator.read through real HELLO/auth/router without SQL and rejects target params", async () => {
    expect(hello?.auth).toMatchObject({ role: "operator", scopes: ["operator.read"] });
    expect(hello?.features.methods).toContain(METHOD);
    using prepare = vi.spyOn(native, "prepare");
    using exec = vi.spyOn(native, "exec");
    expectRecordedObservation(await reader!.request<Snapshot>(METHOD, {}));
    await expect(reader!.request(METHOD, { path: "not-an-allowed-target" })).rejects.toMatchObject({
      gatewayCode: "INVALID_REQUEST",
      message: "expected empty params",
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(readOpenClawStateWalHealth()).toEqual(recorded);
  });

  it("reads the advertised method through the actual CLI facade without status fallback", async () => {
    // Observe real sends; do not replace the facade, transport, handler or cached getter.
    using requests = vi.spyOn(GatewayClient.prototype, "request");
    const result = await callGatewayFromCliRuntime<Snapshot>(
      METHOD,
      {
        url: `ws://127.0.0.1:${listener!.port}`,
        token: TOKEN,
        config,
        json: true,
        timeout: "5000",
      },
      {},
      {
        deviceIdentity: identity,
        sharedStateMode: "read-only",
        scopes: ["operator.read"],
        progress: false,
      },
    );
    expectRecordedObservation(result);
    expect(requests.mock.calls.map(([method]) => method)).toEqual([METHOD]);
    expect(readOpenClawStateWalHealth()).toEqual(recorded);
  });
});
