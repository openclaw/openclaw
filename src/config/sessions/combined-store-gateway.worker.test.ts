import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  loadUsageSessionContext,
  type UsageSessionSelection,
} from "../../gateway/server-methods/usage-session-selection.js";
import type { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { loadCombinedSessionStoreForGateway as loadSdkStore } from "../../plugin-sdk/session-transcript-hit.js";
import {
  beginAgentDeletionJournalInDatabase,
  completeAgentDeletionJournalInDatabase,
} from "../../state/agent-deletion-journal.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
} from "../../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  beginAgentDeletionJournal,
  removeAgentDeletionJournal,
} from "../../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import * as configEnv from "../config-env-vars.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { loadCombinedSessionStoreForGatewayCoreAsync as loadCombinedStoreAsync } from "./combined-store-gateway-read.js";
import { loadCombinedSessionStoreForGatewayCore as loadCombinedStore } from "./combined-store-gateway.native.js";
import { upsertSessionEntryCore } from "./session-accessor.entry.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { commitMemory } from "./session-actor-memory-publication.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import type { SessionEntry } from "./types.js";

function seed(
  scope: Parameters<typeof replaceSessionEntrySync>[0],
  sessionId: string,
  fields: Partial<SessionEntry> = {},
) {
  replaceSessionEntrySync(scope, { sessionId, updatedAt: 1, ...fields });
}
function selection(
  agentId: string,
  sessionId: string,
  key = `agent:${agentId}:main`,
): UsageSessionSelection {
  const storePath = resolveOpenClawAgentSqlitePath({ agentId });
  return {
    agentId,
    key,
    sessionId,
    sessionFile: storePath,
    updatedAt: 1,
    instances: [],
    contextTarget: { storeTarget: { agentId, storePath }, storedKey: key },
  };
}

const boundary = vi.hoisted(
  (): {
    beforeRequest: ((request: unknown) => void) | undefined;
    afterReply: ((reply: unknown) => Promise<void>) | undefined;
  } => ({ beforeRequest: undefined, afterReply: undefined }),
);
async function withoutHostSql(run: () => Promise<void>) {
  const observed = observeHostDataSql();
  try {
    await run();
    expect(observed.queries).toEqual([]);
  } finally {
    observed.restore();
  }
}
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

it.each([
  { layout: "separate", when: "before-read" },
  { layout: "shared", when: "before-read" },
  { layout: "legacy-partitioned", when: "before-read" },
  { layout: "separate", when: "during-topology" },
])(
  "keeps $layout aggregate reads available while another agent's resources close ($when)",
  async ({ layout, when }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath =
        layout === "shared"
          ? state.statePath("shared.sqlite")
          : layout === "legacy-partitioned"
            ? state.statePath("sessions.json")
            : undefined;
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {}, retiring: {} } },
        ...(storePath ? { session: { store: storePath } } : {}),
      };
      for (const agentId of ["main", "retiring"]) {
        replaceSessionEntrySync(
          { agentId, storePath, sessionKey: `agent:${agentId}:main` },
          {
            sessionId: `${agentId}-session`,
            updatedAt: 1,
            ...(agentId === "main" ? { parentSessionKey: "agent:retiring:main" } : {}),
          },
        );
      }
      const retiringPath =
        layout === "legacy-partitioned"
          ? resolveSqliteTargetFromSessionStorePath(storePath!, { agentId: "retiring" }).path
          : openOpenClawAgentDatabase({ agentId: "retiring" }).path;
      const closing = createDeferred();
      const release = createDeferred();
      const unregister = registerOpenClawAgentDatabaseAsyncResource({
        agentId: "retiring",
        path: retiringPath,
        revoke: closing.resolve,
        close: () => release.promise,
      });
      let closed: Promise<boolean> | undefined;
      const beginClosing = () => {
        beginAgentDeletionJournal({
          agentId: "retiring",
          operationId: "delete-retiring",
          agentDir: path.dirname(retiringPath),
          workspaceDir: state.statePath("workspace-retiring"),
          sessionsDir: state.statePath("agents", "retiring", "sessions"),
          deleteFiles: false,
        });
        closed = closeOpenClawAgentDatabaseByPathAsync(retiringPath, "retiring");
      };
      if (when === "during-topology") {
        boundary.beforeRequest = (request) => {
          if (!closed && isRecord(request) && request.kind === "combined-store-topology") {
            beginClosing();
          }
        };
      } else {
        beginClosing();
        await closing.promise;
      }
      try {
        for (const agentId of [undefined, "main"]) {
          const asyncResult = await loadCombinedStoreAsync(cfg, { agentId });
          const syncResult = loadCombinedStore(cfg, { agentId });
          for (const result of [asyncResult, syncResult]) {
            expect(Object.keys(result.store)).toEqual(["agent:main:main"]);
            expect(result.store["agent:main:main"]?.sessionId).toBe("main-session");
            expect(
              result.targetsBySessionKey
                .get("agent:main:main")
                ?.readSourceEntry("agent:retiring:main"),
            ).toBeUndefined();
          }
        }
        expect(closed).toBeDefined();
      } finally {
        boundary.beforeRequest = undefined;
        release.resolve();
        await closed;
        unregister();
      }
    });
  },
);

