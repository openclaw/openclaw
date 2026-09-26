import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  AgentDatabaseRegistryChangedError,
  invalidateRegisteredAgentDatabasesMemo,
} from "../state/openclaw-agent-db-registry-listing.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import * as stateRead from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
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

it.each(["registry refresh", "repeated refresh", "retarget"] as const)(
  "bounds source discovery recovery across %s before the registry reply",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const alias = state.path("source-alias");
      const replacement = state.path("replacement-source");
      fs.mkdirSync(replacement);
      fs.copyFileSync(database.path, path.join(replacement, path.basename(database.path)));
      const linkType = process.platform === "win32" ? "junction" : "dir";
      fs.symlinkSync(path.dirname(database.path), alias, linkType);
      const currentSource = {
        agentId: database.agentId,
        path: path.join(alias, path.basename(database.path)),
      };
      const registryPath = openOpenClawStateDatabase().path;
      invalidateRegisteredAgentDatabasesMemo({ path: registryPath });
      const read = stateRead.executeExistingOpenClawStateRead;
      let reads = 0;
      const observation = vi
        .spyOn(stateRead, "executeExistingOpenClawStateRead")
        .mockImplementation(async (...args) => {
          const reply = await read(...args);
          if (args[1].type === "agentDatabaseRegistry.read") {
            reads++;
            if (reads === 1 || change === "repeated refresh") {
              invalidateRegisteredAgentDatabasesMemo({ path: registryPath });
            }
            if (change === "retarget") {
              fs.unlinkSync(alias);
              fs.symlinkSync(replacement, alias, linkType);
            }
          }
          return reply;
        });
      try {
        const pending = prepareGatewaySessionStoreReadSourcesAsync({
          cfg: { agents: { entries: { main: {} } } },
          currentSource,
          env: state.env,
          registryPath,
        });
        if (change === "registry refresh") {
          const prepared = await pending;
          expect(
            prepared.request &&
              resolveGatewaySessionStoreReadSources(prepared.request).sources.main,
          ).toEqual([currentSource]);
          expect(prepared.assertCurrent).not.toThrow();
          expect(reads).toBe(2);
        } else if (change === "repeated refresh") {
          await expect(pending).rejects.toBeInstanceOf(AgentDatabaseRegistryChangedError);
          expect(reads).toBe(2);
        } else {
          await expect(pending).rejects.toThrow("Session store changed");
          expect(reads).toBe(1);
        }
      } finally {
        observation.mockRestore();
      }
    });
  },
);

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
