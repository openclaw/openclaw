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
import {
  prepareGatewaySessionStoreReadSources as prepareSources,
  prepareGatewaySessionStoreReadSourcesAsync as prepareSourcesAsync,
} from "./session-utils-store-sources.js";

const linkType = process.platform === "win32" ? "junction" : "dir";
type SourceParams = Parameters<typeof prepareSources>[0];
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
      const prepare = () => {
        entryReads = 0;
        const prepared = prepareSources(sourceParams(currentSource, cfg));
        expect(Object.keys(prepared.sources)).toEqual(Object.keys(entries));
        expect(prepared.sources.main?.[0]).toBe(currentSource);
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
      const first = prepare();
      entries.added = {};
      if (fixed) {
        databases.push(openStore("added"));
      }
      readdir.mockClear();
      realpath.mockClear();
      const second = prepare();
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
    const prepared = prepareSources(sourceParams(currentSource, cfg, env));

    await Promise.resolve();
    cfg.session = { store: path.join(state.stateDir, "moved", "{agentId}", "sessions.json") };
    env.OPENCLAW_STATE_DIR = state.path("different-state");

    for (let refresh = 0; refresh < 2; refresh++) {
      invalidateRegisteredAgentDatabasesMemo({ path: openOpenClawStateDatabase().path });
      expect(() => prepared.assertCurrent()).not.toThrow();
      expect(prepared.sources.main).toEqual([currentSource]);
      expect(prepared.sources.main?.[0]).toBe(currentSource);
    }
  });
});

it.each(["alias", "missing-parent"] as const)(
  "rejects replacement of a captured %s after registry refresh",
  async (kind) => {
    await withState(async () => {
      const parent = state.path("source-parent");
      const replacement = state.path("replacement-store");
      fs.mkdirSync(replacement);
      let currentSource;
      if (kind === "alias") {
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        fs.copyFileSync(database.path, path.join(replacement, path.basename(database.path)));
        fs.symlinkSync(path.dirname(database.path), parent, linkType);
        currentSource = {
          agentId: database.agentId,
          path: path.join(parent, path.basename(database.path)),
        };
      } else {
        fs.mkdirSync(parent);
        currentSource = { agentId: "main", path: path.join(parent, "sessions.sqlite") };
      }
      const registryPath = openOpenClawStateDatabase().path;
      const prepared = prepareSources(
        sourceParams(
          currentSource,
          kind === "alias" ? {} : { session: { store: currentSource.path } },
        ),
      );
      expect(prepared.sources.main?.[0]).toBe(currentSource);
      if (kind === "alias") {
        fs.unlinkSync(parent);
        fs.symlinkSync(replacement, parent, linkType);
      } else {
        fs.renameSync(parent, `${parent}.previous`);
        fs.mkdirSync(parent);
      }
      invalidateRegisteredAgentDatabasesMemo({ path: registryPath });
      expect(prepared.assertCurrent).toThrow("Session store changed");
    });
  },
);

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
      prepared.assertCurrent();
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    const request = expectDefined(prepared.request, "source routing request");
    expect(JSON.stringify(request)).not.toContain("not-a-routing-field");
    const { sources } = resolveSources(request);
    expect(sources).toEqual({
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
      const request = expectDefined(prepared.request, "source routing request");
      expect(resolveSources(request).sources).toEqual({
        main: [{ agentId: "main", path: main.path }],
        blocked: [],
      });
      prepared.assertCurrent();
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
    first.assertCurrent();
    warm.assertCurrent();
    expect(warm.request).toEqual(first.request);
    expect([realpath, stat, readdir].map((spy) => spy.mock.calls)).toEqual([[], [], []]);

    const directory = observedDirectories.find(
      (entry) => entry.active && entry.directory === path.dirname(main.path),
    );
    expect(directory).toBeDefined();
    directory!.notify("unrelated.txt");
    expect(first.assertCurrent).not.toThrow();
    directory!.notify(path.basename(main.path));
    expect(first.assertCurrent).not.toThrow();
    const revalidationReads = realpath.mock.calls.length;
    for (const entry of observedDirectories) {
      if (entry.active && entry.directory.startsWith(state.root)) {
        entry.notify();
      }
    }
    expect(realpath.mock.calls.length).toBe(revalidationReads);
    await Promise.resolve();
    replaceAlias(alias, replacement);
    expect(first.assertCurrent).toThrow("Session store changed");
    const refreshed = await prepareSourcesAsync(params);
    refreshed.assertCurrent();
    expect(realpath).toHaveBeenCalled();

    const ops = openOpenClawAgentDatabase({ agentId: "ops", env: state.env });
    expect(refreshed.assertCurrent).toThrow("Session store changed");
    const registered = await prepareSourcesAsync(params);
    expectRegistered(registered, ops);
  });
});

async function prepareMainSources() {
  const { main, params } = mainSources();
  const prepared = await prepareSourcesAsync(params);
  releasedDirectories.length = 0;
  return { main, params, prepared, registryPath: params.registryPath };
}

it("retains source preparation when another state database closes", async () => {
  await withState(async () => {
    const { main, prepared, registryPath } = await prepareMainSources();
    const other = openOpenClawStateDatabase({ path: state.path("other-state", "state.sqlite") });
    await closeOpenClawStateDatabaseByPathAsync(other.path);
    expect(prepared.assertCurrent).not.toThrow();
    expect(releasedDirectories).toEqual([]);

    await closeOpenClawStateDatabaseByPathAsync(registryPath);
    expect(prepared.assertCurrent).toThrow("Session store changed");
    expect(
      observedDirectories.some(
        (entry) => entry.active && entry.directory === path.dirname(main.path),
      ),
    ).toBe(false);
  });
});

it("keeps shared directories observed while a registry generation refreshes", async () => {
  await withState(async () => {
    const { params, prepared } = await prepareMainSources();
    const ops = openOpenClawAgentDatabase({ agentId: "ops", env: state.env });
    expect(prepared.assertCurrent).toThrow("Session store changed");
    const registered = await prepareSourcesAsync(params);
    expectRegistered(registered, ops);
    expect(releasedDirectories).toEqual([]);
  });
});

it("keeps shared directories observed after a source path changes", async () => {
  await withState(async () => {
    const { params, alias, replacement } = aliasSources();
    const first = await prepareSourcesAsync(params);
    releasedDirectories.length = 0;
    replaceAlias(alias, replacement);
    expect(first.assertCurrent).toThrow("Session store changed");
    const refreshed = await prepareSourcesAsync(params);
    refreshed.assertCurrent();
    expect(releasedDirectories).not.toContain(path.dirname(alias));
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

it("cancels one waiter while retaining shared source preparation", async ({ signal }) => {
  await withState(async () => {
    const { main, params } = mainSources();
    const { entered, resume, spy } = holdRegistryRead();
    const controller = new AbortController();
    const first = prepareSourcesAsync(params, controller.signal);
    void first.catch(() => undefined);
    let second: ReturnType<typeof prepareSourcesAsync> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, first, "Registry read not reached"),
        signal,
      );
      second = prepareSourcesAsync(params);
      const reason = new Error("Caller cancelled source discovery");
      controller.abort(reason);
      await withinTest(expect(first).rejects.toBe(reason), signal);
      resume.resolve();
      const prepared = await withinTest(second, signal);
      expectRegistered(prepared, main);
      prepared.assertCurrent();
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      resume.resolve();
      spy.mockRestore();
      await Promise.allSettled([first, second]);
    }
  });
});