it("retains later stores while an earlier context read settles", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {}, other: {} } } };
    for (const agentId of ["main", "other"]) {
      seed({ agentId, sessionKey: `agent:${agentId}:main` }, `${agentId}-before-close`);
    }
    const other = openOpenClawAgentDatabase({ agentId: "other" });
    const selected = ["main", "other"].map((agentId) =>
      selection(agentId, `${agentId}-before-close`),
    );
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
            { sessionId: "other-successor", updatedAt: 2 },
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
    expect((await loadCombinedStoreAsync(cfg)).store["agent:other:main"]).toMatchObject({
      sessionId: "other-successor",
    });
  });
});

it("refuses physical context replacement even when the original file is restored before consumption", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = { agentId: "main", sessionKey: "agent:main:physical-listing" };
    replaceSessionEntrySync(scope, { sessionId: "original", updatedAt: 1 });
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    await closeOpenClawAgentDatabasesAsync();
    const replacement = state.statePath("replacement.sqlite");
    const retained = state.statePath("retained.sqlite");
    // Identical valid bytes must not let a replacement physical database inherit the read.
    fs.copyFileSync(databasePath, replacement);
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
      if (isRecord(request) && request.kind === "session-exact-entries") {
        replace();
      }
    };
    boundary.afterReply = async () => {
      if (replaced) {
        restore();
      }
    };
    try {
      await expect(
        loadUsageSessionContext([selection(scope.agentId, "original", scope.sessionKey)]),
      ).rejects.toThrow(/physical owner|database.*changed|file identity changed/i);
      expect(replaced).toBe(true);
      expect(restored).toBe(true);
    } finally {
      boundary.beforeRequest = undefined;
      boundary.afterReply = undefined;
      restore();
    }
  });
});

it("reuses committed deletion facts for the synchronous SDK loader", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {}, work: {} } } };
    for (const agentId of ["main", "work"]) {
      seed({ agentId, sessionKey: `agent:${agentId}:main` }, `${agentId}-session`);
    }
    await loadCombinedStoreAsync(cfg);
    const observed = observeHostDataSql();
    try {
      expect(Object.keys(loadSdkStore(cfg).store).toSorted()).toEqual([
        "agent:main:main",
        "agent:work:main",
      ]);
      expect(observed.queries.filter((sql) => /agent_deletion_journal/i.test(sql))).toEqual([]);
      const journal = {
        agentId: "work",
        operationId: "sync-discovery-delete",
        agentDir: state.agentDir("work"),
        workspaceDir: state.workspaceDir,
        sessionsDir: state.sessionsDir("work"),
        databasePaths: [],
        deleteFiles: false,
      };
      expect(() =>
        runOpenClawStateWriteTransaction(
          (database) => {
            beginAgentDeletionJournalInDatabase(database, journal);
            throw new Error("roll back discovery");
          },
          { env: state.env },
        ),
      ).toThrow("roll back discovery");
      expect(Object.keys(loadSdkStore(cfg).store).toSorted()).toEqual([
        "agent:main:main",
        "agent:work:main",
      ]);
      beginAgentDeletionJournal(journal, { env: state.env });
      observed.queries.length = 0;
      for (const options of [{}, { configuredAgentsOnly: true }, { agentId: "main" }]) {
        expect(Object.keys(loadSdkStore(cfg, options).store)).toEqual(["agent:main:main"]);
      }
      expect(observed.queries.filter((sql) => /agent_deletion_journal/i.test(sql))).toEqual([]);
      runOpenClawStateWriteTransaction(
        (database) => {
          expect(
            completeAgentDeletionJournalInDatabase(database, "work", journal.operationId),
          ).toBe(true);
        },
        { env: state.env },
      );
      expect(Object.keys(loadSdkStore(cfg).store)).toEqual(["agent:main:main"]);
      removeAgentDeletionJournal("work", journal.operationId, { env: state.env });
      observed.queries.length = 0;
      expect(
        Object.keys(loadSdkStore(cfg, { configuredAgentsOnly: true }).store).toSorted(),
      ).toEqual(["agent:main:main", "agent:work:main"]);
      expect(observed.queries.filter((sql) => /agent_deletion_journal/i.test(sql))).toEqual([]);
    } finally {
      observed.restore();
    }
  });
});

it("reads committed shared-store changes without running discovery SQL on the host", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("shared.sqlite");
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {}, work: {} } },
      session: { store: storePath },
    };
    seed({ agentId: "main", storePath, sessionKey: "agent:main:main" }, "main-session");
    await loadCombinedStoreAsync(cfg);
    replaceSessionEntrySync(
      { agentId: "work", storePath, sessionKey: "agent:work:new" },
      { sessionId: "new-session", updatedAt: 2 },
    );
    await withoutHostSql(async () => {
      const result = await loadCombinedStoreAsync(cfg);
      expect(result.store["agent:work:new"]).toMatchObject({ sessionId: "new-session" });
    });
  });
});

