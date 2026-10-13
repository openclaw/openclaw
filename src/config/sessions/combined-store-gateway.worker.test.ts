import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
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

it("retains later stores while an earlier context read settles", async () => {
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
    const requestKind = "session-exact-entries";
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
      await expect(loadUsageSessionContext(selected)).rejects.toThrow();
      expect(replaced).toBe(true);
    } finally {
      boundary.afterReply = undefined;
    }
    expect(
      (await loadCombinedSessionStoreForGatewayCoreAsync(cfg)).store["agent:other:main"],
    ).toMatchObject({ sessionId: "other-successor" });
  });
});

it.each([{ read: "context", suppliedDiscovery: false, restoreBeforeConsume: true }])(
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

it("reads committed shared-store changes without running discovery SQL on the host", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("shared.sqlite");
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {}, work: {} } },
      session: { store: storePath },
    };
    replaceSessionEntrySync(
      { agentId: "main", storePath, sessionKey: "agent:main:main" },
      { sessionId: "main-session", updatedAt: 1 },
    );
    await loadCombinedSessionStoreForGatewayCoreAsync(cfg);
    replaceSessionEntrySync(
      { agentId: "work", storePath, sessionKey: "agent:work:new" },
      { sessionId: "new-session", updatedAt: 2 },
    );
    const observed = observeHostDataSql();
    try {
      const result = await loadCombinedSessionStoreForGatewayCoreAsync(cfg);
      expect(result.store["agent:work:new"]).toMatchObject({ sessionId: "new-session" });
      expect(observed.queries).toEqual([]);
    } finally {
      observed.restore();
    }
  });
});

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
        const observed = observeHostDataSql();
        try {
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
          expect(observed.queries).toEqual([]);
        } finally {
          observed.restore();
        }
      }
    }
  });
});

it("refreshes foreign parent aliases after committed writes without host SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {}, work: {} } },
      session: { scope: "global" },
    };
    const parent = "agent:main:main";
    const key = "agent:work:child";
    replaceSessionEntrySync(
      { agentId: "work", sessionKey: key },
      { sessionId: "child", updatedAt: 1, parentSessionKey: parent, spawnedBy: parent },
    );
    for (const model of ["before", "after"]) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "global" },
        { sessionId: "parent", updatedAt: 2, modelOverride: model },
      );
      const observed = observeHostDataSql();
      try {
        const result = await loadCombinedSessionStoreForGatewayCoreAsync(cfg, { agentId: "work" });
        expect(result.store[key]).toMatchObject({
          parentSessionKey: "global",
          spawnedBy: "global",
        });
        expect(result.targetsBySessionKey.get(key)?.readSourceEntry(parent)?.modelOverride).toBe(
          model,
        );
        expect(observed.queries).toEqual([]);
      } finally {
        observed.restore();
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
