import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
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
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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

import {
  prepareGatewaySessionStoreReadSources,
  prepareGatewaySessionStoreReadSourcesAsync,
  resolveGatewaySessionStoreReadSources,
} from "./session-utils-store-sources.js";

it.each([false, true])(
  "bounds discovery and refreshes only the next roster (fixed: %s)",
  async (fixed) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries,
          ...(fixed
            ? { defaults: { systemAgent: { agentId: "main" }, sessionStore: { agentId: "main" } } }
            : {}),
        },
        ...(fixed ? { session: { store: path.join(storeDir, "shared.json") } } : {}),
      };
      const openStore = (agentId: string) =>
        openOpenClawAgentDatabase({
          agentId,
          env: state.env,
          ...(fixed
            ? {
                path: path.join(
                  storeDir,
                  agentId === "main" ? "shared.sqlite" : `shared.${agentId}.sqlite`,
                ),
              }
            : {}),
        });
      const databases = (fixed ? agentIds : ["main"]).map(openStore);
      const currentSource = { agentId: "main", path: databases[0]!.path };
      const readdir = vi.spyOn(fs, "readdirSync");
      const realpath = vi.spyOn(fs.realpathSync, "native");
      syncBuiltinESMExports();
      const prepare = () => {
        entryReads = 0;
        const prepared = prepareGatewaySessionStoreReadSources({
          cfg,
          currentSource,
          env: state.env,
          registryPath: openOpenClawStateDatabase().path,
        });
        expect(Object.keys(prepared.sources)).toEqual(Object.keys(entries));
        expect(prepared.sources.main?.[0]).toBe(currentSource);
        expect(entryReads).toBeLessThan(Object.keys(entries).length * 16);
        if (fixed) {
          expect(prepared.sources).toEqual(
            Object.fromEntries(
              databases.map(({ agentId, path: storePath }) => [
                agentId,
                [{ agentId, path: storePath }],
              ]),
            ),
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
      try {
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
      } finally {
        readdir.mockRestore();
        realpath.mockRestore();
        syncBuiltinESMExports();
      }
    });
  },
);

it("binds source addresses before asynchronous callers yield", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const currentSource = { agentId: database.agentId, path: database.path };
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const env = { ...state.env };
    const prepared = prepareGatewaySessionStoreReadSources({
      cfg,
      currentSource,
      env,
      registryPath: openOpenClawStateDatabase().path,
    });

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
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const parent = state.path("source-parent");
      const replacement = state.path("replacement-store");
      fs.mkdirSync(replacement);
      let currentSource;
      if (kind === "alias") {
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        fs.copyFileSync(database.path, path.join(replacement, path.basename(database.path)));
        fs.symlinkSync(
          path.dirname(database.path),
          parent,
          process.platform === "win32" ? "junction" : "dir",
        );
        currentSource = {
          agentId: database.agentId,
          path: path.join(parent, path.basename(database.path)),
        };
      } else {
        fs.mkdirSync(parent);
        currentSource = { agentId: "main", path: path.join(parent, "sessions.sqlite") };
      }
      const registryPath = openOpenClawStateDatabase().path;
      const prepared = prepareGatewaySessionStoreReadSources({
        cfg: kind === "alias" ? {} : { session: { store: currentSource.path } },
        currentSource,
        env: state.env,
        registryPath,
      });
      expect(prepared.sources.main?.[0]).toBe(currentSource);
      if (kind === "alias") {
        fs.unlinkSync(parent);
        fs.symlinkSync(replacement, parent, process.platform === "win32" ? "junction" : "dir");
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
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storeDir = state.path("stores");
    fs.mkdirSync(storeDir, { recursive: true });
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { main: { name: "not-a-routing-field" }, ops: {}, future: {} },
        defaults: { systemAgent: { agentId: "main" }, sessionStore: { agentId: "main" } },
      },
      session: { store: path.join(storeDir, "shared.json") },
    };
    const main = openOpenClawAgentDatabase({
      agentId: "main",
      env: state.env,
      path: path.join(storeDir, "shared.sqlite"),
    });
    const ops = openOpenClawAgentDatabase({
      agentId: "ops",
      env: state.env,
      path: path.join(storeDir, "shared.ops.sqlite"),
    });
    const retired = openOpenClawAgentDatabase({
      agentId: "retired",
      env: state.env,
      path: state.path("retired-location", "history.sqlite"),
    });
    const currentSource = { agentId: main.agentId, path: main.path };
    const registryPath = openOpenClawStateDatabase().path;
    invalidateRegisteredAgentDatabasesMemo({ path: registryPath });
    // Retire fixture writers so their checkpoint timers cannot enter the read-only SQL probe.
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    const sql = observeMainThreadSql();
    let prepared: Awaited<ReturnType<typeof prepareGatewaySessionStoreReadSourcesAsync>>;
    try {
      sql.calibrate();
      prepared = await prepareGatewaySessionStoreReadSourcesAsync({
        cfg,
        currentSource,
        env: state.env,
        registryPath,
      });
      prepared.assertCurrent();
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    if (!prepared.request) {
      throw new Error("Expected source routing request");
    }
    expect(JSON.stringify(prepared.request)).not.toContain("not-a-routing-field");
    const { sources } = resolveGatewaySessionStoreReadSources(prepared.request);
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
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storeDir = state.path("stores");
      fs.mkdirSync(storeDir, { recursive: true });
      const blockedPath = path.join(storeDir, "blocked");
      fs.writeFileSync(blockedPath, "not a directory\n");
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { main: {}, blocked: {} },
          defaults: { systemAgent: { agentId: "main" }, sessionStore: { agentId: "main" } },
        },
        session: { store: path.join(storeDir, "{agentId}", "history.json") },
      };
      const main = openOpenClawAgentDatabase({
        agentId: "main",
        env: state.env,
        path: path.join(storeDir, "main", "history.sqlite"),
      });
      const pending = prepareGatewaySessionStoreReadSourcesAsync({
        cfg,
        env: state.env,
        registryPath: openOpenClawStateDatabase().path,
        currentSource: { agentId: main.agentId, path: main.path },
      });
      if (recovers) {
        fs.unlinkSync(blockedPath);
        fs.mkdirSync(blockedPath);
      }
      const prepared = await pending;
      if (!prepared.request) {
        throw new Error("Expected source routing request");
      }
      expect(resolveGatewaySessionStoreReadSources(prepared.request).sources).toEqual({
        main: [{ agentId: "main", path: main.path }],
        blocked: [],
      });
      prepared.assertCurrent();
    });
  },
);

