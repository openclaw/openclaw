import fs from "node:fs";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import * as sessionAccessor from "../../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry-store.js";
import { projectionLane } from "../../../config/sessions/session-transcript-worker-resources.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { createDirectChatContext } from "../../../gateway/server-chat.agent-events.test-helpers.js";
import {
  bindSessionRowProjection,
  getSessionRowProjection,
} from "../../../gateway/session-row-projection-access.js";
import { createSessionRowProjection } from "../../../gateway/session-row-projection.js";
import { withPluginRuntimeGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import {
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { resolveRequesterToolPolicies } from "../../requester-tool-policy.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import {
  isSubagentEnvelopeSession,
  resolveStoredSubagentCapabilities as resolveCapabilities,
  resolveStoredSubagentInheritedToolAllowlist as resolveAllowlist,
  resolveStoredSubagentInheritedToolDenylist as resolveDenylist,
  resolveSubagentCapabilityStore as resolveStore,
} from "./subagent-capabilities.js";
import {
  getSubagentDepthFromSessionStore as resolveDepth,
  getSubagentDepthFromSessionStoreInWorker,
} from "./subagent-depth.js";
import {
  createSubagentSessionStore,
  prepareSessionCapabilityRead,
  withPreparedSessionCapabilityRead as withPreparedRead,
} from "./subagent-session-store.js";
import { createSessionCapabilityLookup } from "./subagent-session-store.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
    }
    cleanup();
  }),
);

function fixture(prefix: string) {
  const storePath = path.join(tempDirs.make(prefix), "sessions.sqlite");
  return { storePath, cfg: { session: { store: storePath } }, key: "agent:main:subagent:child" };
}

function makeEntry(sessionId: string, fields: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId, updatedAt: 1, ...fields };
}

function writeEntries(storePath: string, entries: Record<string, SessionEntry>) {
  runOpenClawAgentWriteTransaction(
    (database) => {
      for (const [key, value] of Object.entries(entries)) {
        writeSessionEntry(database, key, value);
      }
    },
    { agentId: "main", path: storePath },
  );
}

