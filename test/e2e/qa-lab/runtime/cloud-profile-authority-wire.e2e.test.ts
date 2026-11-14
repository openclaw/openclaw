import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  ResponseFrameSchema,
  type ResponseFrame,
} from "../../../../packages/gateway-protocol/src/schema/frames.js";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { reserveTestPortListener } from "../../../../src/test-utils/port-claims.js";
import { readBuildIdFromBuildInfoForModuleUrl } from "../../../../src/version.js";
import {
  acquireGatewayTestWebSocket,
  closeGatewayTestWebSocket,
} from "../../../helpers/gateway-websocket.js";
import { createOpenClawTestInstance } from "../../../helpers/openclaw-test-instance.js";
import { awaitGateBeforeSettlement, withinTest } from "../../../helpers/promise.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  closeWireServer,
  createPublishedWireWorkspace,
} from "./paired-node-worker-wire-fixture.js";

type Reply = Omit<ResponseFrame, "payload"> & { payload?: Record<string, unknown> };
function request(
  ws: WebSocket,
  method: string,
  params: unknown,
  signal: AbortSignal,
): Promise<Reply> {
  const id = randomUUID();
  const response = createDeferredCore<Reply>();
  const receive = (raw: Buffer) => {
    const frame: unknown = JSON.parse(raw.toString());
    if (Value.Check(ResponseFrameSchema, frame) && frame.id === id) {
      response.resolve({ ...frame, payload: isRecord(frame.payload) ? frame.payload : undefined });
    }
  };
  const closed = () => response.reject(new Error("Proof connection closed before " + method));
  ws.on("message", receive);
  ws.once("close", closed);
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return withinTest(response.promise, signal).finally(() => {
    ws.off("message", receive);
    ws.off("close", closed);
  });
}