it("retains source preparation until directory or registry ownership changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const main = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const registryPath = openOpenClawStateDatabase().path;
    const alias = state.path("source-alias");
    const replacement = state.path("replacement");
    fs.mkdirSync(replacement);
    fs.writeFileSync(path.join(replacement, path.basename(main.path)), "synthetic replacement");
    fs.symlinkSync(
      path.dirname(main.path),
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const params = {
      cfg: { agents: { ownership: "explicit", entries: { main: {} } } } satisfies OpenClawConfig,
      currentSource: { agentId: "main", path: path.join(alias, path.basename(main.path)) },
      env: state.env,
      registryPath,
    };
    const first = await prepareGatewaySessionStoreReadSourcesAsync(params);
    const realpath = vi.spyOn(fs.realpathSync, "native");
    const stat = vi.spyOn(fs, "statSync");
    const readdir = vi.spyOn(fs, "readdirSync");
    syncBuiltinESMExports();
    try {
      const warm = await prepareGatewaySessionStoreReadSourcesAsync(params);
      first.assertCurrent();
      warm.assertCurrent();
      expect(warm.request).toEqual(first.request);
      expect(realpath).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
      expect(readdir).not.toHaveBeenCalled();

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
      fs.unlinkSync(alias);
      fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");
      for (const entry of observedDirectories) {
        if (entry.active && entry.directory === path.dirname(alias)) {
          entry.notify(path.basename(alias));
        }
      }
      expect(first.assertCurrent).toThrow("Session store changed");
      const refreshed = await prepareGatewaySessionStoreReadSourcesAsync(params);
      refreshed.assertCurrent();
      expect(realpath).toHaveBeenCalled();

      const ops = openOpenClawAgentDatabase({ agentId: "ops", env: state.env });
      expect(refreshed.assertCurrent).toThrow("Session store changed");
      const registered = await prepareGatewaySessionStoreReadSourcesAsync(params);
      expect(registered.request?.registeredDatabases).toEqual(
        expect.arrayContaining([expect.objectContaining({ agentId: "ops", path: ops.path })]),
      );
    } finally {
      readdir.mockRestore();
      stat.mockRestore();
      realpath.mockRestore();
      syncBuiltinESMExports();
    }
  });
});