describe("persisted subagent capability lookups", () => {
  it.each([false, true])(
    "resolves current requester policy without session SQL (default store: %s)",
    async (useDefault) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const storePath = useDefault
          ? resolveSessionStorePathCore(undefined, { agentId: "main" })
          : state.statePath("capabilities.sqlite");
        const cfg = useDefault ? {} : { session: { store: storePath } };
        const key = "agent:main:dashboard:resident-capabilities";
        const scope = { agentId: "main", storePath, sessionKey: key };
        const seed = (sessionKey: string, sessionId: string, fields?: Partial<SessionEntry>) =>
          sessionAccessor.upsertSessionEntryCore(
            { ...scope, sessionKey },
            makeEntry(sessionId, fields),
          );
        await seed("agent:main:main", "parent");
        await seed(key, "resident-child", {
          spawnedBy: "agent:main:main",
          spawnDepth: 2,
          inheritedToolPolicyVersion: 1,
          inheritedToolAllow: ["read"],
          inheritedToolDeny: ["exec"],
        });
        const projection = await createSessionRowProjection({ cfg });
        try {
          await projection.ensureMaterialized();
          const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
          bindSessionRowProjection(context, () => projection);
          const copied = { ...context };
          let retired = false;
          await withPluginRuntimeGatewayContextResolver(
            () => {
              if (retired) {
                throw new Error("Gateway owner retired");
              }
              return copied;
            },
            async () => {
              const policy = { allow: ["read"], deny: ["exec"] };
              const request = { config: cfg, agentId: "main", sessionKey: key };
              const resolve = () => resolveRequesterToolPolicies(request);
              const readPolicy = () => {
                const { inheritedToolPolicy: inherited } = resolve();
                const store = resolveStore(key, { cfg });
                return { policy: inherited, depth: resolveCapabilities(key, { cfg, store }).depth };
              };
              expect(resolve().inheritedToolPolicy).toEqual(policy);
              const queries = observeSqliteReadSql(StatementSync.prototype);
              try {
                for (let turn = 0; turn < 50; turn += 1) {
                  expect(readPolicy()).toEqual({ policy, depth: 2 });
                }
                expect(queries.queries).toHaveLength(0);
              } finally {
                queries.restore();
              }
              await sessionAccessor.patchSessionEntryCore(scope, () => ({
                spawnDepth: 3,
                inheritedToolDeny: ["exec", "write"],
              }));
              expect(readPolicy()).toEqual({
                policy: { ...policy, deny: ["exec", "write"] },
                depth: 3,
              });
              const retained = createSubagentSessionStore(storePath, "main");
              const created = "agent:main:subagent:created";
              const readCreated = () => [retained.get(created), retained.getById("created-child")];
              expect(readCreated()).toEqual([undefined, undefined]);
              await seed(created, "created-child", { updatedAt: 2, spawnDepth: 4 });
              expect(readCreated().map((entry) => entry?.spawnDepth)).toEqual([4, 4]);

              // Rebinding a context updates its copies; rebinding a copy creates a separate owner.
              bindSessionRowProjection(context, () => undefined);
              expect(getSessionRowProjection(copied)).toBeUndefined();
              bindSessionRowProjection(copied, () => projection);
              expect(getSessionRowProjection(context)).toBeUndefined();
              expect(getSessionRowProjection(copied)).toBe(projection);

              expect(createSubagentSessionStore(storePath, "main").get("main")).toBeUndefined();
              expect(
                resolveRequesterToolPolicies({
                  config: { session: { store: state.statePath("absent.sqlite") } },
                  sessionKey: key,
                }).delegated,
              ).toBe(false);
              retired = true;
              expect(resolve).toThrow("Gateway owner retired");
            },
          );
        } finally {
          projection.dispose();
        }
      });
    },
  );

  it("retains capability facts across another agent's topology change", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
      const key = "agent:main:dashboard:retained-capabilities";
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", storePath, sessionKey: key },
        { sessionId: "retained-capabilities", updatedAt: 1, spawnDepth: 2 },
      );
      const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
      try {
        await projection.ensureMaterialized();
        const context = bindSessionRowProjection(createDirectChatContext({}), () => projection);
        await withPluginRuntimeGatewayContextResolver(
          () => context,
          async () => {
            const read = () => createSubagentSessionStore(storePath, "main").get(key);
            const prepared = await prepareSessionCapabilityRead(read);
            try {
              expect(prepared.read()?.spawnDepth).toBe(2);
              sessionChanges.emit({ all: true, scope: { agentId: "deleting", topology: true } });
              expect(prepared.read()?.spawnDepth).toBe(2);
              await sessionAccessor.patchSessionEntryCore(
                { agentId: "main", storePath, sessionKey: key },
                () => ({ spawnDepth: 3 }),
              );
              expect(() => prepared.read()).toThrow("Session capability metadata changed");
            } finally {
              prepared.release();
            }
          },
        );
      } finally {
        projection.dispose();
      }
    });
  });

  it("surfaces the database failure when capability preparation cannot read its store", async () => {
    const storePath = path.join(
      tempDirs.make("subagent-capability-unreadable-"),
      "sessions.sqlite",
    );
    fs.writeFileSync(storePath, "not a SQLite database");
    const store = createSubagentSessionStore(storePath, "main");
    await expect(
      withPreparedRead(() => store.get("agent:main:dashboard:unreadable"), { retain: true }),
    ).rejects.toThrow(/not a database/i);
  });

  it("retains writer-guarded capability facts inside an ordinary prepared read", async () => {
    const { storePath, cfg, key } = fixture("subagent-capability-nested-");
    const depth = () => resolveCapabilities(key, { cfg }).depth;
    writeEntries(storePath, { [key]: makeEntry("nested-child", { spawnDepth: 1 }) });
    const retained = await withPreparedRead(() => {
      expect(depth()).toBe(1);
      return prepareSessionCapabilityRead(depth);
    });
    try {
      expect(retained.read()).toBe(1);
      writeEntries(storePath, { [key]: makeEntry("nested-child", { spawnDepth: 2 }) });
      expect(() => retained.read()).toThrow("Session capability metadata changed");
    } finally {
      retained.release();
    }
  });

  it("prepares requested capability rows and observes the next committed policy", async () => {
    const { storePath, cfg, key } = fixture("subagent-capability-memo-");
    const write = (spawnDepth: number) =>
      writeEntries(storePath, {
        [key]: makeEntry("child", { spawnDepth, inheritedToolDeny: ["exec"] }),
      });
    const depth = () => resolveCapabilities(key, { cfg }).depth;
    write(2);
    const store = resolveStore(key, { cfg });
    await withPreparedRead(() => {
      expect(resolveCapabilities(key, { cfg, store }).depth).toBe(2);
      expect(resolveDenylist(key, { cfg, store })).toEqual(["exec"]);
      expect(resolveCapabilities("agent:main:subagent:missing", { cfg, store }).depth).toBe(1);
    });
    let entryReads = 0;
    const run = projectionLane.pool.run.bind(projectionLane.pool);
    vi.spyOn(projectionLane.pool, "run").mockImplementation(async (input, controls) => {
      const request = typeof input === "function" ? await input() : input;
      if (request.kind === "session-exact-entries") {
        entryReads += 1;
      }
      return run(request, controls);
    });
    write(4);
    expect(await withPreparedRead(depth)).toBe(4);
    expect(entryReads).toBe(0);
    const partial = { [key]: { spawnedBy: "agent:main:main" } };
    expect(
      await withPreparedRead(() => resolveCapabilities(key, { cfg, store: partial }).depth),
    ).toBe(4);
    const retained = await prepareSessionCapabilityRead(depth);
    try {
      expect(retained.read()).toBe(4);
      write(5);
      expect(() => retained.read()).toThrow("Session capability metadata changed");
    } finally {
      retained.release();
    }
    await sessionAccessor.patchSessionEntryCore(
      { storePath, agentId: "main", sessionKey: key },
      () => ({ spawnDepth: 6, inheritedToolDeny: ["exec", "write"] }),
      { workerGuard: {}, skipMaintenance: true },
    );
    entryReads = 0;
    await withPreparedRead(() => {
      expect(resolveCapabilities(key, { cfg }).depth).toBe(6);
      expect(resolveDenylist(key, { cfg })).toEqual(["exec", "write"]);
    });
    expect(entryReads).toBe(0);
  });

  it.each([true, false])(
    "binds prepared facts to the exact session key (matching=%s)",
    async (matching) => {
      const { storePath, cfg, key } = fixture("subagent-capability-prepared-");
      const store = resolveStore(key, {
        cfg,
        preparedSessionEntry: {
          sessionKey: matching ? key : "agent:main:subagent:other",
          entry: { sessionId: "child", spawnDepth: 3, inheritedToolDeny: ["exec"] },
        },
      });
      const depth = () => resolveCapabilities(key, { cfg, store }).depth;
      const deny = () => resolveDenylist(key, { cfg, store });
      expect(await withPreparedRead(depth)).toBe(matching ? 3 : 1);
      expect(await withPreparedRead(deny)).toEqual(matching ? ["exec"] : []);
      expect(fs.existsSync(storePath)).toBe(false);
    },
  );

  it.each(["", " \t\r\n\u00a0\u2003\u2028\ufeff"])(
    "matches explicit stores for nested and by-id lineage without listing unrelated sessions (padding=%j)",
    async (padding) => {
      const { storePath, cfg } = fixture("subagent-capability-lookup-");
      const root = "agent:main:main";
      const parent = "agent:main:subagent:parent";
      const child = "agent:main:subagent:child";
      const acp = "agent:main:acp:resumed";
      const dashboard = "agent:main:dashboard:spawned";
      const byId = "agent:main:subagent:by-id";
      const cycle = "agent:main:acp:cycle-one";
      const inherited = (id: string) =>
        makeEntry(id, {
          spawnedBy: child,
          inheritedToolAllow: ["read"],
          inheritedToolDeny: ["exec"],
        });
      const entries: Record<string, SessionEntry> = {
        [root]: makeEntry("root", { spawnDepth: 0 }),
        [parent]: makeEntry("parent-id", { spawnedBy: root }),
        [child]: makeEntry(`${padding}child-id${padding}`, { spawnedBy: parent }),
        "agent:main:subagent:renamed": inherited(`${padding}${byId}${padding}`),
        [acp]: inherited("acp-id"),
        [dashboard]: makeEntry("dashboard-id", { spawnDepth: 4, spawnedBy: acp }),
        [cycle]: makeEntry("cycle-one", { spawnedBy: "agent:main:acp:cycle-two" }),
        "agent:main:acp:cycle-two": makeEntry("cycle-two", { spawnedBy: cycle }),
      };
      const unrelated = Object.fromEntries(
        Array.from({ length: 64 }, (_, i): [string, SessionEntry] => [
          `agent:main:dashboard:unrelated-${i}`,
          makeEntry(`unrelated-${i}`, {
            skillsSnapshot: { prompt: "unrelated saved prompt", skills: [] },
          }),
        ]),
      );
      writeEntries(storePath, { ...entries, ...unrelated });
      const listing = vi.spyOn(sessionAccessor, "listSessionEntriesReadOnly");
      const explicit = {
        ...entries,
        "agent:main:subagent:later": makeEntry("child-id", { spawnDepth: 4 }),
      };
      expect(resolveDepth(" child-id ", { store: explicit })).toBe(2);
      const stores = [explicit, createSessionCapabilityLookup(entries)];
      for (const key of [parent, child, acp, dashboard, byId, "child-id", cycle]) {
        const persisted = resolveStore(key, { cfg });
        await withPreparedRead(() => {
          for (const store of stores) {
            const readers = [resolveCapabilities, resolveDepth];
            const policyReaders = [isSubagentEnvelopeSession, resolveAllowlist, resolveDenylist];
            for (const read of [...readers, ...(key === "child-id" ? [] : policyReaders)]) {
              expect(read(key, { cfg, store: persisted })).toEqual(read(key, { store }));
            }
          }
        });
      }
      const capped = { ...cfg, agents: { defaults: { subagents: { maxSpawnDepth: 2 } } } };
      const cappedRead = () => resolveCapabilities("child-id", { cfg: capped });
      expect(await withPreparedRead(cappedRead)).toMatchObject({
        depth: 2,
        role: "leaf",
        controlScope: "none",
      });
      expect(listing).not.toHaveBeenCalled();
    },
  );
});

