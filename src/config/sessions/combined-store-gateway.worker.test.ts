import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  loadUsageSessionContext,
  type UsageSessionSelection,
} from "../../gateway/server-methods/usage-session-selection.js";
import type { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { readAgentDatabaseDeletionSnapshot } from "../../state/agent-deletion-journal.read.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
} from "../../state/openclaw-agent-db-lifecycle.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import * as configEnv from "../config-env-vars.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { loadCombinedSessionStoreForGatewayCoreAsync } from "./combined-store-gateway-read.js";
import { loadCombinedSessionStoreForGatewayCore } from "./combined-store-gateway.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import * as transcriptWorker from "./session-transcript-worker-runtime.js";

const boundary = vi.hoisted(
  (): {
    beforeRequest: ((request: unknown) => void) | undefined;
    afterReply: ((reply: unknown) => Promise<void>) | undefined;
  } => ({
    beforeRequest: undefined,
    afterReply: undefined,
  }),
);
vi.mock("../../infra/worker-task-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/worker-task-pool.js")>();
  return {
    ...actual,
    createOwnedWorkerTaskPool: <Input, Output>(
      ...poolArgs: Parameters<typeof actual.createOwnedWorkerTaskPool<Input, Output>>
    ) => {
      const pool = actual.createOwnedWorkerTaskPool<Input, Output>(...poolArgs);
      return {
        ...pool,
        run(...args: Parameters<WorkerTaskPool<Input, Output>["run"]>) {
          const [input, options] = args;
          const beforeRequest = boundary.beforeRequest;
          const prepare = typeof input === "function" ? input : () => input;
          const result = pool.run(
            beforeRequest
              ? new Proxy(prepare, {
                  async apply(target, receiver, parameters) {
                    const request: unknown = await Reflect.apply(target, receiver, parameters);
                    beforeRequest(request);
                    return request;
                  },
                })
              : input,
            options,
          );
          const observe = boundary.afterReply;
          return observe
            ? result.then(async (reply) => {
                await observe(reply);
                return reply;
              })
            : result;
        },
      };
    },
  };
});

it("revokes a prepared listing when its canonical owner closes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const scope = { agentId: "main", sessionKey: "agent:main:main" };
    replaceSessionEntrySync(scope, { sessionId: "before-close", updatedAt: 1 });
    const pending = loadCombinedSessionStoreForGatewayCoreAsync(cfg).then(
      () => "returned",
      () => "revoked",
    );
    await closeOpenClawAgentDatabasesAsync();
    replaceSessionEntrySync(scope, { sessionId: "after-close", updatedAt: 2 });
    expect(await pending).toBe("revoked");
    expect(
      (await loadCombinedSessionStoreForGatewayCoreAsync(cfg)).store[scope.sessionKey],
    ).toMatchObject({ sessionId: "after-close" });
  });
});

it.each(["listing", "context"] as const)(
  "retains later stores while an earlier %s read settles",
  async (read) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {}, other: {} } } };
      for (const agentId of ["main", "other"]) {
        replaceSessionEntrySync(
          { agentId, sessionKey: `agent:${agentId}:main` },
          {
            sessionId: `${agentId}-before-close`,
            updatedAt: 1,
          },
        );
      }
      const other = openOpenClawAgentDatabase({ agentId: "other" });
      const selected: UsageSessionSelection[] = ["main", "other"].map((agentId) => ({
        agentId,
        key: `agent:${agentId}:main`,
        sessionId: `${agentId}-before-close`,
        sessionFile: resolveOpenClawAgentSqlitePath({ agentId }),
        updatedAt: 1,
        instances: [],
        contextTarget: {
          storeTarget: { agentId, storePath: resolveOpenClawAgentSqlitePath({ agentId }) },
          storedKey: `agent:${agentId}:main`,
        },
      }));
      const requestKind = read === "listing" ? "session-entry-list" : "session-exact-entries";
      let replaced = false;
      const completedKeys: unknown[] = [];
      boundary.afterReply = async (reply) => {
        if (
          isRecord(reply) &&
          reply.ok === true &&
          isRecord(reply.value) &&
          reply.value.kind === requestKind &&
          Array.isArray(reply.value.entries)
        ) {
          completedKeys.push(
            ...reply.value.entries.map((row) => (isRecord(row) ? row.sessionKey : undefined)),
          );
          if (!replaced) {
            expect(completedKeys).toEqual(["agent:main:main"]);
            replaced = true;
            await closeOpenClawAgentDatabaseByPathAsync(other.path, "other");
            replaceSessionEntrySync(
              { agentId: "other", sessionKey: "agent:other:main" },
              {
                sessionId: "other-successor",
                updatedAt: 2,
              },
            );
          }
        }
      };
      try {
        await expect(
          read === "listing"
            ? loadCombinedSessionStoreForGatewayCoreAsync(cfg)
            : loadUsageSessionContext(selected),
        ).rejects.toThrow();
        expect(replaced).toBe(true);
      } finally {
        boundary.afterReply = undefined;
      }
      expect(
        (await loadCombinedSessionStoreForGatewayCoreAsync(cfg)).store["agent:other:main"],
      ).toMatchObject({ sessionId: "other-successor" });
    });
  },
);

