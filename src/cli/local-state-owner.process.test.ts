import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ManagedWorktreeService } from "../agents/worktrees/service.js";
import { useManagedWorktreeTestRepository } from "../agents/worktrees/service.test-support.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import {
  createSessionMutationTestClient,
  createSessionMutationTestContext,
} from "../gateway/server-methods/sessions-mutations.owner.test-support.js";
import { createWorktreesHandlers } from "../gateway/server-methods/worktrees.js";
import {
  acquireGatewayLock,
  readActiveGatewayLockIdentity,
  resolveGatewayLockPaths,
  type GatewayLockHandle,
} from "../infra/gateway-lock.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  acquireTestPortBlock,
  reserveTestPortListener,
  type TestPortClaim,
} from "../test-utils/port-claims.js";
import { localStateOwnerFixtureEntrypoint } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const execFileAsync = promisify(execFile);
const roots = useAutoCleanupTempDirTracker(afterAll);
const token = "synthetic-routing-owner-token";
const entrypoint = resolveRuntimeWorkerArgv(
  resolveRuntimeWorkerUrl(localStateOwnerFixtureEntrypoint),
);

function environment(root: string): NodeJS.ProcessEnv {
  return {
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
}

async function git(repo: string, ...args: string[]) {
  return (await execFileAsync("git", ["-C", repo, ...args])).stdout.trim();
}

describe("same-root local mutation routing", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repo: string;
  let repoSelector: string;
  let decoyRepo: string | undefined;
  let env: NodeJS.ProcessEnv;
  let server: WebSocketServer;
  let claim: TestPortClaim;
  let owner: GatewayLockHandle | null;
  let service: ManagedWorktreeService;
  let mode: "normal" | "old" | "refused" | "lost-reply" = "normal";
  const requests: string[] = [];
  const failures: unknown[] = [];

  beforeAll(async () => {
    root = roots.make("openclaw-local-owner-online-");
    env = environment(root);
    repo = await initializeRepository(root);
    for (const file of ["alpha/a.txt", "beta/b.txt", "excluded/no.txt"]) {
      await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
      await fs.writeFile(path.join(repo, file), file);
    }
    await fs.mkdir(path.join(repo, ".openclaw", "worktree-profiles"), { recursive: true });
    await fs.writeFile(path.join(repo, ".openclaw", "worktree-profiles", "alpha"), "alpha\n");
    await fs.writeFile(path.join(repo, ".openclaw", "worktree-profiles", "beta"), "beta\n");
    if (process.platform !== "win32") {
      const setup = path.join(repo, ".openclaw", "worktree-setup.sh");
      await fs.writeFile(setup, "#!/bin/sh\nprintf 'owner setup complete\\n' > setup-proof.txt\n");
      await fs.chmod(setup, 0o755);
    }
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "source profiles");
    repoSelector = repo;
    if (process.platform !== "win32") {
      const entry = path.join(root, "entry");
      const anchor = path.join(root, "anchor");
      await fs.mkdir(entry);
      await fs.mkdir(anchor);
      await fs.symlink(anchor, path.join(entry, "link"), "dir");
      decoyRepo = path.join(entry, "repo");
      await git(root, "clone", "--no-hardlinks", repo, decoyRepo);
      // Preserve .. so filesystem lookup follows the link before ascending.
      repoSelector = `${path.join(entry, "link")}/../repo`;
    }
    claim = await acquireTestPortBlock({ offsets: [0] });
    await fs.writeFile(
      env.OPENCLAW_CONFIG_PATH!,
      JSON.stringify({
        gateway: { mode: "local", port: claim.port, auth: { mode: "token", token } },
      }),
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", env.OPENCLAW_CONFIG_PATH);
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    const cfg = { worktreeRoot: path.join(root, "gateway-worktrees"), worktreeAcceleration: false };
    service = new ManagedWorktreeService({ env, getConfig: () => cfg });
    owner = await acquireGatewayLock({ env, port: claim.port, allowInTests: true, timeoutMs: 0 });
    expect(owner).not.toBeNull();
    const handlers = createWorktreesHandlers(service);
    const context = createSessionMutationTestContext(cfg);
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
              methods: ["worktrees.create"],
              auth: { role: "operator", scopes: ["operator.admin"] },
              snapshot: { stateDir: env.OPENCLAW_STATE_DIR, configPath: env.OPENCLAW_CONFIG_PATH },
            });
            sendMinimalGatewayResponse(ws, frame.id, {
              ...hello,
              features: {
                ...hello.features,
                capabilities: mode === "old" ? [] : [GATEWAY_SERVER_CAPS.LOCAL_STATE_OWNER_ROUTING],
              },
            });
            return;
          }
          expect(authenticated).toBe(true);
          expect(frame.method).toBe("worktrees.create");
          requests.push(String(frame.params?.name));
          await handlers["worktrees.create"]!({
            req: { type: "req", id: frame.id, method: "worktrees.create", params: frame.params },
            params: {
              ...frame.params,
              ...(mode === "refused" ? { expectedOwnerId: "retired-owner" } : {}),
            },
            client,
            context,
            isWebchatConnect: () => false,
            hasCurrentClientAuthority: () => authenticated,
            respond: (ok, payload, error) => {
              if (mode === "lost-reply" && ok) {
                ws.close(
                  1011,
                  "lost reply ws://fixture-user:fixture-pass@gw.invalid/?token=fixture-secret",
                );
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
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", env.OPENCLAW_CONFIG_PATH);
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
  });

  afterAll(async () => {
    await closeMinimalGatewayServer(server);
    await closeOpenClawStateDatabaseAsync();
    await owner?.release();
    await claim.release();
    vi.unstubAllEnvs();
    expect(failures).toEqual([]);
  });

  const create = (name: string, extra: string[] = [], selector = repo) =>
    runCliProcessChild({
      nodeArgs: [
        ...entrypoint,
        "worktrees",
        "create",
        selector,
        "--name",
        name,
        "--base-ref",
        "HEAD",
        "--json",
        ...extra,
      ],
      // A configured remote URL must not redirect this same-root operation.
      env: { ...env, OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:1" },
    });

  it("runs the CLI create in the live owner and exposes committed profile results", async () => {
    const result = await create(
      "routed",
      ["--source-profile", "alpha", "--source-profile", "beta"],
      repoSelector,
    );
    expect(result.code, result.stderr).toBe(0);
    const record: ManagedWorktreeRecord = JSON.parse(result.stdout);
    expect({
      repoRoot: record.repoRoot,
      sourceBranch: await git(repo, "branch", "--list", "openclaw/routed"),
      ...(decoyRepo
        ? { decoyBranch: await git(decoyRepo, "branch", "--list", "openclaw/routed") }
        : {}),
    }).toEqual({
      repoRoot: repo,
      sourceBranch: "+ openclaw/routed",
      ...(decoyRepo ? { decoyBranch: "" } : {}),
    });
    expect(record.path).toContain(path.join(root, "gateway-worktrees"));
    expect(record.ownerKind).toBe("manual");
    if (process.platform !== "win32") {
      expect(await fs.readFile(path.join(record.path, "setup-proof.txt"), "utf8")).toBe(
        "owner setup complete\n",
      );
    }
    expect(await service.listRegistryRecords()).toContainEqual(
      expect.objectContaining({ id: record.id, path: record.path }),
    );
    expect(await fs.readFile(path.join(record.path, "alpha/a.txt"), "utf8")).toBe("alpha/a.txt");
    expect(await fs.readFile(path.join(record.path, "beta/b.txt"), "utf8")).toBe("beta/b.txt");
    await expect(fs.access(path.join(record.path, "excluded/no.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await git(record.path, "rev-parse", "HEAD")).toBe(await git(repo, "rev-parse", "HEAD"));
    expect(requests).toEqual(["routed"]);
  });

  it.each(["old", "refused", "lost-reply"] as const)(
    "does not fall back locally after %s",
    async (scenario) => {
      mode = scenario;
      const before = requests.length;
      const result = await create(scenario);
      expect(result.code, result.stderr).toBe(1);
      if (scenario === "old") {
        expect(result.stderr).toMatch(/capabilit/iu);
        expect(result.stderr).toContain("Update the Gateway");
        expect(requests).toHaveLength(before);
      } else {
        expect(requests).toHaveLength(before + 1);
        expect(result.stderr).toContain(
          scenario === "refused" ? "No local mutation" : "outcome may be partial",
        );
      }
      const records = (await service.listRegistryRecords()).filter(
        (record) => record.name === scenario,
      );
      expect(records).toHaveLength(scenario === "lost-reply" ? 1 : 0);
      if (records[0]) {
        expect(records[0].path).toContain(path.join(root, "gateway-worktrees"));
      }
      expect(await git(repo, "branch", "--list", `openclaw/${scenario}`)).toBe(
        scenario === "lost-reply" ? "+ openclaw/lost-reply" : "",
      );
      if (scenario === "lost-reply") {
        for (const output of [result.stderr, result.stdout]) {
          expect(output).not.toMatch(/fixture-(?:user|pass|secret)/u);
        }
      }
    },
  );
});

describe("offline local mutation custody", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  afterEach(() => vi.unstubAllEnvs());

  it.skipIf(process.platform === "win32")(
    "retains offline CLI custody through its POSIX setup hook while Gateway startup races",
    async () => {
      const root = roots.make("openclaw-local-owner-offline-");
      const env = environment(root);
      vi.stubEnv("HOME", root);
      vi.stubEnv("USERPROFILE", root);
      const repo = await initializeRepository(root);
      await fs.writeFile(env.OPENCLAW_CONFIG_PATH!, "{}\n");
      const setupReady = createDeferred<Socket>();
      const reservation = await reserveTestPortListener({
        offsets: [0],
        createListener: createServer,
      });
      let setupSocket: Socket | undefined;
      reservation.listener.once("connection", (socket) => {
        setupSocket = socket;
        socket.once("data", () => setupReady.resolve(socket));
      });
      const setup = path.join(repo, ".openclaw", "worktree-setup.sh");
      await fs.mkdir(path.dirname(setup), { recursive: true });
      await fs.writeFile(
        setup,
        `#!/usr/bin/env node
const socket = require("node:net").connect(${reservation.claim.port}, "127.0.0.1", () => socket.write("ready"));
socket.on("data", () => {
  require("node:fs").writeFileSync("setup-proof.txt", "local setup complete\\n");
  socket.end();
});
`,
      );
      await fs.chmod(setup, 0o755);
      try {
        const result = await runCliProcessChild({
          nodeArgs: [
            ...entrypoint,
            "worktrees",
            "create",
            repo,
            "--name",
            "offline",
            "--base-ref",
            "HEAD",
            "--json",
          ],
          env,
          interact: async (child) => {
            const socket = await awaitGateBeforeSettlement(
              setupReady.promise,
              once(child, "exit"),
              "CLI exited before setup hook",
            );
            await expect(
              acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 }),
            ).rejects.toThrow("state ownership");
            socket.write("release");
            child.stdin.end();
          },
        });
        expect(result.code, result.stderr).toBe(0);
        const record: ManagedWorktreeRecord = JSON.parse(result.stdout);
        expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
        expect(await fs.readFile(path.join(record.path, "setup-proof.txt"), "utf8")).toBe(
          "local setup complete\n",
        );
        expect(record.path).toContain(path.join(env.OPENCLAW_STATE_DIR!, "worktrees"));
        await expect(fs.access(resolveGatewayLockPaths(env).ownerLockPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        const successor = await acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 });
        expect(successor).not.toBeNull();
        await successor?.release();
      } finally {
        setupSocket?.destroy();
        await reservation.releaseListener();
        await reservation.claim.release();
      }
    },
  );

  it.each(process.platform === "win32" ? [false] : [false, true])(
    "holds Gateway startup through accepted work and database close; signal=%s",
    async (interrupt) => {
      const root = roots.make("openclaw-local-owner-settlement-");
      const env = environment(root);
      vi.stubEnv("HOME", root);
      vi.stubEnv("USERPROFILE", root);
      const repo = await initializeRepository(root);
      await fs.writeFile(env.OPENCLAW_CONFIG_PATH!, "{}\n");
      const pending = createDeferred();
      const interrupted = createDeferred();
      const result = await runCliProcessChild({
        nodeArgs: [...entrypoint, "settlement", repo],
        env,
        onStdout: (text) => {
          if (text.includes("pending:false")) {
            pending.resolve();
          }
          if (text.includes("interrupted")) {
            interrupted.resolve();
          }
        },
        interact: async (child) => {
          const exited = once(child, "exit");
          await awaitGateBeforeSettlement(
            pending.promise,
            exited,
            "CLI exited before retained continuation",
          );
          await expect(
            acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 }),
          ).rejects.toThrow("state ownership");
          if (interrupt) {
            child.kill("SIGTERM");
            await awaitGateBeforeSettlement(
              interrupted.promise,
              exited,
              "CLI exited before signal settlement",
            );
            await expect(
              acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 }),
            ).rejects.toThrow("state ownership");
          }
          child.stdin.end("continue\n");
        },
      });
      expect(result.code, result.stderr).toBe(interrupt ? 143 : 0);
      expect(JSON.parse(await fs.readFile(path.join(root, "settlement.json"), "utf8"))).toEqual({
        databaseOpen: false,
      });
      expect(await git(repo, "branch", "--list", "openclaw/settled")).toBe("+ openclaw/settled");
      await expect(fs.access(resolveGatewayLockPaths(env).ownerLockPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const successor = await acquireGatewayLock({
        env,
        port: 18789,
        allowInTests: true,
        timeoutMs: 0,
      });
      expect(successor).not.toBeNull();
      expect(await readActiveGatewayLockIdentity({ env, requireInspection: true })).toMatchObject({
        pid: process.pid,
      });
      await successor?.release();
    },
  );
});
