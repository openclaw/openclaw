import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as registryListing from "../state/openclaw-agent-db-registry-listing.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../state/openclaw-agent-db-registry-listing.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
const { observedDirectories, releasedDirectories } = vi.hoisted(() => ({
  observedDirectories: [] as Array<{
    directory: string;
    notify: (filename?: string) => void;
    active: boolean;
  }>,
  // The shared owner closes a native watch when a directory's last observation leaves.
  releasedDirectories: [] as string[],
}));
// mock-isolation: Deliver directory changes deterministically without native watcher timing.
vi.mock("../infra/owned-directory-observation.js", () => ({
  observeOwnedDirectory(directory: string, notify: (filename?: string) => void) {
    const observation = { directory, notify, active: true };
    observedDirectories.push(observation);
    return {
      close: () => {
        observation.active = false;
        if (!observedDirectories.some((entry) => entry.active && entry.directory === directory)) {
          releasedDirectories.push(directory);
        }
      },
    };
  },
}));

import { resolveGatewaySessionStoreReadSources as resolveSources } from "./session-utils-store-candidates.js";
import { prepareGatewaySessionStoreReadSourcesAsync as prepareSourcesAsync } from "./session-utils-store-sources.js";

const linkType = process.platform === "win32" ? "junction" : "dir";
type SourceParams = Parameters<typeof prepareSourcesAsync>[0];
let state: OpenClawTestState;
const withState = (run: () => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal" }, async (fixture) => {
    state = fixture;
    try {
      await run();
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });
const defaults = { systemAgent: { agentId: "main" }, sessionStore: { agentId: "main" } };
function config(
  entries: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>,
  store?: string,
): OpenClawConfig {
  return {
    agents: { ownership: "explicit", entries, ...(store ? { defaults } : {}) },
    ...(store ? { session: { store } } : {}),
  };
}
const source = ({ agentId, path: storePath }: { agentId: string; path: string }) => ({
  agentId,
  path: storePath,
});
function sourceParams(
  currentSource: SourceParams["currentSource"],
  cfg: OpenClawConfig = config({ main: {} }),
  env = state.env,
): SourceParams {
  return { cfg, currentSource, env, registryPath: openOpenClawStateDatabase().path };
}
function expectRegistered(
  prepared: Awaited<ReturnType<typeof prepareSourcesAsync>>,
  database: { agentId: string; path: string },
) {
  expect(prepared.request?.registeredDatabases).toEqual(
    expect.arrayContaining([expect.objectContaining(source(database))]),
  );
}
const sourcesOf = (prepared: Awaited<ReturnType<typeof prepareSourcesAsync>>) =>
  resolveSources(expectDefined(prepared.request, "source routing request")).sources;
function mainSources() {
  const main = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  return { main, params: sourceParams(source(main)) };
}

function aliasSources() {
  const { main, params } = mainSources();
  const alias = state.path("source-alias");
  const replacement = state.path("replacement");
  fs.mkdirSync(replacement);
  fs.writeFileSync(path.join(replacement, path.basename(main.path)), "synthetic replacement");
  fs.symlinkSync(path.dirname(main.path), alias, linkType);
  params.currentSource = { agentId: "main", path: path.join(alias, path.basename(main.path)) };
  params.cfg = config({ main: {} }, params.currentSource.path);
  return { main, params, alias, replacement };
}

function notifyAlias(alias: string) {
  for (const entry of observedDirectories) {
    if (entry.active && entry.directory === path.dirname(alias)) {
      entry.notify(path.basename(alias));
    }
  }
}
function replaceAlias(alias: string, replacement: string) {
  fs.unlinkSync(alias);
  fs.symlinkSync(replacement, alias, linkType);
  notifyAlias(alias);
}

function holdRegistryRead() {
  const entered = createDeferred();
  const resume = createDeferred();
  const prepare = registryListing.prepareOpenClawAgentDatabaseRegistrySnapshotRead;
  const spy = vi
    .spyOn(registryListing, "prepareOpenClawAgentDatabaseRegistrySnapshotRead")
    .mockImplementation((...args) => {
      const prepared = prepare(...args);
      return {
        ...prepared,
        async read(signal) {
          const result = await prepared.read(signal);
          entered.resolve();
          await resume.promise;
          return result;
        },
      };
    });
  return { entered, resume, spy };
}