it("retains selection and sentinel options while the worker read is queued", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    seed({ agentId: "main", sessionKey: "global" }, "captured-options");
    const options = { agentId: "main", preserveSentinelOwners: true };
    const expected = loadCombinedStore(cfg, options).store;
    const pending = loadCombinedStoreAsync(cfg, options);
    options.agentId = "missing";
    options.preserveSentinelOwners = false;
    expect((await pending).store).toEqual(expected);
    expect(Object.keys(expected)).toEqual([JSON.stringify(["global", "main"])]);
  });
});

it("prepares foreign lineage without host SQL after main-alias changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const parents = ["agent:main:main", "agent:main:home", "agent:main:global"];
    for (const [index, parent] of [...parents, "global"].entries()) {
      seed({ agentId: "main", sessionKey: parent }, `parent-${index}`);
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
        const expected = loadCombinedStore(cfg, options);
        await withoutHostSql(async () => {
          const result = await loadCombinedStoreAsync(cfg, options);
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
        });
      }
    }
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: parents[0]! },
      { sessionId: "parent-after-write", updatedAt: 3 },
    );
    await withoutHostSql(async () => {
      const result = await loadCombinedStoreAsync(
        { agents: { entries: { main: {}, work: {} } } },
        { agentId: "work" },
      );
      expect(
        result.targetsBySessionKey.get("agent:work:child-0")?.readSourceEntry(parents[0]!)
          ?.sessionId,
      ).toBe("parent-after-write");
    });
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
      await withoutHostSql(async () => {
        const result = await loadCombinedStoreAsync(cfg, { agentId: "work" });
        expect(result.store[key]).toMatchObject({
          parentSessionKey: "global",
          spawnedBy: "global",
        });
        expect(result.targetsBySessionKey.get(key)?.readSourceEntry(parent)?.modelOverride).toBe(
          model,
        );
      });
    }
  });
});

it("transfers a Windows-normalized environment through the real worker transport", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    seed({ agentId: "main", sessionKey: "agent:main:main" }, "windows-transfer");
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
      expect((await loadCombinedStoreAsync(cfg)).store["agent:main:main"]).toMatchObject({
        sessionId: "windows-transfer",
      });
    } finally {
      clone.mockRestore();
    }
  });
});

it("federates worker rows under the same physical owners and keeps incognito process-local", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("shared.sqlite");
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {}, ops: {} }, defaults: { sessionStore: { agentId: "main" } } },
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
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:dashboard:incognito-list" },
      { sessionId: "private", incognito: true, updatedAt: 2, spawnedCwd: "/private/project" },
    );
    const expected = loadCombinedStore(cfg);
    const result = await loadCombinedStoreAsync(cfg);
    expect(result.store).toEqual(expected.store);
    expect(result.targetsBySessionKey.get("agent:ops:main")?.storeTarget).toEqual({
      agentId: "main",
      storePath,
    });
    expect(result.store["agent:main:dashboard:incognito-list"]).toMatchObject({ incognito: true });
    const missingPath = resolveOpenClawAgentSqlitePath({ agentId: "missing" });
    expect((await loadCombinedStoreAsync(cfg, { agentId: "missing" })).store).toEqual({});
    expect(fs.existsSync(missingPath)).toBe(false);
  });
});

it("lists current memory entries and owner changes alongside durable targets", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const key = "agent:main:dashboard:incognito-listing";
    const read = () => loadCombinedStoreAsync(cfg, { configuredAgentsOnly: true });
    expect((await read()).store[key]).toBeUndefined();
    const location = {
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
    };
    const owner = memorySessionActorOwners.get(location);
    const actor = await owner.acquire(
      { database: owner.identity, sessionKey: key },
      { assertCurrent() {}, assertReadable() {} },
    );
    const authority = { assertCurrent() {}, authorize() {} };
    try {
      const entry = {
        sessionId: "private",
        updatedAt: 1,
        incognito: true,
        label: "first",
        skillsSnapshot: { prompt: "private snapshot", skills: [] },
      };
      await commitMemory(actor.storage!, "session.entry.create", { entry }, authority);
      const first = (await read()).store[key];
      expect(first).toMatchObject({ sessionId: "private", label: "first" });
      expect(first).not.toHaveProperty("skillsSnapshot");
      await commitMemory(
        actor.storage!,
        "session.entry.patch",
        { operation: { kind: "fields", patch: { label: "updated" } } },
        authority,
      );
      expect((await read()).store[key]).toMatchObject({ label: "updated" });
      expect(loadCombinedStore(cfg, { configuredAgentsOnly: true }).store[key]).toMatchObject({
        label: "updated",
      });
      expect(
        (await loadCombinedStoreAsync(cfg, { includeIncognito: false })).store[key],
      ).toBeUndefined();
      memorySessionActorOwners.closeDatabase(location);
      expect((await read()).store[key]).toBeUndefined();
    } finally {
      await actor.release();
      memorySessionActorOwners.closeDatabase(location);
    }
  });
});
