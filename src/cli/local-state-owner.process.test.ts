import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
import { createManagedWorktreeOwnerPolicy } from "../agents/worktrees/owner-protection.js";
import { updateRegistryWorktree } from "../agents/worktrees/registry.js";
import { IDLE_GC_MS, ManagedWorktreeService } from "../agents/worktrees/service.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "../agents/worktrees/service.test-support.js";
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
import { startWorktreeMaintenance } from "../gateway/worktree-maintenance.js";
import {
  acquireGatewayLock,
  readActiveGatewayLockIdentity,
  resolveGatewayLockPaths,
  type GatewayLockHandle,
} from "../infra/gateway-lock.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  acquireTestPortBlock,
  reserveTestPortListener,
  type TestPortClaim,
} from "../test-utils/port-claims.js";
import { localStateOwnerFixtureEntrypoint } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";
import { registerWorktreeListingOwnerTests } from "./local-state-owner-listing.test-support.js";

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

const readText = (...parts: string[]) => fs.readFile(path.join(...parts), "utf8");
const readJson = async (...parts: string[]) => JSON.parse(await readText(...parts));
const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
const expectMissing = (file: string) =>
  expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });

async function writeFixture(root: string, file: string, content: string, executable = false) {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  if (executable) {
    await fs.chmod(target, 0o755);
  }
}

function cliPayload(result: Awaited<ReturnType<typeof runCliProcessChild>>, code = 0) {
  expect(result.code, result.stderr).toBe(code);
  return JSON.parse(result.stdout);
}

const createArgs = (repo: string, name: string) => [
  "worktrees",
  "create",
  repo,
  "--name",
  name,
  "--base-ref",
  "HEAD",
  "--json",
];
const expectCustody = (env: NodeJS.ProcessEnv) =>
  expect(acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 })).rejects.toThrow(
    "state ownership",
  );

async function expectSuccessor(env: NodeJS.ProcessEnv, port?: number) {
  await expectMissing(resolveGatewayLockPaths(env).ownerLockPath);
  const successor = await acquireGatewayLock({ env, port, allowInTests: true, timeoutMs: 0 });
  expect(successor).not.toBeNull();
  if (port) {
    expect(await readActiveGatewayLockIdentity({ env, requireInspection: true })).toMatchObject({
      pid: process.pid,
    });
  }
  await successor?.release();
}