async function prepareMainSources(state: { env: NodeJS.ProcessEnv }) {
  const main = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  const registryPath = openOpenClawStateDatabase().path;
  const params = {
    cfg: { agents: { ownership: "explicit", entries: { main: {} } } } satisfies OpenClawConfig,
    currentSource: { agentId: "main", path: main.path },
    env: state.env,
    registryPath,
  };
  const prepared = await prepareGatewaySessionStoreReadSourcesAsync(params);
  releasedDirectories.length = 0;
  return { main, params, prepared, registryPath };
}

it("retains source preparation when another state database closes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { main, prepared, registryPath } = await prepareMainSources(state);
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
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { params, prepared } = await prepareMainSources(state);
    const ops = openOpenClawAgentDatabase({ agentId: "ops", env: state.env });
    expect(prepared.assertCurrent).toThrow("Session store changed");
    const registered = await prepareGatewaySessionStoreReadSourcesAsync(params);
    expect(registered.request?.registeredDatabases).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: "ops", path: ops.path })]),
    );
    expect(releasedDirectories).toEqual([]);
  });
});

it("keeps shared directories observed after a source path changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const main = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const alias = state.path("source-alias");
    const replacement = state.path("replacement");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.mkdirSync(replacement);
    fs.writeFileSync(path.join(replacement, path.basename(main.path)), "synthetic replacement");
    fs.symlinkSync(path.dirname(main.path), alias, linkType);
    const params = {
      cfg: { agents: { ownership: "explicit", entries: { main: {} } } } satisfies OpenClawConfig,
      currentSource: { agentId: "main", path: path.join(alias, path.basename(main.path)) },
      env: state.env,
      registryPath: openOpenClawStateDatabase().path,
    };
    const first = await prepareGatewaySessionStoreReadSourcesAsync(params);
    releasedDirectories.length = 0;
    fs.unlinkSync(alias);
    fs.symlinkSync(replacement, alias, linkType);
    for (const entry of observedDirectories) {
      if (entry.active && entry.directory === path.dirname(alias)) {
        entry.notify(path.basename(alias));
      }
    }
    expect(first.assertCurrent).toThrow("Session store changed");
    const refreshed = await prepareGatewaySessionStoreReadSourcesAsync(params);
    refreshed.assertCurrent();
    expect(releasedDirectories).not.toContain(path.dirname(alias));
  });
});

it("does not resume directory observation after its root closes during preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const main = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const registryPath = openOpenClawStateDatabase().path;
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
    const pending = prepareGatewaySessionStoreReadSourcesAsync({
      cfg: { agents: { ownership: "explicit", entries: { main: {} } } },
      currentSource: { agentId: "main", path: main.path },
      env: state.env,
      registryPath,
    });
    void pending.catch(() => undefined);
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        pending,
        "Source preparation did not await registry rows",
      );
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
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const main = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const params = {
      cfg: { agents: { ownership: "explicit", entries: { main: {} } } } satisfies OpenClawConfig,
      currentSource: { agentId: "main", path: main.path },
      env: state.env,
      registryPath: openOpenClawStateDatabase().path,
    };
    const entered = createDeferred();
    const resume = createDeferred();
    const prepare = registryListing.prepareOpenClawAgentDatabaseRegistrySnapshotRead;
    const spy = vi
      .spyOn(registryListing, "prepareOpenClawAgentDatabaseRegistrySnapshotRead")
      .mockImplementation((...args) => {
        const prepared = prepare(...args);
        return {
          ...prepared,
          async read(readSignal) {
            const result = await prepared.read(readSignal);
            entered.resolve();
            await resume.promise;
            return result;
          },
        };
      });
    const controller = new AbortController();
    const first = prepareGatewaySessionStoreReadSourcesAsync(params, controller.signal);
    void first.catch(() => undefined);
    let second: ReturnType<typeof prepareGatewaySessionStoreReadSourcesAsync> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          first,
          "Source preparation did not await registry rows",
        ),
        signal,
      );
      second = prepareGatewaySessionStoreReadSourcesAsync(params);
      const reason = new Error("Caller cancelled source discovery");
      controller.abort(reason);
      await withinTest(expect(first).rejects.toBe(reason), signal);
      resume.resolve();
      const prepared = await withinTest(second, signal);
      expect(prepared.request?.registeredDatabases).toEqual(
        expect.arrayContaining([expect.objectContaining({ agentId: "main", path: main.path })]),
      );
      prepared.assertCurrent();
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      resume.resolve();
      spy.mockRestore();
      await Promise.allSettled([first, second]);
    }
  });
});