async function depthStore(
  entries: Array<[string, { spawnDepth?: number; spawnedBy?: string }, string?]>,
  fixed = false,
) {
  const store = path.join(
    tempDirs.make("subagent-depth-"),
    fixed ? "sessions.sqlite" : "sessions-{agentId}.json",
  );
  for (const [sessionKey, fields, owner] of entries) {
    const agentId = expectDefined(owner ?? sessionKey.split(":")[1], "fixture owner");
    await sessionAccessor.replaceSessionEntry(
      { agentId, sessionKey, storePath: store.replaceAll("{agentId}", agentId) },
      { sessionId: sessionKey, updatedAt: Date.now(), ...fields },
    );
  }
  return store;
}

describe("getSubagentDepthFromSessionStore", () => {
  it("ignores non-decimal and unsafe stored spawnDepth strings", () => {
    const key = "agent:main:subagent:flat";
    for (const spawnDepth of ["1e3", "0x10", "1.5", "9007199254740993"]) {
      const depth = resolveDepth(key, {
        store: createSessionCapabilityLookup({
          [key]: { spawnDepth },
        }),
      });
      expect(depth).toBe(1);
    }
  });

  it("ignores parentSessionKey threading when resolving spawn depth", () => {
    const store = createSessionCapabilityLookup({
      "agent:main:main": {},
      "agent:main:dashboard:operator": { spawnDepth: 0, parentSessionKey: "agent:main:main" },
      "agent:main:dashboard:legacy": { parentSessionKey: "agent:main:main" },
    });
    expect(resolveDepth("agent:main:dashboard:operator", { store })).toBe(0);
    expect(resolveDepth("agent:main:dashboard:legacy", { store })).toBe(0);
  });

  it("resolves prefixed store keys when caller key omits the agent prefix", async () => {
    const store = await depthStore([["agent:main:subagent:flat", { spawnDepth: 2 }]]);
    expect(
      await getSubagentDepthFromSessionStoreInWorker("subagent:flat", {
        cfg: { session: { store } },
      }),
    ).toBe(2);
  });

  it("reads a bare fixed-store key through its persisted owner", async () => {
    const store = await depthStore([["global", { spawnDepth: 2 }, "ops"]], true);
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
      session: { scope: "global", store },
    } satisfies OpenClawConfig;

    expect(await getSubagentDepthFromSessionStoreInWorker("global", { cfg })).toBe(2);
  });

  it("resolves a cross-agent parent outside the supplied child store", async () => {
    const parentKey = "agent:main:dashboard:parent";
    const store = await depthStore([[parentKey, { spawnDepth: 2 }]]);

    const depth = await getSubagentDepthFromSessionStoreInWorker("agent:work:dashboard:child", {
      cfg: { session: { store } },
      store: createSessionCapabilityLookup({
        "agent:work:dashboard:child": { spawnedBy: parentKey },
      }),
    });

    expect(depth).toBe(3);
  });

  it("keeps agent-scoped views separate for a fixed shared store", async () => {
    const childKey = "agent:ops:dashboard:child";
    const parentKey = "agent:research:dashboard:parent";
    const store = await depthStore(
      [
        [childKey, { spawnedBy: parentKey }],
        [parentKey, { spawnDepth: 2 }],
      ],
      true,
    );

    expect(
      await getSubagentDepthFromSessionStoreInWorker(childKey, {
        cfg: {
          agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
          session: { store },
        },
      }),
    ).toBe(3);
  });
});

describe("resolveAgentTimeoutMs", () => {
  it("uses a timer-safe sentinel for no-timeout overrides", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 0 })).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs({ overrideMs: 0 })).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("clamps very large timeout overrides to timer-safe values", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 9_999_999 })).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs({ overrideMs: 9_999_999_999 })).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