function stubHome(env: NodeJS.ProcessEnv, root: string, includeState = false) {
  for (const key of ["HOME", "USERPROFILE"]) {
    vi.stubEnv(key, root);
  }
  if (includeState) {
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", env.OPENCLAW_CONFIG_PATH);
  }
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
  let repoFingerprint: string;
  const maintenanceClock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(maintenanceClock.clock);
  let maintenance: ReturnType<typeof startWorktreeMaintenance>;
  let mode: "normal" | "old" | "refused" | "lost-reply" = "normal";
  const requests: string[] = [];
  const methods: string[] = [];
  const failures: unknown[] = [];
  const acquireOwner = () =>
    acquireGatewayLock({ env, port: claim.port, allowInTests: true, timeoutMs: 0 });
  const run = (args: string[]) => runCliProcessChild({ nodeArgs: [...entrypoint, ...args], env });
  const observation = () => readJson(root, "control", "sql-observation.json");
  const worktreePath = () => expect.stringContaining(path.join(root, "gateway-worktrees"));

  beforeAll(async () => {
    root = roots.make("openclaw-local-owner-online-");
    env = environment(root);
    repo = await initializeRepository(root);
    for (const file of ["alpha/a.txt", "beta/b.txt", "excluded/no.txt"]) {
      await writeFixture(repo, file, file);
    }
    for (const profile of ["alpha", "beta"]) {
      await writeFixture(repo, `.openclaw/worktree-profiles/${profile}`, `${profile}\n`);
    }
    if (process.platform !== "win32") {
      await writeFixture(
        repo,
        ".openclaw/worktree-setup.sh",
        "#!/bin/sh\nprintf 'owner setup complete\\n' > setup-proof.txt\n",
        true,
      );
    }
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "source profiles");
    await git(repo, "push", "origin", "main");
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
    await writeJson(env.OPENCLAW_CONFIG_PATH!, {
      gateway: { mode: "local", port: claim.port, auth: { mode: "token", token } },
    });
    stubHome(env, root, true);
    const cfg = { worktreeRoot: path.join(root, "gateway-worktrees"), worktreeAcceleration: false };
    service = new ManagedWorktreeService({ env, getConfig: () => cfg });
    repoFingerprint = (await service.resolveRepositoryIdentity(repo)).fingerprint;
    owner = await acquireOwner();
    expect(owner).not.toBeNull();
    const handlers = createWorktreesHandlers(service);
    const context = createSessionMutationTestContext(cfg);
    maintenance = startWorktreeMaintenance({
      scheduler,
      getRuntimeConfig: context.getRuntimeConfig,
      runGc: () => service.gc(createManagedWorktreeOwnerPolicy(cfg)),
      onComplete: () => {},
      onError: (error) => failures.push(error),
    });
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
              methods: Object.keys(handlers),
              auth: { role: "operator", scopes: ["operator.admin"] },
              snapshot: { stateDir: env.OPENCLAW_STATE_DIR, configPath: env.OPENCLAW_CONFIG_PATH },
            });
            sendMinimalGatewayResponse(ws, frame.id, {
              ...hello,
              features: {
                ...hello.features,
                capabilities: mode === "old" ? [] : Object.values(GATEWAY_SERVER_CAPS),
              },
            });
            return;
          }
          expect(authenticated).toBe(true);
          const method = frame.method!;
          expect(handlers[method]).toBeTypeOf("function");
          methods.push(method);
          if (method === "worktrees.create") {
            requests.push(String(frame.params?.name));
          }
          await handlers[method]!({
            req: { type: "req", id: frame.id, method, params: frame.params },
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
    mode = "normal";
    stubHome(env, root, true);
  });

  afterAll(async () => {
    await maintenance.stop();
    await scheduler.stop();
    await closeMinimalGatewayServer(server);
    await closeOpenClawStateDatabaseAsync();
    await owner?.release();
    await claim.release();
    vi.unstubAllEnvs();
    expect(failures).toEqual([]);
  });

  const create = (name: string, extra: string[] = [], selector = repo) =>
    runCliProcessChild({
      nodeArgs: [...entrypoint, ...createArgs(selector, name), ...extra],
      // A configured remote URL must not redirect this same-root operation.
      env: { ...env, OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:1" },
    });

  registerWorktreeListingOwnerTests(
    () => ({
      root,
      repo,
      env,
      service,
      methods,
      port: claim.port,
      get owner() {
        return owner;
      },
      set owner(value: GatewayLockHandle | null) {
        owner = value;
      },
    }),
    entrypoint,
  );

  it("runs the CLI create in the live owner and exposes committed profile results", async () => {
    const result = await create(
      "routed",
      ["--source-profile", "alpha", "--source-profile", "beta"],
      repoSelector,
    );
    const record: ManagedWorktreeRecord = cliPayload(result);
    expect(record).toMatchObject({
      repoRoot: repo,
      path: worktreePath(),
      ownerKind: "manual",
    });
    expect(await git(repo, "branch", "--list", "openclaw/routed")).toBe("+ openclaw/routed");
    if (decoyRepo) {
      expect(await git(decoyRepo, "branch", "--list", "openclaw/routed")).toBe("");
    }
    if (process.platform !== "win32") {
      expect(await readText(record.path, "setup-proof.txt")).toBe("owner setup complete\n");
    }
    expect(await service.listRegistryRecords()).toContainEqual(
      expect.objectContaining({ id: record.id, path: record.path }),
    );
    expect(await readText(record.path, "alpha/a.txt")).toBe("alpha/a.txt");
    expect(await readText(record.path, "beta/b.txt")).toBe("beta/b.txt");
    await expectMissing(path.join(record.path, "excluded/no.txt"));
    expect(await git(record.path, "rev-parse", "HEAD")).toBe(await git(repo, "rev-parse", "HEAD"));
    expect(requests).toEqual(["routed"]);
    await fs.writeFile(path.join(record.path, "alpha/a.txt"), "retained routed work\n");
    for (const restore of [false, true]) {
      if (restore) {
        await service.remove({ id: record.id, reason: "create restore fixture" });
      }
      const repeated = await create("routed");
      expect(cliPayload(repeated)).toMatchObject({ id: record.id, path: record.path });
      expect(await readText(record.path, "alpha/a.txt")).toBe("retained routed work\n");
      expect(
        (await service.listRegistryRecords()).find((item) => item.id === record.id)?.removedAt,
      ).toBeUndefined();
    }
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
        expect(records[0].path).toEqual(worktreePath());
      }
      expect(await git(repo, "branch", "--list", `openclaw/${scenario}`)).toBe(
        scenario === "lost-reply" ? "+ openclaw/lost-reply" : "",
      );
      if (scenario === "lost-reply") {
        expect(result.stderr + result.stdout).not.toMatch(/fixture-(?:user|pass|secret)/u);
      }
    },
  );

  let sequence = 0;

  async function prepareOperation(kind: "exact-remove" | "gc-partial") {
    const name = `mutation-${++sequence}`;
    const record = await materializeManagedWorktreeFixture({
      env,
      stateDir: env.OPENCLAW_STATE_DIR!,
      repoRoot: repo,
      repoFingerprint,
      name,
      now: Date.now(),
      ownerKind: kind === "gc-partial" ? "workboard" : "manual",
    });
    const readRecord = async () =>
      (await service.listRegistryRecords()).find((candidate) => candidate.id === record.id);
    if (kind === "exact-remove") {
      const head = await git(record.path, "rev-parse", "HEAD");
      await git(record.path, "checkout", "--detach", "HEAD");
      await fs.writeFile(path.join(record.path, "README.md"), "staged\n");
      await git(record.path, "add", "README.md");
      await fs.writeFile(path.join(record.path, "README.md"), "working\n");
      const index = await fs.readFile(
        path.resolve(record.path, await git(record.path, "rev-parse", "--git-path", "index")),
      );
      const filename = path.join(root, `${name}.json`);
      await writeJson(filename, {
        ownerKind: record.ownerKind,
        createdAt: record.createdAt,
        lastActiveAt: record.lastActiveAt,
        head,
        branchHead: head,
        indexSha256: createHash("sha256").update(index).digest("hex"),
      });
      return {
        args: ["worktrees", "remove", record.id, "--exact-state", filename, "--json"],
        cleanup: async () => {},
        verify: async (mutated: boolean, payload?: Record<string, unknown>) => {
          expect((await readRecord())?.removedAt !== undefined).toBe(mutated);
          const retained = payload?.recoveryPath;
          expect(retained).toBeTypeOf("string");
          expect(await readText(String(retained), "README.md")).toBe("working\n");
          expect(payload).toMatchObject({
            removed: true,
            recoveryRetainedUntil: expect.any(Number),
          });
          await expectMissing(record.path);
        },
      };
    }
    await updateRegistryWorktree(env, record.id, { lastActiveAt: Date.now() - IDLE_GC_MS - 1 });
    const brokenRepo = await initializeRepository(path.join(root, name));
    const broken = await materializeManagedWorktreeFixture({
      env,
      repoRoot: brokenRepo,
      stateDir: path.join(root, name, "worktrees"),
      name: `${name}-broken`,
      now: Date.now() - IDLE_GC_MS - 1,
      ownerKind: "workboard",
    });
    await fs.rename(brokenRepo, `${brokenRepo}-away`);
    return {
      args: ["worktrees", "gc", "--json"],
      cleanup: async () => {
        await fs.rename(`${brokenRepo}-away`, brokenRepo);
        await updateRegistryWorktree(env, broken.id, { lastActiveAt: Date.now() });
      },
      verify: async (mutated: boolean, payload?: Record<string, unknown>) => {
        expect((await readRecord())?.removedAt !== undefined).toBe(mutated);
        if (mutated) {
          expect(payload).toMatchObject({
            outcome: "partial",
            removed: expect.arrayContaining([record.id]),
            issues: expect.arrayContaining([
              expect.objectContaining({ id: broken.id, outcome: "failed" }),
            ]),
          });
          await expectMissing(record.path);
        }
      },
    };
  }

  it.each([
    { kind: "exact-remove", method: "worktrees.remove", scenario: "live" },
    { kind: "exact-remove", method: "worktrees.remove", scenario: "offline" },
    { kind: "gc-partial", method: "worktrees.gc", scenario: "live" },
  ] as const)(
    "$kind: $scenario preserves the operation contract and custody",
    async ({ kind, method, scenario }) => {
      const prepared = await prepareOperation(kind);
      const before = methods.length;
      if (scenario === "offline") {
        await closeOpenClawStateDatabaseAsync();
        await owner?.release();
        owner = null;
      }
      try {
        const result = await run(prepared.args);
        if (scenario === "offline") {
          owner = await acquireOwner();
          expect(owner).not.toBeNull();
        }
        const observed = await observation();
        let payload = cliPayload(result);
        expect(methods.slice(before)).toEqual(scenario === "live" ? [method] : []);
        if (scenario === "offline") {
          expect(observed.missingCustody).toBe(0);
          for (const pid of observed.ownerPids) {
            expect(pid).toBe(observed.pid);
          }
        } else {
          expect(observed.worktreeSql).toBe(0);
        }
        if (kind === "gc-partial") {
          expect(payload).toMatchObject({
            jobId: expect.any(String),
            state: "queued",
            startedAt: null,
            completedAt: null,
          });
          await prepared.verify(false);
          await maintenanceClock.advanceBy(0);
          const completed = cliPayload(
            await run(["worktrees", "gc", "--job", payload.jobId, "--json"]),
            1,
          );
          expect(methods.slice(before)).toEqual([method, method]);
          expect(completed).toMatchObject({
            jobId: payload.jobId,
            state: "completed",
            completedAt: expect.any(Number),
          });
          expect((await observation()).worktreeSql).toBe(0);
          payload = completed;
        }
        await prepared.verify(true, payload);
      } finally {
        if (!owner) {
          owner = await acquireOwner();
        }
        await prepared.cleanup();
      }
    },
  );

  it.each([
    ["mcp logout", ["mcp", "logout", "synthetic-server"]],
    ["models auth logout", ["models", "auth", "logout", "synthetic:manual", "--yes"]],
    ["sandbox recreate", ["sandbox", "recreate", "--all", "--force"]],
    [
      "migration import",
      "migrate apply synthetic-missing-provider --yes --no-backup --force --json".split(" "),
    ],
    ["exec-policy preset", ["exec-policy", "preset", "deny-all"]],
  ])(
    "refuses live %s before changing local state or dispatching to the owner",
    async (_name, args) => {
      const before = methods.length;
      const configBefore = await readText(env.OPENCLAW_CONFIG_PATH!);
      const result = await run(args);
      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr).toContain("exclusive offline state ownership");
      expect(methods).toHaveLength(before);
      expect(await readText(env.OPENCLAW_CONFIG_PATH!)).toBe(configBefore);
      expect((await observation()).worktreeSql).toBe(0);
    },
  );
});