// Built Gateway + shipped Crabbox plugin/process transport; the executable is synthetic.
// A successful warmup invocation is the physical effect oracle. It then refuses intentionally:
// this does NOT prove a commercial allocation, node enrollment, or post-allocation setup.
it(
  "P6 fences shipped provider command transport with live profile grants",
  { timeout: 240_000 },
  async ({ signal }) => {
    const buildId = readBuildIdFromBuildInfoForModuleUrl(
      new URL("../../../../dist/index.js", import.meta.url).href,
    );
    expect(buildId, "the test client must identify the actual built Gateway artifact").toBeTruthy();
    let holdPreparation = false;
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const commands: string[][] = [];
    const reserved = await reserveTestPortListener({
      offsets: [0],
      signal,
      createListener: () =>
        createServer((req, res) => {
          void (async () => {
            if (req.method !== "POST" || req.url !== "/command") {
              res.writeHead(404).end();
              return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(Buffer.from(chunk));
            }
            const args: string[] = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            commands.push(args);
            let result = { code: 0, stdout: "", stderr: "" };
            if (args[0] === "--version") {
              result.stdout = "crabbox 0.80.0";
            } else if (args[0] === "providers") {
              result.stdout = "[]";
            } else if (args[0] === "config") {
              if (holdPreparation) {
                entered.resolve();
                await release.promise;
              }
              result.stdout = JSON.stringify({ aws: { instanceProfile: "" } });
            } else if (args[0] === "warmup") {
              result = { code: 1, stdout: "", stderr: "P6_SYNTHETIC_WARMUP_BOUNDARY" };
            } else if (args[0] === "inspect" || args[0] === "stop") {
              const id = args[args.indexOf("--id") + 1];
              result = { code: 4, stdout: "", stderr: "aws instance not found: " + id };
            } else {
              result = { code: 1, stdout: "", stderr: "Unexpected synthetic command: " + args[0] };
            }
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
          })().catch((error: unknown) => {
            res.writeHead(500).end(String(error));
          });
        }),
    });
    const profile = "p6-provider-wire-proof";
    const password = "synthetic-p6-local-owner";
    const instance = await createOpenClawTestInstance({
      name: profile,
      signal,
      entrypoint: ["dist/index.js", "--profile", profile],
      env: {
        OPENCLAW_PROFILE: profile,
        OPENCLAW_NO_AUTO_UPDATE: "1",
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
      config: {
        gateway: {
          mode: "local",
          // Synthetic advertised metadata only: warmup deliberately fails before enrollment.
          // No request contacts this origin, and this proof makes no reachability claim.
          publicOrigin: "https://gateway.example.test",
          trustedProxies: ["127.0.0.1"],
          auth: {
            mode: "trusted-proxy",
            password,
            identityScopes: {
              "writer@example.test": ["operator.read", "operator.write"],
              "foreign@example.test": ["operator.read", "operator.write"],
            },
            trustedProxy: { userHeader: "x-p6-email", allowLoopback: true },
          },
          roles: {
            default: "engineer",
            definitions: {
              engineer: {
                sessions: { others: "write" },
                agents: ["main"],
                scopes: ["operator.read", "operator.write"],
                workerProfiles: ["test"],
              },
            },
          },
        },
        agents: { defaults: { model: { primary: "anthropic/claude-test" } } },
        cron: { enabled: false },
        plugins: { enabled: true, allow: ["crabbox"], entries: { crabbox: { enabled: true } } },
      },
      startTimeoutMs: 90_000,
      stopTimeoutMs: 15_000,
    });
    const sockets: WebSocket[] = [];
    const binary = instance.state.path("synthetic-crabbox.mjs");
    await fs.writeFile(
      binary,
      [
        "#!" + process.execPath,
        "const response = await fetch(" +
          JSON.stringify("http://127.0.0.1:" + reserved.claim.port + "/command") +
          ", { method: 'POST', body: JSON.stringify(process.argv.slice(2)) });",
        "const result = await response.json(); process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.code;",
      ].join("\n"),
      { mode: 0o755 },
    );
    const published = await createPublishedWireWorkspace(instance.state.path("repository"));
    const config = JSON.parse(await fs.readFile(instance.configPath, "utf8"));
    // Writers may select only an admitted agent workspace, not an arbitrary Gateway path.
    config.agents.defaults.workspace = published.source;
    config.cloudWorkers = {
      profiles: {
        test: {
          provider: "crabbox",
          settings: { provider: "aws", binary, warmImage: false, ttl: "60m", idleTimeout: "10m" },
        },
        other: {
          provider: "crabbox",
          settings: { provider: "aws", binary, warmImage: false, ttl: "60m", idleTimeout: "10m" },
        },
      },
    };
    // The generic test instance defaults to token auth; this fixture uses proxy identities
    // and the supported local password owner, never both token and trusted-proxy auth.
    delete config.gateway.auth.token;
    config.gateway.controlUi = {
      enabled: false,
      allowedOrigins: ["http://127.0.0.1:" + instance.port],
    };
    config.logging = { file: instance.state.path("gateway.log") };
    await instance.state.writeConfig(config);
    instance.env.OPENCLAW_GATEWAY_PORT = String(instance.port);
    const connect = async (email?: string) => {
      const ws = new WebSocket(
        "ws://127.0.0.1:" + instance.port,
        email
          ? {
              headers: {
                "x-p6-email": email,
                "x-forwarded-for": "203.0.113.42",
                "x-forwarded-proto": "http",
                "x-forwarded-host": "127.0.0.1:" + instance.port,
                origin: "http://127.0.0.1:" + instance.port,
              },
            }
          : undefined,
      );
      sockets.push(ws);
      await acquireGatewayTestWebSocket(ws, 10_000);
      const hello = await request(
        ws,
        "connect",
        {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: email ? "openclaw-control-ui" : "cli",
            version: "1",
            buildId: buildId ?? undefined,
            platform: "test",
            mode: email ? "webchat" : "cli",
          },
          role: "operator",
          scopes: email ? ["operator.read", "operator.write"] : ["operator.admin"],
          ...(email ? {} : { auth: { password } }),
        },
        signal,
      );
      expect(hello.ok, JSON.stringify(hello)).toBe(true);
      return ws;
    };
    const warmups = () => commands.filter((args) => args[0] === "warmup").length;
    await runQaGatewayFixture(
      async () => {
        await instance.startGateway();
        const owner = await connect();
        const writer = await connect("writer@example.test");
        const foreign = await connect("foreign@example.test");
        for (const [key, client] of [
          ["allowed", writer],
          ["revoked", writer],
          ["foreign", foreign],
        ] as const) {
          const made = await request(
            client,
            "sessions.create",
            {
              key: "agent:main:p6-" + key,
              agentId: "main",
              worktree: true,
              worktreeName: "p6-" + key,
              worktreeBaseRef: "main",
              cwd: published.source,
            },
            signal,
          );
          expect(made.ok, JSON.stringify(made)).toBe(true);
        }
        for (const [key, profileId] of [
          ["foreign", "test"],
          ["allowed", "other"],
        ]) {
          const denied = await request(
            writer,
            "sessions.dispatch",
            { key: "agent:main:p6-" + key, profileId },
            signal,
          );
          console.log(
            "P6_PROVIDER_WIRE_DENIED " +
              JSON.stringify({ key, profileId, code: denied.error?.code, warmups: warmups() }),
          );
          expect(denied.error?.code).toBe("FORBIDDEN");
          expect(warmups()).toBe(0);
        }
        const deniedWarmups = warmups();
        const allowed = await request(
          writer,
          "sessions.dispatch",
          { key: "agent:main:p6-allowed", profileId: "test" },
          signal,
        );
        const allowedWarmups = warmups();
        console.log(
          "P6_PROVIDER_WIRE_ALLOWED " +
            JSON.stringify({
              warmups: allowedWarmups,
              commands: commands.map((args) => args[0]),
              error: allowed.error,
            }),
        );
        expect(allowedWarmups, JSON.stringify(allowed) + instance.logs()).toBe(1);
        expect(allowed.error?.message).toContain("P6_SYNTHETIC_WARMUP_BOUNDARY");
        holdPreparation = true;
        const pending = request(
          writer,
          "sessions.dispatch",
          { key: "agent:main:p6-revoked", profileId: "test" },
          signal,
        );
        try {
          await awaitGateBeforeSettlement(
            entered.promise,
            pending,
            "dispatch ended before provider preparation",
          );
          const snapshot = await request(owner, "config.get", {}, signal);
          const patched = await request(
            owner,
            "config.patch",
            {
              baseHash: snapshot.payload?.hash,
              raw: JSON.stringify({
                gateway: { roles: { definitions: { engineer: { workerProfiles: [] } } } },
              }),
              replacePaths: ["gateway.roles.definitions.engineer.workerProfiles"],
            },
            signal,
          );
          expect(patched.ok, JSON.stringify(patched)).toBe(true);
          const catalog = await request(
            writer,
            "environments.list",
            { projection: "profiles" },
            signal,
          );
          expect(catalog.payload?.dispatchableProfileIds).toEqual([]);
          release.resolve();
          const revoked = await pending;
          expect(revoked.error?.code).toBe("FORBIDDEN");
          expect(warmups()).toBe(1);
          expect(commands.filter((args) => ["run", "exec"].includes(args[0]!))).toEqual([]);
          console.log(
            "P6_PROVIDER_WIRE " +
              JSON.stringify({
                gatewayPid: instance.child?.pid,
                adapter: "shipped-crabbox",
                executable: "synthetic-loopback",
                allowedWarmups,
                deniedWarmups,
                revokedWarmups: warmups() - allowedWarmups,
                setupCommands: commands.filter((args) => ["run", "exec"].includes(args[0]!)).length,
                commercialAllocation: false,
                advertisedOrigin: "https://gateway.example.test",
                advertisedOriginSyntheticAndUnused: true,
                enrollmentOrReachabilityProven: false,
              }),
          );
        } finally {
          release.resolve();
          await pending;
        }
      },
      async () => {
        release.resolve();
        await Promise.all(sockets.map(closeGatewayTestWebSocket));
        await instance.cleanup();
      },
      () => closeWireServer(published.server),
      async () => {
        await closeWireServer(reserved.listener);
        await reserved.claim.release();
      },
    );
  },
);