it.each([
  { read: "listing", suppliedDiscovery: false, restoreBeforeConsume: false },
  { read: "listing", suppliedDiscovery: true, restoreBeforeConsume: false },
  { read: "listing", suppliedDiscovery: false, restoreBeforeConsume: true },
  { read: "listing", suppliedDiscovery: true, restoreBeforeConsume: true },
  { read: "context", suppliedDiscovery: false, restoreBeforeConsume: false },
  { read: "context", suppliedDiscovery: false, restoreBeforeConsume: true },
])(
  "refuses physical $read replacement (supplied: $suppliedDiscovery, ABA: $restoreBeforeConsume)",
  async ({ read, suppliedDiscovery, restoreBeforeConsume }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = { agentId: "main", sessionKey: "agent:main:physical-listing" };
      replaceSessionEntrySync(scope, { sessionId: "original", updatedAt: 1 });
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      await closeOpenClawAgentDatabasesAsync();
      const replacement = state.statePath("replacement.sqlite");
      const retained = state.statePath("retained.sqlite");
      // Identical valid bytes must not let a replacement physical database inherit the read.
      fs.copyFileSync(databasePath, replacement);
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      const discovery = suppliedDiscovery
        ? { env: state.env, snapshot: readAgentDatabaseDeletionSnapshot(state.env, "runtime") }
        : undefined;
      const requestKind = read === "listing" ? "session-entry-list" : "session-exact-entries";
      let replaced = false;
      let restored = false;
      const replace = () => {
        fs.renameSync(databasePath, retained);
        fs.renameSync(replacement, databasePath);
        replaced = true;
      };
      const restore = () => {
        if (replaced && !restored) {
          fs.renameSync(databasePath, replacement);
          fs.renameSync(retained, databasePath);
          restored = true;
        }
      };
      boundary.beforeRequest = (request) => {
        if (restoreBeforeConsume && isRecord(request) && request.kind === requestKind) {
          replace();
        }
      };
      boundary.afterReply = async (reply) => {
        if (restoreBeforeConsume && replaced) {
          restore();
        } else if (isRecord(reply) && isRecord(reply.value) && reply.value.kind === requestKind) {
          replace();
        }
      };
      try {
        const selection: UsageSessionSelection = {
          agentId: scope.agentId,
          key: scope.sessionKey,
          sessionId: "original",
          sessionFile: databasePath,
          updatedAt: 1,
          instances: [],
          contextTarget: {
            storeTarget: { agentId: scope.agentId, storePath: databasePath },
            storedKey: scope.sessionKey,
          },
        };
        await expect(
          read === "listing"
            ? loadCombinedSessionStoreForGatewayCoreAsync(cfg, { discovery })
            : loadUsageSessionContext([selection]),
        ).rejects.toThrow(/physical owner|database.*changed|file identity changed/i);
        expect(replaced).toBe(true);
        expect(restored).toBe(restoreBeforeConsume);
      } finally {
        boundary.beforeRequest = undefined;
        boundary.afterReply = undefined;
        restore();
      }
    });
  },
);

