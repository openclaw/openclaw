import type { ChildProcess } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fingerprint, signStatement } from "../../packages/openclaw-id-protocol/src/index.js";
import { buildWorld, WORLD_NOW } from "../../packages/openclaw-id-protocol/src/testing/world.js";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createBoundedChildOutput } from "../../test/helpers/bounded-child-output.js";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { logInfo } from "../logger.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { readConfigMachineStateWithMetadata } from "../test-utils/config-machine-state.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { nodeHostConfigRuntimeEntrypoint } from "./config-runtime.test-support.js";
import {
  configureNodeHost,
  loadNodeHostConfig,
  NODE_HOST_CONFIG_KEY,
  refreshNodeHostOpenClawIdTarget,
  type NodeHostConfig,
} from "./config.js";
import {
  dialableNodeHostOpenClawIdTarget,
  type NodeHostOpenClawIdTarget,
} from "./openclaw-id-target.js";

const fixtureDigest = ["fixture", "digest"].join("-");
const fixture = createFixtureLifetime();

async function idTarget(
  bindingSeq = 1,
  snapshotSeq = bindingSeq,
): Promise<NodeHostOpenClawIdTarget> {
  const world = await buildWorld();
  return {
    hostname: world.binding.body.hostname,
    pin: {
      claw_id: world.binding.body.claw_id,
      root_fp: await fingerprint(world.rootPub),
      binding_seq: bindingSeq,
      k_gw: world.gateway.pub,
    },
    evidence: {
      root_pub: world.rootPub,
      binding: await signStatement(
        "ServerBinding",
        {
          ...world.binding.body,
          binding_seq: bindingSeq,
          k_srv: bindingSeq === 1 ? world.server.peer : world.mallory.peer,
        },
        world.root,
      ),
    },
    relayUrl: "https://relay.example/",
    discoveryUrl: "https://discovery.example",
    freshness: {
      claw_id: world.binding.body.claw_id,
      snapshot: {
        seq: snapshotSeq,
        issued_at: WORLD_NOW,
        binding_seq: bindingSeq,
        k_gw: world.gateway.pub,
      },
    },
  };
}

vi.mock("../logger.js", () => ({ logInfo: vi.fn() }));

async function runConcurrentImplicitConfigures(
  stateDir: string,
  signal: AbortSignal,
): Promise<[NodeHostConfig, NodeHostConfig]> {
  const workerUrl = resolveRuntimeWorkerUrl(nodeHostConfigRuntimeEntrypoint);
  const cancellation = new AbortController();
  const childSignal = AbortSignal.any([signal, cancellation.signal]);
  const workers = ["candidate-a", "candidate-b"].map((candidate, index) => {
    const ready = createDeferred<ChildProcess>();
    const stderr = createBoundedChildOutput();
    let config: NodeHostConfig | undefined;
    const outcome = fixture.track(
      runManagedCommand({
        bin: process.execPath,
        args: [...resolveRuntimeWorkerArgv(workerUrl), candidate, String(index + 1)],
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        shell: false,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        signal: childSignal,
        requireProcessTreeExit: process.platform !== "win32",
        onReady(child) {
          child.stderr!.on("data", stderr.append);
          child.on("message", (message: "ready" | NodeHostConfig) => {
            if (message === "ready") {
              ready.resolve(child);
            } else {
              config = message;
            }
          });
        },
      }).then((code) => {
        if (code !== 0) {
          throw new Error(`configure worker failed (${code}): ${stderr.text()}`);
        }
        if (!config) {
          throw new Error("configure worker produced no result");
        }
        return config;
      }),
    );
    return {
      ready: awaitGateBeforeSettlement(
        ready.promise,
        outcome,
        "configure worker exited before the start barrier",
      ),
      outcome,
    };
  });

  try {
    // Both real processes must finish imports before either can choose its implicit id.
    const children = await withinTest(Promise.all(workers.map(({ ready }) => ready)), signal);
    for (const child of children) {
      child.send("start");
    }
    const outcomes = await Promise.all(workers.map(({ outcome }) => outcome));
    const first = outcomes[0];
    const second = outcomes[1];
    if (!first || !second) {
      throw new Error("expected two concurrent configure results");
    }
    return [first, second];
  } finally {
    cancellation.abort();
    await Promise.allSettled(workers.map(({ outcome }) => outcome));
  }
}