describe("offline local mutation custody", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  afterEach(() => vi.unstubAllEnvs());
  async function fixture(prefix: string) {
    const root = roots.make(`openclaw-local-owner-${prefix}-`);
    const env = environment(root);
    stubHome(env, root);
    const repo = await initializeRepository(root);
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH!, "{}\n");
    return { root, env, repo };
  }

  it.skipIf(process.platform === "win32")(
    "retains offline CLI custody through its POSIX setup hook while Gateway startup races",
    async () => {
      const { env, repo } = await fixture("offline");
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
      await writeFixture(
        repo,
        ".openclaw/worktree-setup.sh",
        `#!/usr/bin/env node
const socket = require("node:net").connect(${reservation.claim.port}, "127.0.0.1", () => socket.write("ready"));
socket.on("data", () => {
  require("node:fs").writeFileSync("setup-proof.txt", "local setup complete\\n");
  socket.end();
});
`,
        true,
      );
      try {
        const result = await runCliProcessChild({
          nodeArgs: [...entrypoint, ...createArgs(repo, "offline")],
          env,
          interact: async (child) => {
            const socket = await awaitGateBeforeSettlement(
              setupReady.promise,
              once(child, "exit"),
              "CLI exited before setup hook",
            );
            await expectCustody(env);
            socket.write("release");
            child.stdin.end();
          },
        });
        const record: ManagedWorktreeRecord = cliPayload(result);
        expect(await readText(record.path, "README.md")).toBe("base\n");
        expect(await readText(record.path, "setup-proof.txt")).toBe("local setup complete\n");
        expect(record.path).toContain(path.join(env.OPENCLAW_STATE_DIR!, "worktrees"));
        await expectSuccessor(env);
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
      const { root, env, repo } = await fixture("settlement");
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
          await expectCustody(env);
          if (interrupt) {
            child.kill("SIGTERM");
            await awaitGateBeforeSettlement(
              interrupted.promise,
              exited,
              "CLI exited before signal settlement",
            );
            await expectCustody(env);
          }
          child.stdin.end("continue\n");
        },
      });
      expect(result.code, result.stderr).toBe(interrupt ? 143 : 0);
      expect(await readJson(root, "settlement.json")).toEqual({ databaseOpen: false });
      expect(await git(repo, "branch", "--list", "openclaw/settled")).toBe("+ openclaw/settled");
      await expectSuccessor(env, 18789);
    },
  );
});
