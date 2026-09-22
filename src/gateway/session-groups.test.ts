import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import * as stateDatabase from "../state/openclaw-state-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { ensureSessionGroupCatalog } from "./session-group-catalog.js";
import { readSessionGroupCatalogSnapshot } from "./session-group-catalog.kernel.js";
import { registerSessionGroupInDatabase } from "./session-group-registration.kernel.js";
import {
  deleteSessionGroup,
  ensureSessionGroupRegistered,
  listSessionGroupDefaults,
  listSidebarSectionOrder,
  listSessionGroups,
  putSessionGroups,
  renameSessionGroup,
  SessionGroupNotEmptyError,
  updateSessionGroupDefaults,
} from "./session-groups.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";

describe("session groups catalog", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  const cfg = {} as OpenClawConfig;

  beforeEach(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(tempRoot, "openclaw-session-groups-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: root };
    await ensureSessionGroupCatalog(env);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seedSessionStore(
    entries: Record<string, SessionEntry>,
    agentId = "main",
  ): Promise<string> {
    const storePath = path.join(root, "agents", agentId, "sessions", "sessions.json");
    for (const [sessionKey, entry] of Object.entries(entries)) {
      await replaceSessionEntry({ agentId, storePath, sessionKey }, entry);
    }
    return storePath;
  }

  it("replaces the ordered catalog with deduped trimmed names", async () => {
    expect(listSessionGroups(env)).toEqual([]);
    const groups = await putSessionGroups({
      cfg,
      names: ["Work", "  Personal  ", "Work", ""],
      env,
    });
    expect(groups).toEqual([
      { name: "Work", position: 0 },
      { name: "Personal", position: 1 },
    ]);
    expect(listSessionGroups(env)).toEqual(groups);
    expect(await putSessionGroups({ cfg, names: ["Personal"], env })).toEqual([
      { name: "Personal", position: 0 },
    ]);
  });

  it("rejects dropping a group that still has member sessions", async () => {
    const groups = await putSessionGroups({ cfg, names: ["Keep", "Gone"], env });
    const sessionKey = "agent:main:dashboard:a";
    const storePath = await seedSessionStore({
      [sessionKey]: { sessionId: "a1", updatedAt: Date.now(), category: "Gone" },
    });
    const sessionTarget = { agentId: "main", storePath, sessionKey };

    await expect(putSessionGroups({ cfg, names: ["Keep"], env })).rejects.toThrow(
      SessionGroupNotEmptyError,
    );
    await expect(putSessionGroups({ cfg, names: ["Keep"], env })).rejects.toThrow('"Gone" (1)');
    expect(listSessionGroups(env)).toEqual(groups);
    expect(loadSessionEntry(sessionTarget)?.category).toBe("Gone");

    await deleteSessionGroup({ cfg, name: "Gone", env });
    expect(loadSessionEntry(sessionTarget)?.category).toBeUndefined();
    expect(await putSessionGroups({ cfg, names: ["Keep"], env })).toEqual([
      { name: "Keep", position: 0 },
    ]);
  });

  it("propagates changed member authorization before reporting a non-empty drop", async () => {
    const groups = await putSessionGroups({ cfg, names: ["Keep", "Gone"], env });
    const sessionKey = "agent:main:dashboard:changed-member";
    const storePath = await seedSessionStore({
      [sessionKey]: { sessionId: "changed-member", updatedAt: Date.now(), category: "Gone" },
    });
    const error = new SessionMutationAuthorizationChangedError({
      code: "INVALID_REQUEST",
      message: "session changed before sessions.groups.put; retry the request",
    });
    const assertTargetCurrent = vi.fn(() => {
      throw error;
    });

    await expect(
      putSessionGroups({ cfg, names: ["Keep"], env, assertTargetCurrent }),
    ).rejects.toThrow(error);
    expect(assertTargetCurrent).toHaveBeenCalledExactlyOnceWith({ agentId: "main", sessionKey });
    expect(listSessionGroups(env)).toEqual(groups);
    expect(loadSessionEntry({ agentId: "main", storePath, sessionKey })?.category).toBe("Gone");
  });

  it("roundtrips normalized sidebar order, including catalog section ids", async () => {
    await putSessionGroups({
      cfg,
      names: ["Alpha", " Beta ", "Alpha"],
      sectionOrder: [
        " work ",
        " catalog: codex ",
        "category:Beta",
        "category:Missing",
        "category: Alpha ",
        "groups",
        "groups",
        "catalog:",
        "catalog:codex",
        "pinned",
        "",
      ],
      env,
    });
    expect(listSessionGroups(env).map((group) => group.name)).toEqual(["Alpha", "Beta"]);
    const expectedSectionOrder = [
      "work",
      "catalog:codex",
      "category:Beta",
      "category:Alpha",
      "groups",
    ];
    expect(listSidebarSectionOrder(env)).toEqual(expectedSectionOrder);
    expect(readConfigMachineState("sidebar.sectionOrder", { env })).toEqual(expectedSectionOrder);

    await putSessionGroups({ cfg, names: ["Beta", "Alpha"], env });
    expect(listSidebarSectionOrder(env)).toEqual(expectedSectionOrder);
  });

  it("keeps catalog reads and reorders schema-read-only until defaults are used", async () => {
    const databasePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("ALTER TABLE session_groups DROP COLUMN cwd;");
    legacy.exec("ALTER TABLE session_groups DROP COLUMN worktree;");
    legacy
      .prepare("INSERT INTO session_groups (name, position, created_at) VALUES (?, ?, ?)")
      .run("Client", 0, Date.now());
    legacy.close();

    const beforeFeatureUse = openOpenClawStateDatabase({ env })
      .db.prepare("PRAGMA table_info(session_groups)")
      .all() as Array<{ name: string }>;
    expect(beforeFeatureUse.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(["cwd", "worktree"]),
    );

    await ensureSessionGroupCatalog(env);
    expect(listSessionGroups(env)).toEqual([{ name: "Client", position: 0 }]);
    expect(await putSessionGroups({ cfg, names: ["Client"], env })).toEqual([
      { name: "Client", position: 0 },
    ]);
    const afterCatalogUse = openOpenClawStateDatabase({ env })
      .db.prepare("PRAGMA table_info(session_groups)")
      .all() as Array<{ name: string }>;
    expect(afterCatalogUse.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(["cwd", "worktree"]),
    );

    expect(listSessionGroupDefaults(env)).toEqual([{ name: "Client" }]);
    await renameSessionGroup({ cfg, name: "Client", to: "Customer", env });
    expect(listSessionGroupDefaults(env)).toEqual([{ name: "Customer" }]);
    const afterDefaultsReadAndRename = openOpenClawStateDatabase({ env })
      .db.prepare("PRAGMA table_info(session_groups)")
      .all() as Array<{ dflt_value: unknown; name: string; notnull: number; type: string }>;
    expect(afterDefaultsReadAndRename.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(["cwd", "worktree"]),
    );
    expect(
      await updateSessionGroupDefaults("Customer", { cwd: "/repos/customer", worktree: true }, env),
    ).toContainEqual({ name: "Customer", cwd: "/repos/customer", worktree: true });
    const columns = openOpenClawStateDatabase({ env })
      .db.prepare("PRAGMA table_info(session_groups)")
      .all() as Array<{ dflt_value: unknown; name: string; notnull: number; type: string }>;
    expect(columns.filter((column) => column.name === "cwd" || column.name === "worktree")).toEqual(
      [
        expect.objectContaining({ dflt_value: null, name: "cwd", notnull: 0, type: "TEXT" }),
        expect.objectContaining({
          dflt_value: null,
          name: "worktree",
          notnull: 0,
          type: "INTEGER",
        }),
      ],
    );
  });

  it("preserves New Session defaults through reorder and rename", async () => {
    await putSessionGroups({ cfg, names: ["Client", "Other"], env });
    expect(
      await updateSessionGroupDefaults("Client", { cwd: "/repos/client", worktree: true }, env),
    ).toContainEqual({
      name: "Client",
      cwd: "/repos/client",
      worktree: true,
    });

    await putSessionGroups({ cfg, names: ["Other", "Client"], env });
    await renameSessionGroup({ cfg, name: "Client", to: "Customer", env });
    expect(listSessionGroupDefaults(env)).toContainEqual({
      name: "Customer",
      cwd: "/repos/client",
      worktree: true,
    });
  });

  it("rejects renaming an unknown group after defaults schema activation", async () => {
    await putSessionGroups({ cfg, names: ["Client"], env });
    await updateSessionGroupDefaults("Client", { cwd: "/repos/client", worktree: true }, env);

    await expect(renameSessionGroup({ cfg, name: "Missing", to: "Other", env })).rejects.toThrow(
      "unknown session group: Missing",
    );
    expect(listSessionGroups(env)).toEqual([{ name: "Client", position: 0 }]);
    expect(listSessionGroupDefaults(env)).toEqual([
      { name: "Client", cwd: "/repos/client", worktree: true },
    ]);
  });

  it("clears New Session defaults without removing the group", async () => {
    await putSessionGroups({ cfg, names: ["Client"], env });
    await updateSessionGroupDefaults("Client", { cwd: "/repos/client", worktree: true }, env);

    expect(await updateSessionGroupDefaults("Client", { cwd: null, worktree: false }, env)).toEqual(
      [{ name: "Client", worktree: false }],
    );
  });

  it("does not recreate a deleted group from a stale defaults update", async () => {
    await putSessionGroups({ cfg, names: ["Client"], env });
    await deleteSessionGroup({ cfg, name: "Client", env });

    expect(
      await updateSessionGroupDefaults("Client", { cwd: "/repos/client", worktree: true }, env),
    ).toBeNull();
    expect(listSessionGroups(env)).toEqual([]);
  });

  it("keeps a stale defaults update schema-free on a legacy database", async () => {
    const databasePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("ALTER TABLE session_groups DROP COLUMN cwd;");
    legacy.exec("ALTER TABLE session_groups DROP COLUMN worktree;");
    legacy.close();

    expect(
      await updateSessionGroupDefaults("Missing", { cwd: "/repos/missing", worktree: true }, env),
    ).toBeNull();
    const columns = openOpenClawStateDatabase({ env })
      .db.prepare("PRAGMA table_info(session_groups)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(["cwd", "worktree"]),
    );
  });

  it("publishes catalog writes and serves repeated viewers without parent-thread SQLite", async () => {
    await putSessionGroups({ cfg, names: ["Work"], env });
    const native = requireNodeSqlite();
    const counters = [
      vi.spyOn(native.DatabaseSync.prototype, "prepare"),
      vi.spyOn(native.DatabaseSync.prototype, "exec"),
      ...(["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(native.StatementSync.prototype, method),
      ),
    ];
    try {
      expect(await ensureSessionGroupRegistered("  Travel  ", env)).toBe(true);
      expect(await ensureSessionGroupRegistered("Travel", env)).toBe(false);
      await putSessionGroups({
        cfg,
        names: ["Work", "Travel"],
        sectionOrder: ["category:Travel"],
        env,
      });
      await updateSessionGroupDefaults("Travel", { cwd: "/repos/travel", worktree: true }, env);
      const expected = JSON.stringify({
        groups: [
          { name: "Work", position: 0 },
          { name: "Travel", position: 1 },
        ],
        defaults: [{ name: "Work" }, { name: "Travel", cwd: "/repos/travel", worktree: true }],
        sectionOrder: ["category:Travel"],
      });
      for (let viewer = 0; viewer < 50; viewer += 1) {
        await ensureSessionGroupCatalog(env);
        expect(
          JSON.stringify({
            groups: listSessionGroups(env),
            defaults: listSessionGroupDefaults(env),
            sectionOrder: listSidebarSectionOrder(env),
          }),
        ).toBe(expected);
      }
      expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      for (const counter of counters) {
        counter.mockRestore();
      }
    }
    expect(listSessionGroups(env)).toEqual([
      { name: "Work", position: 0 },
      { name: "Travel", position: 1 },
    ]);
  });

  it("keeps the original state directory and atomic append order across overlapping registrations", async () => {
    const originalEnv = { ...env };
    const redirectedRoot = path.join(root, "redirected");
    const registrations = ["First", "Second", "First"].map((name) =>
      ensureSessionGroupRegistered(name, env),
    );
    env.OPENCLAW_STATE_DIR = redirectedRoot;
    expect(await Promise.all(registrations)).toEqual([true, true, false]);
    expect(listSessionGroups(originalEnv)).toEqual([
      { name: "First", position: 0 },
      { name: "Second", position: 1 },
    ]);
    await expect(fs.stat(redirectedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("shares committed catalog facts and lifecycle invalidation across state-directory aliases", async () => {
    await putSessionGroups({ cfg, names: ["Work", "Travel"], env });
    const aliasPath = path.join(root, "alias");
    await fs.symlink(root, aliasPath, process.platform === "win32" ? "junction" : "dir");
    const aliasEnv = { ...env, OPENCLAW_STATE_DIR: aliasPath };
    await ensureSessionGroupCatalog(aliasEnv);
    expect(listSessionGroups(aliasEnv)).toEqual(listSessionGroups(env));

    await updateSessionGroupDefaults("Travel", { cwd: "/repos/travel", worktree: true }, aliasEnv);
    expect(listSessionGroupDefaults(env)).toEqual([
      { name: "Work" },
      { name: "Travel", cwd: "/repos/travel", worktree: true },
    ]);
    await putSessionGroups({
      cfg,
      names: ["Travel", "Work"],
      sectionOrder: ["category:Travel", "work"],
      env,
    });
    expect(listSessionGroups(aliasEnv)).toEqual([
      { name: "Travel", position: 0 },
      { name: "Work", position: 1 },
    ]);
    expect(listSidebarSectionOrder(aliasEnv)).toEqual(["category:Travel", "work"]);

    await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(aliasEnv));
    const { DatabaseSync } = requireNodeSqlite();
    const offline = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
    try {
      offline.prepare("UPDATE session_groups SET position = ? WHERE name = ?").run(2, "Travel");
    } finally {
      offline.close();
    }
    await ensureSessionGroupCatalog(env);
    await ensureSessionGroupCatalog(aliasEnv);
    const reopened = [
      { name: "Work", position: 1 },
      { name: "Travel", position: 2 },
    ];
    expect(listSessionGroups(env)).toEqual(reopened);
    expect(listSessionGroups(aliasEnv)).toEqual(reopened);
    expect(listSessionGroupDefaults(aliasEnv)).toEqual([
      { name: "Work" },
      { name: "Travel", cwd: "/repos/travel", worktree: true },
    ]);
  });

  it("does not admit a write transaction for an existing category", async () => {
    await putSessionGroups({ cfg, names: ["Work"], env });
    const transaction = vi.spyOn(stateDatabase, "runOpenClawStateWriteTransaction");

    expect(registerSessionGroupInDatabase(openOpenClawStateDatabase({ env }), "Work", env)).toBe(
      false,
    );

    expect(transaction).not.toHaveBeenCalled();
    expect(listSessionGroups(env)).toEqual([{ name: "Work", position: 0 }]);
  });

  it("rechecks a missing category after another writer registers it", async () => {
    await putSessionGroups({ cfg, names: ["Work"], env });
    const originalTransaction = stateDatabase.runOpenClawStateWriteTransaction;
    vi.spyOn(stateDatabase, "runOpenClawStateWriteTransaction").mockImplementationOnce(
      (operation, options, transactionOptions) => {
        // Commit a competing registration between the optimistic read and admission.
        originalTransaction(
          ({ db }) => {
            db.prepare(
              "INSERT INTO session_groups (name, position, created_at) VALUES (?, ?, ?)",
            ).run("Travel", 1, 123);
          },
          { env },
        );
        return originalTransaction(operation, options, transactionOptions);
      },
    );

    expect(registerSessionGroupInDatabase(openOpenClawStateDatabase({ env }), "Travel", env)).toBe(
      false,
    );
    expect(readSessionGroupCatalogSnapshot(openOpenClawStateDatabase({ env }).db).groups).toEqual([
      { name: "Work", position: 0 },
      { name: "Travel", position: 1 },
    ]);
    expect(registerSessionGroupInDatabase(openOpenClawStateDatabase({ env }), "Later", env)).toBe(
      true,
    );
    expect(
      readSessionGroupCatalogSnapshot(openOpenClawStateDatabase({ env }).db).groups.at(-1),
    ).toEqual({ name: "Later", position: 2 });
  });

  it("renames a group and repoints member categories without bumping updatedAt", async () => {
    await putSessionGroups({
      cfg,
      names: ["Old", "Other"],
      sectionOrder: ["ungrouped", "category:Old", "work", "category:Other"],
      env,
    });
    // Store saves run maintenance pruning; stale timestamps would be dropped.
    const updatedAtA = Date.now() - 1_000;
    const updatedAtB = Date.now() - 2_000;
    const storePath = await seedSessionStore({
      "agent:main:dashboard:a": { sessionId: "a1", updatedAt: updatedAtA, category: "Old" },
      "agent:main:dashboard:b": { sessionId: "b1", updatedAt: updatedAtB, category: "Other" },
    });

    const result = await renameSessionGroup({ cfg, name: "Old", to: "New", env });
    expect(result.updatedSessions).toBe(1);
    expect(result.groups.map((group) => group.name)).toEqual(["New", "Other"]);
    expect(result.sectionOrder).toEqual(["ungrouped", "category:New", "work", "category:Other"]);

    const sessionA = loadSessionEntry({
      agentId: "main",
      storePath,
      sessionKey: "agent:main:dashboard:a",
    });
    const sessionB = loadSessionEntry({
      agentId: "main",
      storePath,
      sessionKey: "agent:main:dashboard:b",
    });
    expect(sessionA?.category).toBe("New");
    expect(sessionA?.updatedAt).toBe(updatedAtA);
    expect(sessionB?.category).toBe("Other");
  });

  it("deletes a group and clears member categories", async () => {
    await putSessionGroups({
      cfg,
      names: ["Gone"],
      sectionOrder: ["category:Gone", "ungrouped", "work"],
      env,
    });
    const storePath = await seedSessionStore({
      "agent:main:dashboard:a": { sessionId: "a1", updatedAt: Date.now(), category: "Gone" },
    });

    const result = await deleteSessionGroup({ cfg, name: "Gone", env });
    expect(result.updatedSessions).toBe(1);
    expect(result.groups).toEqual([]);
    expect(result.sectionOrder).toEqual(["ungrouped", "work"]);

    expect(
      loadSessionEntry({
        agentId: "main",
        storePath,
        sessionKey: "agent:main:dashboard:a",
      })?.category,
    ).toBeUndefined();
  });

  it.each(
    [
      { action: "rename", targetExists: false },
      { action: "rename", targetExists: true },
      { action: "delete", targetExists: false },
    ].flatMap(({ action, targetExists }) =>
      ["main", "other"].map((stopAgent) => ({ action, targetExists, stopAgent })),
    ),
  )(
    "keeps group state coherent when $action stops in $stopAgent (target exists: $targetExists)",
    async ({ action, targetExists, stopAgent }) => {
      const groupCfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, other: {} },
        },
      };
      await putSessionGroups({
        cfg: groupCfg,
        names: targetExists ? ["Old", "New"] : ["Old"],
        sectionOrder: ["category:Old", "work", ...(targetExists ? ["category:New"] : [])],
        env,
      });
      await updateSessionGroupDefaults("Old", { cwd: "/repos/old", worktree: true }, env);
      if (targetExists) {
        await updateSessionGroupDefaults("New", { cwd: "/repos/new", worktree: false }, env);
      }
      const stores = new Map<string, string>();
      for (const agentId of ["main", "other"]) {
        stores.set(
          agentId,
          await seedSessionStore(
            {
              [`agent:${agentId}:dashboard:closing-caller`]: {
                sessionId: `${agentId}-closing-caller`,
                updatedAt: Date.now(),
                category: "Old",
              },
            },
            agentId,
          ),
        );
      }
      const category = (agentId: string) =>
        loadSessionEntry({
          agentId,
          storePath: stores.get(agentId),
          sessionKey: `agent:${agentId}:dashboard:closing-caller`,
        })?.category;
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("caller authority closed");
        }
      };
      const params = {
        cfg: groupCfg,
        name: "Old",
        env,
        assertCurrent,
        assertTargetCurrent: ({ agentId }: { agentId: string }) => {
          assertCurrent();
          if (agentId === stopAgent) {
            queueMicrotask(() => {
              current = false;
            });
          }
        },
      };
      await expect(
        action === "rename"
          ? renameSessionGroup({ ...params, to: "New" })
          : deleteSessionGroup(params),
      ).rejects.toThrow("caller authority closed");
      expect(category("main")).toBe(
        stopAgent === "main" ? "Old" : action === "rename" ? "New" : undefined,
      );
      expect(category("other")).toBe("Old");
      expect(listSessionGroups(env)).toContainEqual({ name: "Old", position: 0 });
      expect(listSidebarSectionOrder(env)).toContain("category:Old");
      if (action === "rename") {
        expect(listSessionGroupDefaults(env)).toContainEqual({
          name: "New",
          cwd: targetExists ? "/repos/new" : "/repos/old",
          worktree: !targetExists,
        });
      }
      const retry = { cfg: groupCfg, name: "Old", env };
      await (action === "rename"
        ? renameSessionGroup({ ...retry, to: "New" })
        : deleteSessionGroup(retry));
      expect(category("main")).toBe(action === "rename" ? "New" : undefined);
      expect(category("other")).toBe(action === "rename" ? "New" : undefined);
      expect(listSessionGroups(env).map(({ name }) => name)).toEqual(
        action === "rename" ? ["New"] : [],
      );
      expect(listSidebarSectionOrder(env)).not.toContain("category:Old");
    },
  );

  it("merges a rename into an existing target group", async () => {
    await putSessionGroups({
      cfg,
      names: ["A", "B"],
      sectionOrder: ["category:A", "ungrouped", "category:B"],
      env,
    });
    await seedSessionStore({
      "agent:main:dashboard:a": { sessionId: "a1", updatedAt: Date.now(), category: "A" },
    });
    const result = await renameSessionGroup({ cfg, name: "A", to: "B", env });
    expect(result.groups).toEqual([{ name: "B", position: 1 }]);
    expect(result.sectionOrder).toEqual(["ungrouped", "category:B"]);
    expect(result.updatedSessions).toBe(1);
  });

  it("stops a rename if its empty destination is removed during member planning", async () => {
    await putSessionGroups({ cfg, names: ["Old"], env });
    const sessionKey = "agent:main:dashboard:removed-destination";
    const storePath = await seedSessionStore({
      [sessionKey]: { sessionId: "removed-destination", updatedAt: Date.now(), category: "Old" },
    });
    let removed = false;
    await expect(
      renameSessionGroup({
        cfg,
        name: "Old",
        to: "New",
        env,
        assertTargetCurrent: () => {
          if (!removed) {
            removed = true;
            queueMicrotask(() => {
              stateDatabase.runOpenClawStateWriteTransaction(
                ({ db }) => {
                  db.prepare("DELETE FROM session_groups WHERE name = ?").run("New");
                },
                { env },
              );
            });
          }
        },
      }),
    ).rejects.toThrow(/New/);
    expect(loadSessionEntry({ agentId: "main", storePath, sessionKey })?.category).toBe("Old");
    expect(listSessionGroups(env)).toContainEqual({ name: "Old", position: 0 });
  });

  it("keeps absent-group deletion and same-name rename idempotent", async () => {
    const sessionKey = "agent:main:dashboard:orphan-group";
    const storePath = await seedSessionStore({
      [sessionKey]: { sessionId: "orphan-group", updatedAt: Date.now(), category: "Missing" },
    });
    expect(await renameSessionGroup({ cfg, name: "Missing", to: "Missing", env })).toMatchObject({
      groups: [],
      updatedSessions: 0,
    });
    expect(await deleteSessionGroup({ cfg, name: "Missing", env })).toMatchObject({
      groups: [],
      updatedSessions: 1,
    });
    expect(loadSessionEntry({ agentId: "main", storePath, sessionKey })?.category).toBeUndefined();
    expect(await deleteSessionGroup({ cfg, name: "Missing", env })).toMatchObject({
      groups: [],
      updatedSessions: 0,
    });
  });

  it("retains source defaults changed while a rename moves its members", async () => {
    await putSessionGroups({ cfg, names: ["Old"], sectionOrder: ["category:Old"], env });
    await updateSessionGroupDefaults("Old", { cwd: "/repos/before", worktree: false }, env);
    const sessionKey = "agent:main:dashboard:changed-group";
    const storePath = await seedSessionStore({
      [sessionKey]: { sessionId: "changed-group", updatedAt: Date.now(), category: "Old" },
    });
    let defaultsChanged = false;
    await expect(
      renameSessionGroup({
        cfg,
        name: "Old",
        to: "New",
        env,
        assertTargetCurrent: () => {
          if (defaultsChanged) {
            return;
          }
          defaultsChanged = true;
          stateDatabase.runOpenClawStateWriteTransaction(
            ({ db }) => {
              db.prepare("UPDATE session_groups SET cwd = ?, worktree = ? WHERE name = ?").run(
                "/repos/after",
                1,
                "Old",
              );
            },
            { env },
          );
        },
      }),
    ).rejects.toThrow(/changed/);
    expect(loadSessionEntry({ agentId: "main", storePath, sessionKey })?.category).toBe("New");
    expect(listSessionGroupDefaults(env)).toEqual(
      expect.arrayContaining([
        { name: "Old", cwd: "/repos/after", worktree: true },
        { name: "New", cwd: "/repos/before", worktree: false },
      ]),
    );
    expect(listSidebarSectionOrder(env)).toContain("category:Old");
  });

  it("retains a group when a member is assigned after its store was swept", async () => {
    const groupCfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, other: {} },
      },
    };
    await putSessionGroups({ cfg: groupCfg, names: ["Old"], sectionOrder: ["category:Old"], env });
    const mainKey = "agent:main:dashboard:existing";
    const lateKey = "agent:main:dashboard:late";
    const mainStore = await seedSessionStore({
      [mainKey]: { sessionId: "existing", updatedAt: Date.now(), category: "Old" },
    });
    await seedSessionStore(
      {
        "agent:other:dashboard:existing": {
          sessionId: "other-existing",
          updatedAt: Date.now(),
          category: "Old",
        },
      },
      "other",
    );
    let inserted = false;
    await expect(
      renameSessionGroup({
        cfg: groupCfg,
        name: "Old",
        to: "New",
        env,
        assertTargetCurrent: ({ agentId }) => {
          if (agentId !== "other" || inserted) {
            return;
          }
          inserted = true;
          expect(
            loadSessionEntry({ agentId: "main", storePath: mainStore, sessionKey: mainKey })
              ?.category,
          ).toBe("New");
          runOpenClawAgentWriteTransaction(
            (database) => {
              writeSessionEntry(database, lateKey, {
                sessionId: "late",
                updatedAt: Date.now(),
                category: "Old",
              });
            },
            { agentId: "main", env },
          );
        },
      }),
    ).rejects.toThrow("still has members");
    expect(inserted).toBe(true);
    expect(
      loadSessionEntry({ agentId: "main", storePath: mainStore, sessionKey: lateKey })?.category,
    ).toBe("Old");
    expect(listSessionGroups(env).map(({ name }) => name)).toEqual(
      expect.arrayContaining(["Old", "New"]),
    );
    expect(listSidebarSectionOrder(env)).toContain("category:Old");
  });

  it("keeps the source sidebar slot when the merge target has no stored slot", async () => {
    await putSessionGroups({ cfg, names: ["A", "B"], sectionOrder: ["category:A", "work"], env });

    const result = await renameSessionGroup({ cfg, name: "A", to: "B", env });

    expect(result.groups).toEqual([{ name: "B", position: 1 }]);
    expect(result.sectionOrder).toEqual(["category:B", "work"]);
  });
});