describe("node-host SQLite config", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fixture.cleanup();
  });

  function makeTestEnv() {
    const stateDir = fixture.createTempDir("openclaw-node-host-config-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    return {
      env,
      stateDir,
      databasePath: path.join(stateDir, "state", "openclaw.sqlite"),
      configure: (overrides: Partial<Parameters<typeof configureNodeHost>[0]> = {}) =>
        configureNodeHost({ fallbackDisplayName: "node", gateway: {}, env, ...overrides }),
      load: () => loadNodeHostConfig(env),
    };
  }

  it("retains stronger OpenClaw ID trust when startup rewrites a stale saved endpoint", async () => {
    const { configure, load } = makeTestEnv();
    const initial = await idTarget();
    const advanced = await idTarget(2, 3);
    await configure({ gateway: { kind: "openclaw-id", openclawId: initial } });
    await configure({ gateway: { kind: "openclaw-id", openclawId: advanced } });
    await configure({
      gateway: { kind: "openclaw-id", openclawId: initial },
      displayName: "Updated display name",
    });
    await closeOpenClawStateDatabaseAsync();
    await expect(load()).resolves.toMatchObject({
      displayName: "Updated display name",
      gateway: { kind: "openclaw-id", openclawId: advanced },
    });
    await configure({
      gateway: {
        kind: "openclaw-id",
        openclawId: {
          ...initial,
          discoveryUrl: "https://next-discovery.example",
          relayUrl: "https://next-relay.example/",
        },
      },
    });
    await closeOpenClawStateDatabaseAsync();
    await expect(load()).resolves.toMatchObject({
      gateway: {
        openclawId: {
          ...advanced,
          discoveryUrl: "https://next-discovery.example",
          relayUrl: "https://next-relay.example/",
        },
      },
    });
  });

  it("commits reconnect evidence, refuses stale completions and preserves node configuration", async () => {
    const { env, configure, load } = makeTestEnv();
    const initial = await idTarget();
    const advanced = await idTarget(2, 3);
    const config = await configure({
      gateway: { kind: "openclaw-id", openclawId: initial },
      displayName: "Build node",
      commands: ["fixture.read"],
      installedAppsSharing: true,
    });
    const refresh = (
      target: NodeHostOpenClawIdTarget,
      expected = initial,
      nodeId = config.nodeId,
    ) => refreshNodeHostOpenClawIdTarget({ env, nodeId, expected, target });
    await expect(refresh(advanced)).resolves.toEqual(advanced);
    await expect(refresh(initial)).rejects.toThrow("advanced during refresh");
    await expect(refresh(advanced, initial, "another-node")).rejects.toThrow(
      "configuration changed",
    );
    await expect(
      refresh(advanced, { ...initial, discoveryUrl: "https://other.example" }),
    ).rejects.toThrow("configuration changed");
    // The client verified binding 3 but refused it (stale snapshot), so its pin stays at 2.
    const staleBinding = {
      ...advanced,
      freshness: {
        claw_id: advanced.pin.claw_id,
        snapshot: { seq: 4, issued_at: WORLD_NOW, binding_seq: 3, k_gw: advanced.pin.k_gw! },
      },
    };
    await expect(refresh(staleBinding)).resolves.toEqual(staleBinding);
    await closeOpenClawStateDatabaseAsync();
    await expect(load()).resolves.toEqual({
      ...config,
      gateway: { kind: "openclaw-id", openclawId: staleBinding },
    });
    await expect(refresh(advanced)).rejects.toThrow("advanced during refresh");
    await expect(load()).resolves.toMatchObject({ gateway: { openclawId: staleBinding } });
  });

  it("retains the strongest pin and both concurrent snapshot high-water facts before refusing", async () => {
    const { env, configure, load } = makeTestEnv();
    const initial = await idTarget(2, 5);
    initial.freshness = {
      claw_id: initial.pin.claw_id,
      snapshot: { seq: 5, issued_at: WORLD_NOW, binding_seq: 4, k_gw: initial.pin.k_gw! },
    };
    const config = await configure({ gateway: { kind: "openclaw-id", openclawId: initial } });
    const candidate = await idTarget(3, 6);
    candidate.freshness = {
      claw_id: candidate.pin.claw_id,
      snapshot: { seq: 6, issued_at: WORLD_NOW, binding_seq: 1, k_gw: initial.pin.k_gw! },
    };
    await expect(
      refreshNodeHostOpenClawIdTarget({
        env,
        nodeId: config.nodeId,
        expected: initial,
        target: candidate,
      }),
    ).rejects.toThrow("advanced during refresh");
    await closeOpenClawStateDatabaseAsync();
    await expect(load()).resolves.toMatchObject({
      gateway: {
        openclawId: {
          pin: { binding_seq: 3 },
          evidence: candidate.evidence,
          freshness: {
            snapshot: { seq: 6, issued_at: WORLD_NOW, binding_seq: 4, k_gw: initial.pin.k_gw! },
          },
        },
      },
    });
  });

  it("persists complete snapshots, replaces endpoint fields and enables app sharing across reopen", async () => {
    const { env, stateDir, configure, load } = makeTestEnv();
    const expected = {
      version: 1,
      nodeId: "node-custom",
      displayName: "Build Node",
      installedAppsSharing: false,
      gateway: {
        host: "gateway.local",
        port: 18443,
        tls: true,
        tlsFingerprint: fixtureDigest,
        contextPath: "/openclaw-gw",
        cloudflareAccess: {
          clientId: { source: "env", provider: "default", id: "CF_ACCESS_CLIENT_ID" },
          clientSecret: {
            source: "env",
            provider: "default",
            id: "CF_ACCESS_CLIENT_SECRET",
          },
        },
      },
    } satisfies NodeHostConfig;
    vi.spyOn(Date, "now").mockReturnValue(1_234);
    const configured = await configure({
      nodeId: expected.nodeId,
      displayName: expected.displayName,
      gateway: structuredClone(expected.gateway),
      fallbackDisplayName: "fallback",
    });
    expect(configured).toEqual(expected);
    expect(readConfigMachineStateWithMetadata(NODE_HOST_CONFIG_KEY, { env })?.updatedAtMs).toBe(
      1_234,
    );
    await closeOpenClawStateDatabaseAsync();
    await expect(load()).resolves.toEqual(configured);
    await expect(fs.stat(path.join(stateDir, "node.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    vi.spyOn(Date, "now").mockReturnValue(1_235);
    const replaced = await configure({
      nodeId: "custom id with spaces inside",
      gateway: { host: "new.example", port: 18789, tls: false },
    });
    expect(replaced).toMatchObject({
      nodeId: "custom id with spaces inside",
      gateway: { host: "new.example", port: 18789, tls: false },
    });
    expect(replaced.gateway?.tlsFingerprint).toBeUndefined();
    expect(replaced.gateway?.contextPath).toBeUndefined();
    await expect(load()).resolves.toEqual(replaced);

    vi.spyOn(Date, "now").mockReturnValue(1_236);
    const enabled = await configure({ installedAppsSharing: true });
    expect(enabled.installedAppsSharing).toBe(true);
    await closeOpenClawStateDatabaseAsync();
    await expect(load()).resolves.toMatchObject({ installedAppsSharing: true });
  });

  it("normalizes command restrictions and preserves them across reopen and endpoint updates", async () => {
    const { configure, load } = makeTestEnv();
    await configure({ commands: [" fixture.read ", "fixture.list", "fixture.read"] });
    await closeOpenClawStateDatabaseAsync();
    await expect(load()).resolves.toMatchObject({
      commands: ["fixture.list", "fixture.read"],
    });
    await expect(configure({ gateway: { host: "new.example" } })).resolves.toMatchObject({
      commands: ["fixture.list", "fixture.read"],
    });
    await configure({ commands: [] });
    await closeOpenClawStateDatabaseAsync();
    await expect(load()).resolves.toMatchObject({ commands: [] });
  });

  it("removes a saved command allowlist durably when all commands are selected", async () => {
    vi.mocked(logInfo).mockClear();
    const { env, configure, load } = makeTestEnv();
    const restricted = await configure({ commands: ["fixture.read"] });
    const cleared = await configure({ allCommands: true });
    expect(cleared).not.toHaveProperty("commands");
    expect(cleared.nodeId).toBe(restricted.nodeId);
    await closeOpenClawStateDatabaseAsync();
    expect(readConfigMachineState(NODE_HOST_CONFIG_KEY, { env })).not.toHaveProperty("commands");
    await expect(load()).resolves.not.toHaveProperty("commands");
    await expect(configure()).resolves.not.toHaveProperty("commands");
    await configure({ allCommands: true });
    expect(logInfo).toHaveBeenCalledExactlyOnceWith(
      "node-host: cleared saved command allowlist; advertising the full default command surface",
    );
  });

  it.each([{ commands: "fixture.read" }, { commands: [""] }, { commands: [42] }])(
    "rejects corrupt command restrictions rather than exposing the full host: $commands",
    async ({ commands }) => {
      const { env } = makeTestEnv();
      writeConfigMachineState(
        NODE_HOST_CONFIG_KEY,
        { version: 1, nodeId: "node", commands },
        { env },
      );
      await expect(loadNodeHostConfig(env)).rejects.toThrow("invalid node-host commands");
    },
  );

  it("keeps the first committed implicit node id across processes", async ({ signal }) => {
    const { env, stateDir } = makeTestEnv();
    // Finish exclusive schema initialization before racing the first node-config writes.
    openOpenClawStateDatabase({ env });
    expect(readConfigMachineState(NODE_HOST_CONFIG_KEY, { env })).toBeUndefined();
    await closeOpenClawStateDatabaseAsync();
    const [first, second] = await fixture.run(() =>
      runConcurrentImplicitConfigures(stateDir, signal),
    );

    expect(["candidate-a", "candidate-b"]).toContain(first.nodeId);
    expect(second.nodeId).toBe(first.nodeId);
    expect(first.gateway).toBeUndefined();
    expect(second.gateway).toBeUndefined();
    await expect(loadNodeHostConfig(env)).resolves.toEqual(second);
  }, 30_000);

  it("loads a preview target without a Discovery origin for an explicit-origin rejoin, never to dial", async () => {
    const { env, configure, load } = makeTestEnv();
    const { discoveryUrl: _origin, ...legacy } = await idTarget(2, 3);
    writeConfigMachineState(
      NODE_HOST_CONFIG_KEY,
      { version: 1, nodeId: "preview-node", gateway: { kind: "openclaw-id", openclawId: legacy } },
      { env },
    );
    const saved = (await load())?.gateway?.openclawId;
    expect(saved).toEqual(legacy);
    expect(() => dialableNodeHostOpenClawIdTarget(saved!)).toThrow(
      "re-join this node with a new link and --discovery-url",
    );
    // A refused rejoin retains stronger trust without inventing routing.
    const stronger = { ...(await idTarget(3, 4)), discoveryUrl: undefined };
    await expect(
      refreshNodeHostOpenClawIdTarget({
        env,
        nodeId: "preview-node",
        expected: saved!,
        target: stronger,
      }),
    ).resolves.toMatchObject({ pin: { binding_seq: 3 } });
    // An admitted rejoin saves the explicit origin and keeps the retained trust.
    await configure({ gateway: { kind: "openclaw-id", openclawId: await idTarget() } });
    await closeOpenClawStateDatabaseAsync();
    const rejoined = (await load())?.gateway?.openclawId;
    expect(rejoined).toMatchObject({
      pin: { binding_seq: 3 },
      discoveryUrl: "https://discovery.example",
      freshness: { snapshot: { seq: 4, binding_seq: 3 } },
    });
    expect(dialableNodeHostOpenClawIdTarget(rejoined!).discoveryUrl).toBe(
      "https://discovery.example",
    );
  });

  it("rejects corrupt canonical rows instead of rotating identity", async () => {
    const { env, configure, load } = makeTestEnv();
    writeConfigMachineState(NODE_HOST_CONFIG_KEY, { version: 2, nodeId: "stale-node" }, { env });

    await expect(load()).rejects.toThrow("unsupported version 2");
    await expect(configure()).rejects.toThrow("unsupported version 2");
  });

  it.each(["source", "claim", "dangling-source-symlink"] as const)(
    "blocks runtime while retired state remains: %s",
    async (kind) => {
      const { stateDir, configure, load } = makeTestEnv();
      const sourcePath = path.join(stateDir, "node.json");
      const claimPath = `${sourcePath}.doctor-importing`;
      if (kind === "source") {
        await fs.writeFile(sourcePath, "{}\n", "utf8");
      } else if (kind === "claim") {
        await fs.writeFile(claimPath, "{}\n", "utf8");
      } else {
        await fs.symlink(path.join(stateDir, "missing-node.json"), sourcePath);
      }

      await expect(load()).rejects.toThrow("openclaw doctor --fix");
      await expect(configure()).rejects.toThrow("openclaw doctor --fix");
    },
  );
  function seed(env: NodeJS.ProcessEnv) {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    return configureNodeHost({
      env,
      nodeId: "fixture-node",
      displayName: "Fixture Node",
      fallbackDisplayName: "fallback",
      gateway: { host: "gateway.example", port: 18443, tls: true, contextPath: "/gateway" },
      commands: ["fixture.read", "fixture.list"],
      installedAppsSharing: true,
    });
  }

  async function withoutParentSql<T>(operation: () => Promise<T>): Promise<T> {
    requireNodeSqlite();
    const sql = observeMainThreadSql();
    try {
      const result = await operation();
      expect(sql.count()).toBe(0);
      return result;
    } finally {
      vi.restoreAllMocks();
    }
  }

  it.each(["cached", "fresh"] as const)("loads %s config without parent SQL", async (mode) => {
    expect(isMainThread).toBe(true);
    const { env } = makeTestEnv();
    const expected = await seed(env);
    const source = openOpenClawStateDatabase({ env });
    if (mode === "fresh") {
      await closeOpenClawStateDatabaseAsync();
    }
    expect(await withoutParentSql(() => loadNodeHostConfig(env))).toEqual(expected);
    expect(source.db.isOpen).toBe(mode === "cached");
  });

  it.each([false, true])("gates absent store reads on legacy=%s", async (legacy) => {
    const { env, stateDir: root, databasePath } = makeTestEnv();
    const execute = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    if (legacy) {
      fsSync.writeFileSync(path.join(root, "node.json"), "{}\n");
      await expect(loadNodeHostConfig(env)).rejects.toThrow("openclaw doctor --fix");
      expect(execute).not.toHaveBeenCalled();
    } else {
      expect(await loadNodeHostConfig(env)).toBeNull();
    }
    expect(fsSync.existsSync(databasePath)).toBe(false);
  });

  const validRow = '{"version":1,"nodeId":"fixture-node"}';
  it.each([
    ["{", 1, SyntaxError, /JSON/u],
    [validRow, -1, Error, /updated_at_ms must be a non-negative integer/u],
  ] as const)("preserves row errors (%s, %s)", async (json, time, kind, message) => {
    const { env } = makeTestEnv();
    vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockResolvedValue({
      ok: true,
      type: "nodeHost.config",
      sourceAdmitted: true,
      row: { value_json: json, updated_at_ms: time },
    });
    const failure = await loadNodeHostConfig(env).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(kind);
    expect(failure).toMatchObject({ message: expect.stringMatching(message) });
  });

  it("configures without host SQL and refreshes previously read configuration", async () => {
    const { env } = makeTestEnv();
    const initial = await seed(env);
    expect(await loadNodeHostConfig(env)).toEqual(initial);
    await withoutParentSql(async () => {
      const update = {
        displayName: "Updated Node",
        gateway: { host: "new.gateway.example", port: 19443, tls: true },
        commands: ["fixture.updated"],
      };
      vi.spyOn(Date, "now").mockReturnValue(5678);
      const configured = await configureNodeHost({
        ...update,
        env,
        fallbackDisplayName: "fallback",
      });
      expect(configured).toMatchObject({
        ...update,
        nodeId: initial.nodeId,
        installedAppsSharing: true,
      });
      expect(await loadNodeHostConfig(env)).toEqual(configured);
    });
  });
});
