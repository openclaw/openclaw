import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  AgentDatabaseRegistryChangedError,
  invalidateRegisteredAgentDatabasesMemo,
} from "../state/openclaw-agent-db-registry-listing.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  prepareGatewaySessionStoreReadSources,
  prepareGatewaySessionStoreReadSourcesAsync,
  resolveGatewaySessionStoreReadSources,
} from "./session-utils-store-sources.js";

it("bounds roster reads per preparation and observes later mutable fleet changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const agentIds = ["main", ...Array.from({ length: 47 }, (_, i) => `worker-${i}`)];
    let entryReads = 0;
    const entries = new Proxy(Object.fromEntries(agentIds.map((agentId) => [agentId, {}])), {
      get(target, property, receiver) {
        if (Object.hasOwn(target, property)) {
          entryReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries } };
    const prepare = () =>
      prepareGatewaySessionStoreReadSources({
        cfg,
        currentSource: { agentId: database.agentId, path: database.path },
        env: state.env,
        registryPath: openOpenClawStateDatabase().path,
      });

    const first = prepare();
    expect(Object.keys(first.sources)).toEqual(agentIds);
    expect(entryReads).toBeLessThan(agentIds.length * 16);

    entries.added = {};
    entryReads = 0;
    expect(Object.keys(prepare().sources)).toEqual([...agentIds, "added"]);
    expect(entryReads).toBeLessThan((agentIds.length + 1) * 16);
    expect(Object.keys(first.sources)).toEqual(agentIds);
  });
});

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

it("bounds fixed-store discovery per operation and refreshes the next source roster", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storeDir = state.path("stores");
    fs.mkdirSync(storeDir, { recursive: true });
    const storePath = path.join(storeDir, "shared.json");
    const agentIds = ["main", ...Array.from({ length: 11 }, (_, i) => `worker-${i}`)];
    const entries = Object.fromEntries(agentIds.map((agentId) => [agentId, {}]));
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries,
        defaults: { systemAgent: { agentId: "main" }, sessionStore: { agentId: "main" } },
      },
      session: { store: storePath },
    };
    const openStore = (agentId: string) =>
      openOpenClawAgentDatabase({
        agentId,
        env: state.env,
        path: path.join(
          storeDir,
          agentId === "main" ? "shared.sqlite" : `shared.${agentId}.sqlite`,
        ),
      });
    const databases = agentIds.map(openStore);
    const currentSource = { agentId: "main", path: databases[0]!.path };
    const prepare = () =>
      prepareGatewaySessionStoreReadSources({
        cfg,
        currentSource,
        env: state.env,
        registryPath: openOpenClawStateDatabase().path,
      });
    const expectedSources = () =>
      Object.fromEntries(
        databases.map(({ agentId, path: databasePath }) => [
          agentId,
          [{ agentId, path: databasePath }],
        ]),
      );
    const readdir = vi.spyOn(fs, "readdirSync");
    const realpathNative = vi.spyOn(fs.realpathSync, "native");
    syncBuiltinESMExports();
    const expectBoundedDiscovery = () => {
      const prepared = prepare();
      expect(prepared.sources).toEqual(expectedSources());
      expect(prepared.sources.main?.[0]).toBe(currentSource);
      const databasePaths = new Set(databases.map(({ path: databasePath }) => databasePath));
      const identityReads = realpathNative.mock.calls.flatMap(([pathname]) =>
        typeof pathname === "string" && databasePaths.has(pathname) ? [pathname] : [],
      );
      expect(new Set(identityReads)).toEqual(databasePaths);
      expect(identityReads.length).toBeLessThanOrEqual(databases.length * 4);
      expect(
        readdir.mock.calls.filter(([pathname]) => pathname === storeDir).length,
      ).toBeLessThanOrEqual(databases.length * 8);
      return prepared;
    };
    try {
      const first = expectBoundedDiscovery();
      entries.added = {};
      databases.push(openStore("added"));
      readdir.mockClear();
      realpathNative.mockClear();
      const second = expectBoundedDiscovery();
      expect(Object.keys(first.sources)).toEqual(agentIds);
      expect(Object.keys(second.sources)).toEqual([...agentIds, "added"]);
    } finally {
      readdir.mockRestore();
      realpathNative.mockRestore();
      syncBuiltinESMExports();
    }
  });
});