it("retains physical targets selected before ambient state changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:main" },
      {
        sessionId: "captured-root",
        updatedAt: 1,
      },
    );
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const read = vi.spyOn(transcriptWorker, "withSessionHistoryWorkerDatabases");
    const originalRoot = process.env.OPENCLAW_STATE_DIR;
    const changedRoot = state.statePath("other-state");
    try {
      const pending = loadCombinedSessionStoreForGatewayCoreAsync(cfg);
      process.env.OPENCLAW_STATE_DIR = changedRoot;
      await expect(pending).rejects.toThrow("Session stores changed");
      expect(read.mock.calls[0]?.[0][0]?.agentId).toBe("main");
      expect(read.mock.calls[0]?.[0][0]?.path).toBe(database.path);
      expect(read.mock.calls[0]?.[0][0]?.env?.OPENCLAW_STATE_DIR).toBe(originalRoot);
      expect(fs.existsSync(changedRoot)).toBe(false);
    } finally {
      if (originalRoot === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalRoot;
      }
      read.mockRestore();
    }
  });
});

it.each(["store alias", "file alias", "config object"] as const)(
  "retains the original discovery capture across %s changes",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:captured-discovery";
      const original = state.statePath("original", "catalog.sqlite");
      const replacement = state.statePath("replacement", "catalog.sqlite");
      const fileAlias = change === "file alias";
      const alias = fileAlias
        ? state.statePath("links", "selected.sqlite")
        : state.statePath("selected");
      if (fileAlias) {
        fs.mkdirSync(state.statePath("links"));
      }
      for (const [storePath, sessionId] of [
        [original, "original"],
        [replacement, "replacement"],
      ] as const) {
        replaceSessionEntrySync(
          { agentId: "main", storePath, sessionKey },
          { sessionId, updatedAt: 1 },
        );
      }
      fs.symlinkSync(
        fileAlias ? original : state.statePath("original"),
        alias,
        fileAlias ? "file" : "junction",
      );
      const cfg = {
        agents: { entries: { main: {} } },
        session: {
          store: fileAlias
            ? state.statePath("links", "selected.json")
            : state.statePath("selected", "catalog.sqlite"),
        },
      } satisfies OpenClawConfig;
      expect(
        (await loadCombinedSessionStoreForGatewayCoreAsync(cfg, { agentId: "main" })).store[
          sessionKey
        ],
      ).toMatchObject({ sessionId: "original" });
      const pending = loadCombinedSessionStoreForGatewayCoreAsync(cfg, { agentId: "main" });
      if (change !== "config object") {
        fs.rmSync(alias, { recursive: true });
        fs.symlinkSync(
          fileAlias ? replacement : state.statePath("replacement"),
          alias,
          fileAlias ? "file" : "junction",
        );
        await expect(pending).rejects.toThrow("outside captured discovery custody");
      } else {
        cfg.session.store = replacement;
        expect((await pending).store[sessionKey]).toMatchObject({ sessionId: "original" });
      }
      expect(
        (await loadCombinedSessionStoreForGatewayCoreAsync(cfg, { agentId: "main" })).store[
          sessionKey
        ],
      ).toMatchObject({ sessionId: "replacement" });
    });
  },
);

it("retains selection and sentinel options while the worker read is queued", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "global" },
      {
        sessionId: "captured-options",
        updatedAt: 1,
      },
    );
    const options = { agentId: "main", preserveSentinelOwners: true };
    const expected = loadCombinedSessionStoreForGatewayCore(cfg, options).store;
    const pending = loadCombinedSessionStoreForGatewayCoreAsync(cfg, options);
    options.agentId = "missing";
    options.preserveSentinelOwners = false;
    expect((await pending).store).toEqual(expected);
    expect(Object.keys(expected)).toEqual([JSON.stringify(["global", "main"])]);
  });
});

