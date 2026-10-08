import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import { channelPairingHandlers } from "../gateway/server-methods/channel-pairing.js";
import { execApprovalsHandlers } from "../gateway/server-methods/exec-approvals.js";
import {
  createSessionMutationTestClient,
  createSessionMutationTestContext,
} from "../gateway/server-methods/sessions-mutations.owner.test-support.js";
import {
  readExecApprovalsSnapshot,
  restoreExecApprovalsSnapshotLocked,
  updateExecApprovals,
} from "../infra/exec-approvals.js";
import {
  acquireGatewayLock,
  resolveGatewayLockPaths,
  type GatewayLockHandle,
} from "../infra/gateway-lock.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { sqliteWorkerPreloadEnv } from "../infra/sqlite-worker-preload.test-support.js";
import {
  readChannelPairingStateSnapshot,
  writeChannelPairingStateSnapshot,
} from "../pairing/pairing-store-sqlite.test-helpers.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { writeAdminStateOwnerObservationPreload } from "./admin-state-owner.observation.test-support.js";
import { adminStateOwnerFixtureEntrypoint } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const roots = useAutoCleanupTempDirTracker(afterAll);
const entrypoint = resolveRuntimeWorkerArgv(
  resolveRuntimeWorkerUrl(adminStateOwnerFixtureEntrypoint),
);
const token = "synthetic-admin-routing-token";
const channel = "routing-fixture";
const pattern = "/usr/bin/routing-fixture";
const operations = [
  {
    kind: "pairing-list",
    method: "channels.pairing.list",
    capability: GATEWAY_SERVER_CAPS.CHANNELS_PAIRING_LIST_OWNER,
    args: ["pairing", "list", channel, "--json"],
  },
  {
    kind: "pairing-approve",
    method: "channels.pairing.approve",
    capability: GATEWAY_SERVER_CAPS.CHANNELS_PAIRING_APPROVE_OWNER,
    args: ["pairing", "approve", channel, "ABCDEFGH"],
  },
  {
    kind: "approvals-get",
    method: "exec.approvals.get",
    capability: GATEWAY_SERVER_CAPS.EXEC_APPROVALS_GET_OWNER,
    args: ["approvals", "get", "--json"],
  },
  {
    kind: "approvals-set",
    method: "exec.approvals.set",
    capability: GATEWAY_SERVER_CAPS.EXEC_APPROVALS_SET_OWNER,
    args: ["approvals", "set", "--stdin", "--json"],
  },
  {
    kind: "allowlist-add",
    method: "exec.approvals.set",
    capability: GATEWAY_SERVER_CAPS.EXEC_APPROVALS_SET_OWNER,
    args: ["approvals", "allowlist", "add", pattern, "--json"],
  },
  {
    kind: "allowlist-remove",
    method: "exec.approvals.set",
    capability: GATEWAY_SERVER_CAPS.EXEC_APPROVALS_SET_OWNER,
    args: ["approvals", "allowlist", "remove", pattern, "--json"],
  },
] as const;
type Scenario = "live" | "offline" | "missing-capability" | "refused" | "lost-reply";