it("keeps deferred discovery unbound until first use and rejects prior registry churn", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const options = {
      cfg: {},
      currentSource: { agentId: database.agentId, path: database.path },
      env: state.env,
      registryPath: openOpenClawStateDatabase().path,
      deferSources: true,
    };
    const unread = prepareGatewaySessionStoreReadSources(options);
    const bound = prepareGatewaySessionStoreReadSources(options);
    expect(bound.sources.main).toEqual([options.currentSource]);
    invalidateRegisteredAgentDatabasesMemo({ path: options.registryPath });
    expect(bound.assertCurrent).not.toThrow();
    expect(unread.assertCurrent).toThrow("Session store changed");
    expect(() => unread.sources).toThrow("Session store changed");
  });
});

it("rejects a retargeted filesystem alias after registry metadata refresh", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const alias = state.path("store-alias");
    const replacement = state.path("replacement-store");
    fs.mkdirSync(replacement);
    fs.copyFileSync(database.path, path.join(replacement, path.basename(database.path)));
    fs.symlinkSync(
      path.dirname(database.path),
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const currentSource = {
      agentId: database.agentId,
      path: path.join(alias, path.basename(database.path)),
    };
    const registryPath = openOpenClawStateDatabase().path;
    const prepared = prepareGatewaySessionStoreReadSources({
      cfg: {},
      currentSource,
      env: state.env,
      registryPath,
    });
    expect(prepared.sources.main?.[0]).toBe(currentSource);
    fs.unlinkSync(alias);
    fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");
    invalidateRegisteredAgentDatabasesMemo({ path: registryPath });
    expect(prepared.assertCurrent).toThrow("Session store changed");
  });
});

it("rejects replacement of the existing parent of a missing source", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const parent = state.path("future-store");
    fs.mkdirSync(parent);
    const currentSource = { agentId: "main", path: path.join(parent, "sessions.sqlite") };
    const registryPath = openOpenClawStateDatabase().path;
    const prepared = prepareGatewaySessionStoreReadSources({
      cfg: { session: { store: currentSource.path } },
      currentSource,
      env: state.env,
      registryPath,
    });
    expect(prepared.sources.main?.[0]).toBe(currentSource);
    fs.renameSync(parent, `${parent}.previous`);
    fs.mkdirSync(parent);
    invalidateRegisteredAgentDatabasesMemo({ path: registryPath });
    expect(prepared.assertCurrent).toThrow("Session store changed");
  });
});

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
      await prepared.revalidate(() => {});
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
      await prepared.revalidate(() => {});
      prepared.assertCurrent();
    });
  },
);

it.each(["registration", "repeated registration", "source retirement", "read failure"] as const)(
  "preserves source discovery after %s during the first registry read",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const registryPath = openOpenClawStateDatabase().path;
      const currentSource = { agentId: database.agentId, path: database.path };
      const register = () => registerOpenClawAgentDatabase({ ...currentSource, env: state.env });
      invalidateRegisteredAgentDatabasesMemo({ path: registryPath });
      const held = createDeferredCore();
      const release = createDeferredCore();
      const failure = new Error("Synthetic registry read failure");
      const read = stateReads.executeExistingOpenClawStateRead;
      let firstRead = true;
      const observation = vi
        .spyOn(stateReads, "executeExistingOpenClawStateRead")
        .mockImplementation(async (...args) => {
          const reply = await read(...args);
          if (args[1].type !== "agentDatabaseRegistry.read") {
            return reply;
          }
          if (firstRead) {
            firstRead = false;
            held.resolve();
            await release.promise;
          } else if (change === "repeated registration") {
            register();
          }
          if (change === "read failure") {
            throw failure;
          }
          return reply;
        });
      const pending = prepareGatewaySessionStoreReadSourcesAsync({
        cfg: {},
        currentSource,
        env: state.env,
        registryPath,
      });
      try {
        await Promise.race([
          held.promise,
          pending.then(() => {
            throw new Error("Source discovery completed before the held registry reply");
          }),
        ]);
        if (change === "source retirement") {
          await closeOpenClawStateDatabaseByPathAsync(registryPath);
          openOpenClawStateDatabase({ env: state.env });
        } else {
          register();
        }
        release.resolve();
        if (change === "source retirement") {
          await expect(pending).rejects.toMatchObject({
            code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
          });
        } else if (change === "read failure") {
          await expect(pending).rejects.toBe(failure);
        } else if (change === "repeated registration") {
          await expect(pending).rejects.toBeInstanceOf(AgentDatabaseRegistryChangedError);
        } else {
          const prepared = await pending;
          expect(prepared.request).toBeDefined();
          expect(resolveGatewaySessionStoreReadSources(prepared.request!).sources.main).toEqual([
            currentSource,
          ]);
          prepared.assertCurrent();
        }
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
        observation.mockRestore();
      }
    });
  },
);
