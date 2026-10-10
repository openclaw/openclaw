import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readLatestConfigSnapshotAuditRecordAsync } from "../config/config-journal-snapshot.js";
import * as configStateMutations from "../config/config-state-mutation.js";
import { readRecentConfigAuditRecords } from "../config/io.audit.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import { configStateMutationHandler } from "../gateway/server-methods/config-state-mutation.js";
import {
  createSessionMutationTestClient,
  createSessionMutationTestContext,
} from "../gateway/server-methods/sessions-mutations.owner.test-support.js";
import { acquireGatewayLock, type GatewayLockHandle } from "../infra/gateway-lock.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { StartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { localStateOwnerFixtureEntrypoint } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const roots = useAutoCleanupTempDirTracker(afterAll);
const entrypoint = resolveRuntimeWorkerArgv(
  resolveRuntimeWorkerUrl(localStateOwnerFixtureEntrypoint),
);
const token = "synthetic-config-owner-token";

describe("config CLI database effects", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let owner: GatewayLockHandle | null;
  let claim: TestPortClaim;
  let server: WebSocketServer;
  const mutations: string[] = [];
  const failures: unknown[] = [];

  async function fixture(home: string, port: number) {
    const stateDir = path.join(home, "state");
    const configPath = path.join(home, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ gateway: { mode: "local", port, auth: { mode: "token", token } } }),
    );
    return {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
    };
  }

  beforeAll(async () => {
    root = roots.make("openclaw-config-owner-");
    claim = await acquireTestPortBlock({ offsets: [0] });
    env = await fixture(root, claim.port);
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", env.OPENCLAW_CONFIG_PATH);
    owner = await acquireGatewayLock({ env, port: claim.port, allowInTests: true, timeoutMs: 0 });
    expect(owner).not.toBeNull();
    openOpenClawStateDatabase({ env });
    const context = createSessionMutationTestContext({});
    const client = createSessionMutationTestClient();
    client.connect.scopes = ["operator.admin"];
    server = new WebSocketServer({ host: "127.0.0.1", port: claim.port });
    server.on("connection", (ws) => {
      let authenticated = false;
      sendMinimalGatewayConnectChallenge(ws);
      ws.on("message", (data) => {
        void (async () => {
          const frame = parseMinimalGatewayRequestFrame(data);
          if (!frame.id) {
            return;
          }
          if (frame.method === "connect") {
            authenticated = frame.params?.auth?.token === token;
            expect(authenticated).toBe(true);
            const hello = buildMinimalGatewayHelloOkPayload({
              methods: ["config.state.mutate"],
              auth: { role: "operator", scopes: ["operator.admin"] },
              snapshot: { stateDir: env.OPENCLAW_STATE_DIR, configPath: env.OPENCLAW_CONFIG_PATH },
            });
            sendMinimalGatewayResponse(ws, frame.id, {
              ...hello,
              features: { ...hello.features, capabilities: Object.values(GATEWAY_SERVER_CAPS) },
            });
            return;
          }
          expect(frame.method).toBe("config.state.mutate");
          await configStateMutationHandler({
            req: { type: "req", id: frame.id, method: frame.method!, params: frame.params },
            params: frame.params ?? {},
            client,
            context,
            isWebchatConnect: () => false,
            hasCurrentClientAuthority: () => authenticated,
            respond: (ok, payload, error) => {
              if (ok) {
                mutations.push(
                  configStateMutations.configStateMutationSchema.parse(frame.params?.mutation).kind,
                );
              }
              ws.send(JSON.stringify({ type: "res", id: frame.id, ok, payload, error }));
            },
          });
        })().catch((error: unknown) => {
          failures.push(error);
          ws.close(1011, "fixture failure");
        });
      });
    });
    await once(server, "listening");
  });
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", env.OPENCLAW_CONFIG_PATH);
  });
  afterAll(async () => {
    await closeMinimalGatewayServer(server);
    await closeOpenClawStateDatabaseAsync();
    await owner?.release();
    await claim.release();
    vi.unstubAllEnvs();
    expect(failures).toEqual([]);
  });

  async function verifyWrites(target: NodeJS.ProcessEnv, home: string) {
    const raw = await fs.readFile(target.OPENCLAW_CONFIG_PATH!, "utf8");
    expect(JSON.parse(raw).logging.level).toBe("warn");
    expect(
      await readLatestConfigSnapshotAuditRecordAsync({ env: target, homedir: () => home }),
    ).toMatchObject({ rawHash: hashConfigRaw(raw) });
    expect(readRecentConfigAuditRecords({ env: target, homedir: () => home, limit: 20 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "config.write", result: "rename" }),
      ]),
    );
    expect(readConfigMachineState("config.lastTouchedAt", { env: target })).toEqual(
      expect.any(String),
    );
  }

  it("routes real CLI writes to the serving owner and its next read sees the receipts", async () => {
    expect(await readLatestConfigSnapshotAuditRecordAsync({ env })).toBeNull();
    const result = await runCliProcessChild({
      nodeArgs: [...entrypoint, "config", "set", "logging.level", "warn"],
      env,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(mutations).toEqual(expect.arrayContaining(["audit", "metadata", "snapshot"]));
    await verifyWrites(env, root);
  });

  it("keeps the same config write working under exclusive offline ownership", async () => {
    const home = roots.make("openclaw-config-offline-");
    const offline = await fixture(home, claim.port);
    const result = await runCliProcessChild({
      nodeArgs: [...entrypoint, "config", "set", "logging.level", "warn"],
      env: offline,
    });
    expect(result.code, result.stderr).toBe(0);
    await verifyWrites(offline, home);
  });

  it.each([
    {
      name: "propagates maintenance failures instead of treating them as best-effort health writes",
      failure: new StartupMaintenanceRequiredError(
        "newer-schema",
        "The owning Gateway requires a newer OpenClaw build for config health state.",
      ),
      initialLevel: "debug",
      exitCode: 1,
    },
    {
      name: "preserves the owner's ordinary health warning while completing the config write",
      failure: new Error("The owning Gateway could not write config health state."),
      initialLevel: "trace",
      exitCode: 0,
    },
  ])("$name", async ({ failure, initialLevel, exitCode }) => {
    const configPath = env.OPENCLAW_CONFIG_PATH!;
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.logging = { level: initialLevel };
    const before = JSON.stringify(config);
    await fs.writeFile(configPath, before);
    const firstMutation = mutations.length;
    const apply = configStateMutations.applyConfigStateMutation;
    const rejection = vi
      .spyOn(configStateMutations, "applyConfigStateMutation")
      .mockImplementation(async (mutation, ...args) => {
        if (mutation.kind === "health") {
          throw failure;
        }
        return await apply(mutation, ...args);
      });
    try {
      const result = await runCliProcessChild({
        nodeArgs: [...entrypoint, "config", "set", "logging.level", "info"],
        env,
      });
      expect(rejection.mock.calls.some(([mutation]) => mutation.kind === "health")).toBe(true);
      expect(result.code, result.stderr).toBe(exitCode);
      expect(result.stderr).toContain(failure.message);
      expect(result.stderr).not.toContain("Gateway owning");
      expect(mutations.slice(firstMutation)).not.toContain("health");
      if (exitCode === 1) {
        expect(result.stderr).not.toContain("Config health-state write failed:");
        expect(await fs.readFile(configPath, "utf8")).toBe(before);
      } else {
        expect(result.stderr).toContain(`Config health-state write failed: ${failure.message}`);
        expect(JSON.parse(await fs.readFile(configPath, "utf8")).logging.level).toBe("info");
      }
    } finally {
      rejection.mockRestore();
    }
  });
});