describe("administrative CLI state owner routing", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let claim: TestPortClaim;
  let owner: GatewayLockHandle | null;
  let server: WebSocketServer;
  let scenario: Scenario = "live";
  let selectedMethod: string;
  let missingCapability: string | undefined;
  let missingApprovals: ReturnType<typeof readExecApprovalsSnapshot>;
  const methods: string[] = [];
  const failures: unknown[] = [];

  beforeAll(async () => {
    root = roots.make("openclaw-admin-owner-");
    claim = await acquireTestPortBlock({ offsets: [0] });
    env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
    };
    const preloadPath = await writeAdminStateOwnerObservationPreload(
      root,
      resolveGatewayLockPaths(env).ownerLockPath,
    );
    Object.assign(env, sqliteWorkerPreloadEnv(preloadPath));
    const cfg = {
      gateway: {
        mode: "local" as const,
        port: claim.port,
        auth: { mode: "token" as const, token },
      },
      commands: { ownerAllowFrom: ["telegram:123"] },
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH!, JSON.stringify(cfg));
    for (const key of ["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "HOME", "USERPROFILE"]) {
      vi.stubEnv(key, env[key]);
    }
    owner = await acquireGatewayLock({ env, port: claim.port, allowInTests: true, timeoutMs: 0 });
    expect(owner).not.toBeNull();
    missingApprovals = readExecApprovalsSnapshot();
    expect(missingApprovals.exists).toBe(false);
    const handlers = { ...channelPairingHandlers, ...execApprovalsHandlers };
    const client = createSessionMutationTestClient();
    client.connect.scopes = ["operator.admin"];
    const context = createSessionMutationTestContext(cfg);
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
              methods: Object.keys(handlers),
              auth: { role: "operator", scopes: ["operator.admin"] },
              snapshot: { stateDir: env.OPENCLAW_STATE_DIR, configPath: env.OPENCLAW_CONFIG_PATH },
            });
            sendMinimalGatewayResponse(ws, frame.id, {
              ...hello,
              features: {
                ...hello.features,
                capabilities: Object.values(GATEWAY_SERVER_CAPS).filter(
                  (capability) => capability !== missingCapability,
                ),
              },
            });
            return;
          }
          expect(authenticated).toBe(true);
          const method = frame.method!;
          methods.push(method);
          await handlers[method]!({
            req: { type: "req", id: frame.id, method, params: frame.params },
            params: {
              ...frame.params,
              ...(scenario === "refused" && method === selectedMethod
                ? { expectedOwnerId: "retired-owner" }
                : {}),
            },
            client,
            context,
            isWebchatConnect: () => false,
            hasCurrentClientAuthority: () => authenticated,
            respond: (ok, payload, error) => {
              if (scenario === "lost-reply" && method === selectedMethod && ok) {
                ws.close(1011, "fixture dropped acknowledgement");
              } else {
                ws.send(JSON.stringify({ type: "res", id: frame.id, ok, payload, error }));
              }
            },
          });
        })().catch((error: unknown) => {
          failures.push(error);
          ws.terminate();
        });
      });
    });
    await once(server, "listening");
  });

  beforeEach(() => {
    for (const key of ["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "HOME", "USERPROFILE"]) {
      vi.stubEnv(key, env[key]);
    }
    scenario = "live";
    missingCapability = undefined;
    methods.length = 0;
  });

  afterAll(async () => {
    await closeMinimalGatewayServer(server);
    await closeOpenClawStateDatabaseAsync();
    await owner?.release();
    await claim.release();
    vi.unstubAllEnvs();
    expect(failures).toEqual([]);
  });

  it.each(
    operations.flatMap((operation) => {
      const scenarios: Scenario[] = ["live", "offline", "missing-capability"];
      if (["pairing-list", "pairing-approve", "approvals-set"].includes(operation.kind)) {
        scenarios.push("refused", "lost-reply");
      }
      return scenarios.map((mode) => Object.assign({}, operation, { mode }));
    }),
  )("$kind: $mode preserves state and never replays a routed operation", async (operation) => {
    scenario = operation.mode;
    selectedMethod = operation.method;
    if (scenario === "missing-capability") {
      missingCapability = operation.capability;
    }
    const now = new Date().toISOString();
    writeChannelPairingStateSnapshot(channel, {
      version: 1,
      requests: [
        { id: "sender", code: "ABCDEFGH", createdAt: now, lastSeenAt: now },
        { id: "expired", code: "JKLMNPQR", createdAt: "2000-01-01T00:00:00.000Z", lastSeenAt: now },
      ],
    });
    await updateExecApprovals({
      update: () => ({
        version: 1,
        agents: {
          "*": { allowlist: operation.kind === "allowlist-remove" ? [{ pattern }] : [] },
        },
      }),
    });
    if (scenario === "offline") {
      await closeOpenClawStateDatabaseAsync();
      await owner?.release();
      owner = null;
    }
    const result = await runCliProcessChild({
      nodeArgs: [...entrypoint, ...operation.args],
      env,
      // Default CLI saves have always normalized legacy string allowlist entries.
      input: JSON.stringify({ version: 1, agents: { "*": { allowlist: [pattern] } } }),
    });
    if (!owner) {
      owner = await acquireGatewayLock({ env, port: claim.port, allowInTests: true, timeoutMs: 0 });
      expect(owner).not.toBeNull();
    }
    const observation = JSON.parse(
      await fs.readFile(path.join(root, "control", "sql-observation.json"), "utf8"),
    );
    const succeeded = scenario === "live" || scenario === "offline";
    expect(result.code, result.stderr).toBe(succeeded ? 0 : 1);
    if (scenario === "offline") {
      expect(observation.adminSql).toBeGreaterThan(0);
      if (operation.kind.startsWith("pairing-")) {
        expect(observation.workerSql).toBeGreaterThan(0);
      }
      expect(observation).toMatchObject({ missingCustody: 0, ownerPids: [observation.pid] });
      expect(methods).toEqual([]);
    } else {
      expect(observation.adminSql).toBe(0);
      const prefix = operation.method === "exec.approvals.set" ? ["exec.approvals.get"] : [];
      expect(methods).toEqual(
        scenario === "missing-capability" ? prefix : [...prefix, operation.method],
      );
    }
    if (scenario === "missing-capability") {
      expect(result.stderr).toContain(operation.capability);
      expect(result.stderr).toContain("Update the Gateway");
    }
    if (scenario === "refused") {
      expect(result.stderr).toContain("No local mutation was attempted");
    }
    if (scenario === "lost-reply") {
      expect(result.stderr).toContain("outcome may be partial");
    }
    const applied = succeeded || scenario === "lost-reply";
    const pairing = readChannelPairingStateSnapshot(channel);
    if (operation.kind.startsWith("pairing-")) {
      expect(pairing.requests.map((request) => request.id).toSorted()).toEqual(
        applied ? (operation.kind === "pairing-list" ? ["sender"] : []) : ["expired", "sender"],
      );
      expect(pairing.allowFrom?.default ?? []).toEqual(
        applied && operation.kind === "pairing-approve" ? ["sender"] : [],
      );
      if (succeeded && operation.kind === "pairing-list") {
        expect(JSON.parse(result.stdout)).toMatchObject({
          channel,
          requests: [{ code: "ABCDEFGH" }],
        });
      }
      if (succeeded && operation.kind === "pairing-approve") {
        expect(result.stdout).toContain(`Approved ${channel} sender sender.`);
      }
    } else {
      const expected =
        operation.kind === "allowlist-remove"
          ? !applied
          : applied && operation.kind !== "approvals-get";
      const snapshot = readExecApprovalsSnapshot();
      expect(snapshot.file.agents?.["*"]?.allowlist?.map((entry) => entry.pattern) ?? []).toEqual(
        expected ? [pattern] : [],
      );
      if (succeeded) {
        expect(JSON.parse(result.stdout)).toMatchObject({ exists: true, hash: snapshot.hash });
      }
    }
  });

  it("keeps an unstored default policy absent when a live owner serves approvals get", async () => {
    const current = readExecApprovalsSnapshot();
    expect(await restoreExecApprovalsSnapshotLocked(missingApprovals, current.hash)).toBe(true);
    const result = await runCliProcessChild({
      nodeArgs: [...entrypoint, "approvals", "get", "--json"],
      env,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ exists: false, hash: missingApprovals.hash });
    expect(readExecApprovalsSnapshot()).toMatchObject({ exists: false, raw: null });
    expect(methods).toEqual(["exec.approvals.get"]);
    expect(
      JSON.parse(await fs.readFile(path.join(root, "control", "sql-observation.json"), "utf8"))
        .adminSql,
    ).toBe(0);
  });
});
