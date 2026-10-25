import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  loadUsageSessionContext,
  type UsageSessionSelection,
} from "../../gateway/server-methods/usage-session-selection.js";
import { loadCombinedSessionStoreForGateway as loadSdkStore } from "../../plugin-sdk/session-transcript-hit.js";
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
import {
  beginAgentDeletionJournal,
  removeAgentDeletionJournal,
} from "../../test-utils/agent-deletion-journal.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import * as configEnv from "../config-env-vars.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { loadCombinedSessionStoreForGatewayCoreAsync as loadCombinedStoreAsync } from "./combined-store-gateway-read.js";
import { loadCombinedSessionStoreForGatewayCore as loadCombinedStore } from "./combined-store-gateway.native.js";
import { upsertSessionEntryCore } from "./session-accessor.entry.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import { withoutHostSql } from "./session-accessor.observation.test-support.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { sessionTests } from "./session-entry-fixture.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  historyLane,
  projectionLane,
  targetDiscoveryLane,
} from "./session-transcript-worker-resources.js";
import type { SessionEntry } from "./types.js";

const it = sessionTests();

function seed(
  agentId: string,
  sessionKey: string,
  sessionId: string,
  fields: Partial<SessionEntry> = {},
  storePath?: string,
) {
  replaceSessionEntrySync(
    { agentId, sessionKey, storePath },
    { sessionId, updatedAt: 1, ...fields },
  );
}
function fleet(agentIds = ["main"], session?: OpenClawConfig["session"]): OpenClawConfig {
  return { agents: { entries: Object.fromEntries(agentIds.map((id) => [id, {}])) }, session };
}
function seedAgents(
  agentIds: string[],
  fields: (id: string) => Partial<SessionEntry> = () => ({}),
  storePath?: string,
) {
  for (const id of agentIds) {
    seed(id, `agent:${id}:main`, `${id}-session`, fields(id), storePath);
  }
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

function interceptReads(hooks: {
  beforeRequest?: (request: unknown) => void;
  afterReply?: (reply: unknown) => Promise<void>;
}) {
  const spies = [historyLane, projectionLane, targetDiscoveryLane].map(({ pool }) => {
    const run = pool.run.bind(pool);
    return vi.spyOn(pool, "run").mockImplementation((input, options) => {
      const prepare = typeof input === "function" ? input : () => input;
      const result = run(
        hooks.beforeRequest
          ? new Proxy(prepare, {
              async apply(target, receiver, args) {
                const request: unknown = await Reflect.apply(target, receiver, args);
                hooks.beforeRequest?.(request);
                return request;
              },
            })
          : input,
        options,
      );
      return hooks.afterReply
        ? result.then(async (reply) => {
            await hooks.afterReply?.(reply);
            return reply;
          })
        : result;
    });
  });
  return { [Symbol.dispose]: () => spies.forEach((spy) => spy.mockRestore()) };
}

it.for([
  ["separate", "before-read"],
  ["shared", "before-read"],
  ["legacy-partitioned", "before-read"],
  ["separate", "during-topology"],
])(
  "keeps %s aggregate reads available while another agent's resources close (%s)",
  async ([layout, when], { state }) => {
    const storePath =
      layout === "shared"
        ? state.statePath("shared.sqlite")
        : layout === "legacy-partitioned"
          ? state.statePath("sessions.json")
          : undefined;
    const cfg = fleet(["main", "retiring"], storePath ? { store: storePath } : undefined);
    seedAgents(
      ["main", "retiring"],
      (id) => (id === "main" ? { parentSessionKey: "agent:retiring:main" } : {}),
      storePath,
    );
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
    using _ = interceptReads({
      beforeRequest: (request) => {
        if (when !== "during-topology") {
          return;
        }
        if (!closed && isRecord(request) && request.kind === "combined-store-topology") {
          beginClosing();
        }
      },
    });
    if (when !== "during-topology") {
      beginClosing();
      await closing.promise;
    }
    try {
      for (const agentId of [undefined, "main"]) {
        const asyncResult = await loadCombinedStoreAsync(cfg, { agentId });
        const syncResult = loadCombinedStore(cfg, { agentId });
        for (const result of [asyncResult, syncResult]) {
          expect(result.store).toEqual({
            "agent:main:main": expect.objectContaining({ sessionId: "main-session" }),
          });
          const target = result.targetsBySessionKey.get("agent:main:main");
          expect(target?.readSourceEntry("agent:retiring:main")).toBeUndefined();
        }
      }
      expect(closed).toBeDefined();
    } finally {
      release.resolve();
      await closed;
      unregister();
    }
  },
);

it("retains later stores while an earlier context read settles", async ({ state: _state }) => {
  const cfg = fleet(["main", "other"]);
  seedAgents(["main", "other"], (id) => ({ sessionId: `${id}-before-close` }));
  const other = openOpenClawAgentDatabase({ agentId: "other" });
  const selected = ["main", "other"].map((agentId) =>
    selection(agentId, `${agentId}-before-close`),
  );
  let replaced = false;
  using _ = interceptReads({
    afterReply: async (reply) => {
      if (
        isRecord(reply) &&
        reply.ok === true &&
        isRecord(reply.value) &&
        reply.value.kind === "session-exact-entries" &&
        Array.isArray(reply.value.entries) &&
        !replaced
      ) {
        expect(
          reply.value.entries.map((row) => (isRecord(row) ? row.sessionKey : undefined)),
        ).toEqual(["agent:main:main"]);
        replaced = true;
        await closeOpenClawAgentDatabaseByPathAsync(other.path, "other");
        seed("other", "agent:other:main", "other-successor", { updatedAt: 2 });
      }
    },
  });
  await expect(loadUsageSessionContext(selected)).rejects.toThrow();
  expect(replaced).toBe(true);
  expect((await loadCombinedStoreAsync(cfg)).store["agent:other:main"]).toMatchObject({
    sessionId: "other-successor",
  });
});

it("refuses physical context replacement even when the original file is restored before consumption", async ({
  state,
}) => {
  const scope = { agentId: "main", sessionKey: "agent:main:physical-listing" };
  seed(scope.agentId, scope.sessionKey, "original");
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
  using _ = interceptReads({
    beforeRequest: (request) => {
      if (isRecord(request) && request.kind === "session-exact-entries") {
        replace();
      }
    },
    afterReply: async () => restore(),
  });
  try {
    await expect(
      loadUsageSessionContext([selection(scope.agentId, "original", scope.sessionKey)]),
    ).rejects.toThrow(/physical owner|database.*changed|file identity changed/i);
    expect({ replaced, restored }).toEqual({ replaced: true, restored: true });
  } finally {
    restore();
  }
});

it("reuses committed deletion facts for the synchronous SDK loader", async ({ state }) => {
  const cfg = fleet(["main", "work"]);
  seedAgents(["main", "work"]);
  await loadCombinedStoreAsync(cfg);
  const keys = (options?: Parameters<typeof loadSdkStore>[1]) =>
    Object.keys(loadSdkStore(cfg, options).store).toSorted();
  const both = ["agent:main:main", "agent:work:main"];
  const journal = {
    agentId: "work",
    operationId: "sync-discovery-delete",
    agentDir: state.agentDir("work"),
    workspaceDir: state.workspaceDir,
    sessionsDir: state.sessionsDir("work"),
    databasePaths: [],
    deleteFiles: false,
  };
  expect(keys()).toEqual(both);
  beginAgentDeletionJournal(journal, { env: state.env });
  for (const options of [{}, { configuredAgentsOnly: true }, { agentId: "main" }]) {
    expect(keys(options)).toEqual(["agent:main:main"]);
  }
  removeAgentDeletionJournal("work", journal.operationId, { env: state.env });
  expect(keys({ configuredAgentsOnly: true })).toEqual(both);
});

it("retains selection and sentinel options while the worker read is queued", async ({
  state: _state,
}) => {
  const cfg = fleet();
  seed("main", "global", "captured-options");
  const options = { agentId: "main", preserveSentinelOwners: true };
  const expected = loadCombinedStore(cfg, options).store;
  const pending = loadCombinedStoreAsync(cfg, options);
  options.agentId = "missing";
  options.preserveSentinelOwners = false;
  expect((await pending).store).toEqual(expected);
  expect(Object.keys(expected)).toEqual([JSON.stringify(["global", "main"])]);
});

it("prepares foreign lineage without host SQL after main-alias changes", async ({
  state: _state,
}) => {
  const parents = ["agent:main:main", "agent:main:home", "agent:main:global"];
  for (const [index, parent] of [...parents, "global"].entries()) {
    seed("main", parent, `parent-${index}`);
    if (index < parents.length) {
      seed("work", `agent:work:child-${index}`, `child-${index}`, {
        updatedAt: 2,
        parentSessionKey: parent,
        spawnedBy: parent,
      });
    }
  }
  for (const scope of ["per-sender", "global"] as const) {
    const cfg = fleet(["main", "work"], { mainKey: "home", scope });
    for (const options of [{}, { agentId: "work" }]) {
      const expected = loadCombinedStore(cfg, options);
      await withoutHostSql(async () => {
        const { store, targetsBySessionKey: targets } = await loadCombinedStoreAsync(cfg, options);
        expect(store).toEqual(expected.store);
        for (const [index, parent] of parents.entries()) {
          const key = `agent:work:child-${index}`;
          expect(store[key]).toMatchObject({
            parentSessionKey: parent,
            spawnedBy: parent,
          });
          expect(targets.get(key)?.readSourceEntry(parent)).toMatchObject({
            sessionId: `parent-${index}`,
          });
          if (!options.agentId) {
            expect(store[parent]?.sessionId).toBe(`parent-${index}`);
          }
        }
      });
    }
  }
  seed("main", parents[0]!, "parent-after-write", { updatedAt: 3 });
  await withoutHostSql(async () => {
    const { targetsBySessionKey: targets } = await loadCombinedStoreAsync(fleet(["main", "work"]), {
      agentId: "work",
    });
    expect(targets.get("agent:work:child-0")?.readSourceEntry(parents[0]!)).toMatchObject({
      sessionId: "parent-after-write",
    });
  });
});

it("refreshes foreign parent aliases after committed writes without host SQL", async ({
  state: _state,
}) => {
  const cfg = fleet(["main", "work"], { scope: "global" });
  const parent = "agent:main:main";
  const key = "agent:work:child";
  seed("work", key, "child", { parentSessionKey: parent, spawnedBy: parent });
  for (const model of ["before", "after"]) {
    seed("main", "global", "parent", { updatedAt: 2, modelOverride: model });
    await withoutHostSql(async () => {
      const { store, targetsBySessionKey: targets } = await loadCombinedStoreAsync(cfg, {
        agentId: "work",
      });
      expect(store[key]).toMatchObject({
        parentSessionKey: "global",
        spawnedBy: "global",
      });
      expect(targets.get(key)?.readSourceEntry(parent)).toMatchObject({ modelOverride: model });
    });
  }
});

it("transfers a Windows-normalized environment through the real worker transport", async ({
  state: _state,
}) => {
  const cfg = fleet();
  seed("main", "agent:main:main", "windows-transfer");
  const { OPENCLAW_STATE_DIR, ...otherEnv } = process.env;
  const normalized = withMockedPlatform("win32", () =>
    configEnv.cloneEnvWithPlatformSemantics({
      ...otherEnv,
      OpenClaw_State_Dir: OPENCLAW_STATE_DIR,
    }),
  );
  expect(() => structuredClone(normalized)).toThrow();
  using _ = vi.spyOn(configEnv, "cloneEnvWithPlatformSemantics").mockReturnValueOnce(normalized);
  expect((await loadCombinedStoreAsync(cfg)).store["agent:main:main"]).toMatchObject({
    sessionId: "windows-transfer",
  });
});

it("federates worker rows under the same physical owners and keeps incognito process-local", async ({
  state,
}) => {
  const storePath = state.statePath("shared.sqlite");
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {}, ops: {} }, defaults: { sessionStore: { agentId: "main" } } },
    session: { store: storePath },
  };
  openOpenClawAgentDatabase({ agentId: "main", path: storePath });
  seedAgents(["main", "ops"], (id) => ({ spawnedCwd: `/project/${id}` }), storePath);
  const key = "agent:main:dashboard:incognito-list";
  const read = () => loadCombinedStoreAsync(cfg, { configuredAgentsOnly: true });
  expect((await read()).store[key]).toBeUndefined();
  const scope = { agentId: "main", sessionKey: key };
  const entry = {
    sessionId: "private",
    incognito: true,
    updatedAt: 2,
    label: "first",
    skillsSnapshot: { prompt: "private snapshot", skills: [] },
  } satisfies Parameters<typeof upsertSessionEntryCore>[1];
  await upsertSessionEntryCore(scope, entry);
  const expected = loadCombinedStore(cfg);
  const result = await loadCombinedStoreAsync(cfg);
  expect(result.store).toEqual(expected.store);
  expect(result.targetsBySessionKey.get("agent:ops:main")?.storeTarget).toEqual({
    agentId: "main",
    storePath,
  });
  expect(result.store[key]).toMatchObject({
    sessionId: "private",
    incognito: true,
    label: "first",
  });
  expect(result.store[key]).not.toHaveProperty("skillsSnapshot");
  await upsertSessionEntryCore(scope, { ...entry, label: "updated" });
  expect((await read()).store[key]).toMatchObject({ label: "updated" });
  expect(loadCombinedStore(cfg, { configuredAgentsOnly: true }).store[key]).toMatchObject({
    label: "updated",
  });
  expect(
    (await loadCombinedStoreAsync(cfg, { includeIncognito: false })).store[key],
  ).toBeUndefined();
  memorySessionActorOwners.closeDatabase({
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
  });
  expect((await read()).store[key]).toBeUndefined();
  seed("ops", "agent:ops:new", "new-session", { updatedAt: 2 }, storePath);
  await withoutHostSql(async () => {
    expect((await loadCombinedStoreAsync(cfg)).store["agent:ops:new"]).toMatchObject({
      sessionId: "new-session",
    });
  });
  const missingPath = resolveOpenClawAgentSqlitePath({ agentId: "missing" });
  expect((await loadCombinedStoreAsync(cfg, { agentId: "missing" })).store).toEqual({});
  expect(fs.existsSync(missingPath)).toBe(false);
});

it("rejects collisions for transcript aliases discovered in another store", async ({ state }) => {
  const primary = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  const secondary = state.statePath("main.sqlite");
  const cfg = fleet(["main"], { store: state.statePath("{agentId}.sqlite") });
  const anchor = "agent:main:anchor";
  const alias = "agent:main:alias";
  seed("main", anchor, "shared", {}, primary);
  seed("main", alias, "different", {}, primary);
  seed("main", alias, "shared", {}, secondary);
  await expect(
    loadCombinedStoreAsync(cfg, {
      agentId: "main",
      includeIncognito: false,
      projection: "list",
      transcriptSelection: { sessionKeys: [anchor], sessionIds: [] },
    }),
  ).rejects.toThrow(`duplicate rows resolve to canonical session key ${alias}`);
});