it("keeps stored addresses and foreign lineage stable after main-alias changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const parents = ["agent:main:main", "agent:main:home", "agent:main:global"];
    for (const [index, parent] of [...parents, "global"].entries()) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: parent },
        { sessionId: `parent-${index}`, updatedAt: 1 },
      );
      if (index < parents.length) {
        replaceSessionEntrySync(
          { agentId: "work", sessionKey: `agent:work:child-${index}` },
          {
            sessionId: `child-${index}`,
            updatedAt: 2,
            parentSessionKey: parent,
            spawnedBy: parent,
          },
        );
      }
    }
    for (const scope of ["per-sender", "global"] as const) {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {}, work: {} } },
        session: { mainKey: "home", scope },
      };
      for (const options of [{}, { agentId: "work" }]) {
        const expected = loadCombinedSessionStoreForGatewayCore(cfg, options);
        const result = await loadCombinedSessionStoreForGatewayCoreAsync(cfg, options);
        expect(result.store).toEqual(expected.store);
        for (const [index, parent] of parents.entries()) {
          const key = `agent:work:child-${index}`;
          expect(result.store[key]).toMatchObject({
            parentSessionKey: parent,
            spawnedBy: parent,
          });
          expect(result.targetsBySessionKey.get(key)?.readSourceEntry(parent)).toMatchObject({
            sessionId: `parent-${index}`,
          });
          if (!options.agentId) {
            expect(result.store[parent]?.sessionId).toBe(`parent-${index}`);
          }
        }
      }
    }
  });
});

it("transfers a Windows-normalized environment through the real worker transport", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:main" },
      {
        sessionId: "windows-transfer",
        updatedAt: 1,
      },
    );
    const { OPENCLAW_STATE_DIR, ...otherEnv } = process.env;
    const normalized = withMockedPlatform("win32", () =>
      configEnv.cloneEnvWithPlatformSemantics({
        ...otherEnv,
        OpenClaw_State_Dir: OPENCLAW_STATE_DIR,
      }),
    );
    expect(() => structuredClone(normalized)).toThrow();
    const clone = vi
      .spyOn(configEnv, "cloneEnvWithPlatformSemantics")
      .mockReturnValueOnce(normalized);
    try {
      expect(
        (await loadCombinedSessionStoreForGatewayCoreAsync(cfg)).store["agent:main:main"],
      ).toMatchObject({ sessionId: "windows-transfer" });
    } finally {
      clone.mockRestore();
    }
  });
});

it("federates worker rows under the same physical owners and keeps incognito process-local", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("shared.sqlite");
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: {}, ops: {} },
        defaults: { sessionStore: { agentId: "main" } },
      },
      session: { store: storePath },
    };
    openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    for (const agentId of ["main", "ops"]) {
      replaceSessionEntrySync(
        { agentId, storePath, sessionKey: `agent:${agentId}:main` },
        {
          sessionId: `${agentId}-session`,
          updatedAt: 1,
          spawnedCwd: `/project/${agentId}`,
        },
      );
    }
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:dashboard:incognito-list" },
      {
        sessionId: "private",
        incognito: true,
        updatedAt: 2,
        spawnedCwd: "/private/project",
      },
    );
    const expected = loadCombinedSessionStoreForGatewayCore(cfg);
    const result = await loadCombinedSessionStoreForGatewayCoreAsync(cfg);
    expect(result.store).toEqual(expected.store);
    expect(result.targetsBySessionKey.get("agent:ops:main")?.storeTarget).toEqual({
      agentId: "main",
      storePath,
    });
    expect(result.store["agent:main:dashboard:incognito-list"]).toMatchObject({ incognito: true });
    const missingPath = resolveOpenClawAgentSqlitePath({ agentId: "missing" });
    expect(
      (await loadCombinedSessionStoreForGatewayCoreAsync(cfg, { agentId: "missing" })).store,
    ).toEqual({});
    expect(fs.existsSync(missingPath)).toBe(false);
  });
});

it.each(["newer schema", "missing required table"])(
  "propagates a worker store with %s instead of returning an empty listing",
  async (failure) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:main" },
        {
          sessionId: "unavailable",
          updatedAt: 1,
        },
      );
      expect(
        (await loadCombinedSessionStoreForGatewayCoreAsync(cfg)).store["agent:main:main"],
      ).toMatchObject({ sessionId: "unavailable" });
      database.db.exec(
        failure === "newer schema" ? "PRAGMA user_version = 999" : "DROP TABLE session_nodes",
      );
      await expect(loadCombinedSessionStoreForGatewayCoreAsync(cfg)).rejects.toThrow(
        failure === "newer schema"
          ? /newer|schema/i
          : /Session metadata unavailable.*table-missing/,
      );
    });
  },
);