it.each([false, true])(
  "bounds discovery and refreshes only the next roster (fixed: %s)",
  async (fixed) => {
    await withState(async () => {
      const storeDir = state.path("stores");
      fs.mkdirSync(storeDir);
      const agentIds = [
        "main",
        ...Array.from({ length: fixed ? 11 : 47 }, (_, i) => `worker-${i}`),
      ];
      let entryReads = 0;
      const entries = new Proxy(Object.fromEntries(agentIds.map((id) => [id, {}])), {
        get(target, property, receiver) {
          if (Object.hasOwn(target, property)) {
            entryReads++;
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const cfg = config(entries, fixed ? path.join(storeDir, "shared.json") : undefined);
      const fixedStore = (agentId: string) =>
        path.join(storeDir, `shared${agentId === "main" ? "" : `.${agentId}`}.sqlite`);
      const openStore = (agentId: string) =>
        openOpenClawAgentDatabase({
          agentId,
          env: state.env,
          ...(fixed ? { path: fixedStore(agentId) } : {}),
        });
      const databases = (fixed ? agentIds : ["main"]).map(openStore);
      const currentSource = { agentId: "main", path: databases[0]!.path };
      const readdir = vi.spyOn(fs, "readdirSync");
      const realpath = vi.spyOn(fs.realpathSync, "native");
      syncBuiltinESMExports();
      const prepare = async () => {
        entryReads = 0;
        const captured = await prepareSourcesAsync(sourceParams(currentSource, cfg));
        const request = expectDefined(captured.request, "source routing request");
        // Keep the resolver's original discovery budget separate from host candidate capture.
        readdir.mockClear();
        realpath.mockClear();
        const prepared = resolveSources(request);
        expect(Object.keys(prepared.sources)).toEqual(Object.keys(entries));
        expect(prepared.sources.main?.[0]).toEqual(currentSource);
        expect(entryReads).toBeLessThan(Object.keys(entries).length * 16);
        if (fixed) {
          expect(prepared.sources).toEqual(
            Object.fromEntries(databases.map((database) => [database.agentId, [source(database)]])),
          );
          const paths = new Set(databases.map(({ path: storePath }) => storePath));
          const reads = realpath.mock.calls.flatMap(([name]) =>
            typeof name === "string" && paths.has(name) ? [name] : [],
          );
          expect(new Set(reads)).toEqual(paths);
          expect(reads.length).toBeLessThanOrEqual(databases.length * 4);
          expect(
            readdir.mock.calls.filter(([name]) => name === storeDir).length,
          ).toBeLessThanOrEqual(databases.length * 8);
        }
        return prepared;
      };
      const first = await prepare();
      entries.added = {};
      if (fixed) {
        databases.push(openStore("added"));
      }
      const second = await prepare();
      expect(Object.keys(first.sources)).toEqual(agentIds);
      expect(Object.keys(second.sources)).toEqual([...agentIds, "added"]);
    });
  },
);

it("binds source addresses before asynchronous callers yield", async () => {
  await withState(async () => {
    const { main } = mainSources();
    const currentSource = source(main);
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const env = { ...state.env };
    const pending = prepareSourcesAsync(sourceParams(currentSource, cfg, env));

    await Promise.resolve();
    cfg.session = { store: path.join(state.stateDir, "moved", "{agentId}", "sessions.json") };
    env.OPENCLAW_STATE_DIR = state.path("different-state");

    const prepared = await pending;
    const request = expectDefined(prepared.request, "source routing request");
    invalidateRegisteredAgentDatabasesMemo({ path: openOpenClawStateDatabase().path });
    expect(resolveSources(request).sources.main).toEqual([currentSource]);
    expect(request.env.OPENCLAW_STATE_DIR).toBe(state.env.OPENCLAW_STATE_DIR);
  });
});

it("omits a replaced missing parent from worker source selection", async () => {
  await withState(async () => {
    const parent = state.path("source-parent");
    const replacement = state.path("replacement-store");
    fs.mkdirSync(replacement);
    fs.mkdirSync(parent);
    const currentSource = { agentId: "main", path: path.join(parent, "sessions.sqlite") };
    const registryPath = openOpenClawStateDatabase().path;
    const prepared = await prepareSourcesAsync(
      sourceParams(currentSource, { session: { store: currentSource.path } }),
    );
    expect(sourcesOf(prepared).main).toEqual([currentSource]);
    fs.renameSync(parent, `${parent}.previous`);
    fs.symlinkSync(replacement, parent, linkType);
    invalidateRegisteredAgentDatabasesMemo({ path: registryPath });
    expect(sourcesOf(prepared).main).toEqual([]);
  });
});

it("captures fixed, missing, and retired routing without main-thread SQL", async () => {
  await withState(async () => {
    const storeDir = state.path("stores");
    fs.mkdirSync(storeDir, { recursive: true });
    const cfg = config(
      { main: { name: "not-a-routing-field" }, ops: {}, future: {} },
      path.join(storeDir, "shared.json"),
    );
    const open = (agentId: string, storePath: string) =>
      openOpenClawAgentDatabase({ agentId, env: state.env, path: storePath });
    const main = open("main", path.join(storeDir, "shared.sqlite"));
    const ops = open("ops", path.join(storeDir, "shared.ops.sqlite"));
    const retired = open("retired", state.path("retired-location", "history.sqlite"));
    const currentSource = source(main);
    const params = sourceParams(currentSource, cfg);
    const registryPath = params.registryPath;
    invalidateRegisteredAgentDatabasesMemo({ path: registryPath });
    // Retire fixture writers so their checkpoint timers cannot enter the read-only SQL probe.
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    const sql = observeMainThreadSql();
    let prepared: Awaited<ReturnType<typeof prepareSourcesAsync>>;
    try {
      sql.calibrate();
      prepared = await prepareSourcesAsync(params);
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    const request = expectDefined(prepared.request, "source routing request");
    expect(JSON.stringify(request)).not.toContain("not-a-routing-field");
    expect(sourcesOf(prepared)).toEqual({
      main: [currentSource],
      ops: [{ agentId: "ops", path: ops.path }],
      future: [{ agentId: "future", path: path.join(storeDir, "shared.future.sqlite") }],
      retired: [{ agentId: "retired", path: retired.path }],
    });
  });
});

it.each([false, true])(
  "keeps failed auxiliary discovery isolated (recovers after yield: %s)",
  async (recovers) => {
    await withState(async () => {
      const storeDir = state.path("stores");
      fs.mkdirSync(storeDir, { recursive: true });
      const blockedPath = path.join(storeDir, "blocked");
      fs.writeFileSync(blockedPath, "not a directory\n");
      const cfg = config(
        { main: {}, blocked: {} },
        path.join(storeDir, "{agentId}", "history.json"),
      );
      const main = openOpenClawAgentDatabase({
        agentId: "main",
        env: state.env,
        path: path.join(storeDir, "main", "history.sqlite"),
      });
      const pending = prepareSourcesAsync(sourceParams(source(main), cfg));
      if (recovers) {
        fs.unlinkSync(blockedPath);
        fs.mkdirSync(blockedPath);
      }
      const prepared = await pending;
      expect(sourcesOf(prepared)).toEqual({
        main: [{ agentId: "main", path: main.path }],
        blocked: [],
      });
    });
  },
);

it("retains source preparation until directory or registry ownership changes", async () => {
  await withState(async () => {
    const { main, params, alias, replacement } = aliasSources();
    const first = await prepareSourcesAsync(params);
    const realpath = vi.spyOn(fs.realpathSync, "native");
    const stat = vi.spyOn(fs, "statSync");
    const readdir = vi.spyOn(fs, "readdirSync");
    syncBuiltinESMExports();
    const warm = await prepareSourcesAsync(params);
    expect(warm.request).toEqual(first.request);
    expect([realpath, stat, readdir].map((spy) => spy.mock.calls)).toEqual([[], [], []]);

    const directory = observedDirectories.find(
      (entry) => entry.active && entry.directory === path.dirname(main.path),
    );
    expect(directory).toBeDefined();
    directory!.notify("unrelated.txt");
    directory!.notify(path.basename(main.path));
    const revalidationReads = realpath.mock.calls.length;
    for (const entry of observedDirectories) {
      if (entry.active && entry.directory.startsWith(state.root)) {
        entry.notify();
      }
    }
    expect(realpath.mock.calls.length).toBe(revalidationReads);
    await Promise.resolve();
    releasedDirectories.length = 0;
    replaceAlias(alias, replacement);
    expect(sourcesOf(first).main).toEqual([]);
    await prepareSourcesAsync(params);
    expect(realpath).toHaveBeenCalled();
    expect(releasedDirectories).not.toContain(path.dirname(alias));
  });
});

it("reuses shared watches, prunes retired sources, and closes only with its state database", async () => {
  await withState(async () => {
    const { main, params } = mainSources();
    const prepared = await prepareSourcesAsync(params);
    releasedDirectories.length = 0;
    const other = openOpenClawStateDatabase({ path: state.path("other-state", "state.sqlite") });
    await closeOpenClawStateDatabaseByPathAsync(other.path);
    expect((await prepareSourcesAsync(params)).request).toBe(prepared.request);
    expect(releasedDirectories).toEqual([]);
    const ops = openOpenClawAgentDatabase({
      agentId: "ops",
      env: state.env,
      path: state.path("retired-watch", "ops.sqlite"),
    });
    const registered = await prepareSourcesAsync(params);
    expectRegistered(registered, ops);
    expect(releasedDirectories).toEqual([]);
    unregisterOpenClawAgentDatabase({ agentId: "ops", path: ops.path, env: state.env });
    const refreshed = await prepareSourcesAsync(params);
    expect(refreshed.request?.registeredDatabases.some((entry) => entry.agentId === "ops")).toBe(
      false,
    );
    expect(
      observedDirectories.some(
        (entry) => entry.active && entry.directory === path.dirname(ops.path),
      ),
    ).toBe(false);
    await closeOpenClawStateDatabaseByPathAsync(params.registryPath);
    expect(
      observedDirectories.some(
        (entry) => entry.active && entry.directory === path.dirname(main.path),
      ),
    ).toBe(false);
  });
});

it("does not resume directory observation after its root closes during preparation", async () => {
  await withState(async () => {
    const { params } = mainSources();
    const { entered, resume, spy } = holdRegistryRead();
    const pending = prepareSourcesAsync(params);
    void pending.catch(() => undefined);
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "Registry read not reached");
      await closeOpenClawStateDatabaseAsync();
      const observationCount = observedDirectories.length;
      expect(observedDirectories.some((entry) => entry.active)).toBe(false);
      resume.resolve();
      await expect(pending).rejects.toThrow("Session store changed");
      expect(observedDirectories).toHaveLength(observationCount);
    } finally {
      resume.resolve();
      spy.mockRestore();
      await pending.catch(() => undefined);
    }
  });
});

it.for([false, true])(
  "shares pending source outcomes and recovers (invalidated: %s)",
  async (invalidated, { signal }) => {
    await withState(async () => {
      const { main, params } = mainSources();
      const { entered, resume, spy } = holdRegistryRead();
      const first = prepareSourcesAsync(params);
      void first.catch(() => undefined);
      let second: ReturnType<typeof prepareSourcesAsync> | undefined;
      try {
        await withinTest(
          awaitGateBeforeSettlement(entered.promise, first, "Registry read not reached"),
          signal,
        );
        if (invalidated) {
          invalidateRegisteredAgentDatabasesMemo({ path: params.registryPath });
        }
        second = prepareSourcesAsync(params);
        const settled = Promise.allSettled([first, second]);
        resume.resolve();
        if (invalidated) {
          const [one, two] = await withinTest(settled, signal);
          if (one.status !== "rejected" || two.status !== "rejected") {
            throw new Error("Both source readers must retain the invalidated registry rejection");
          }
          expect(one.reason).toMatchObject({ name: "AgentDatabaseRegistryChangedError" });
          expect(two.reason).toBe(one.reason);
          expect(spy).toHaveBeenCalledOnce();
          expect(observedDirectories.some((entry) => entry.active)).toBe(false);
          const recovered = await withinTest(prepareSourcesAsync(params), signal);
          expectRegistered(recovered, main);
          expect(sourcesOf(recovered).main).toEqual([source(main)]);
          expect(spy).toHaveBeenCalledTimes(2);
        } else {
          const prepared = await withinTest(second, signal);
          expect(await withinTest(first, signal)).toEqual(prepared);
          expectRegistered(prepared, main);
          expect(spy).toHaveBeenCalledOnce();
        }
      } finally {
        resume.resolve();
        spy.mockRestore();
        await Promise.allSettled([first, second]);
      }
    });
  },
);
