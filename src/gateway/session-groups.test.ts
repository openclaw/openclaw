import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import * as sessionGroupCategories from "../config/sessions/session-group-categories.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import * as stateDatabase from "../state/openclaw-state-db.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  ensureSessionGroupCatalog,
  mutateSessionGroupCatalog,
  readSessionGroupCatalog,
} from "./session-group-catalog.js";
import {
  mutateSessionGroupCatalogInDatabase,
  readSessionGroupCatalogSnapshot,
} from "./session-group-catalog.kernel.js";
import {
  deleteSessionGroup,
  ensureSessionGroupRegistered,
  putSessionGroups,
  renameSessionGroup,
  SessionGroupNotEmptyError,
  updateSessionGroupDefaults,
} from "./session-groups.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";

describe("session groups catalog", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let state: OpenClawTestState;
  const cfg = {} as OpenClawConfig;
  const groupCfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" } },
      entries: { main: {}, other: {} },
    },
  };
  const catalog = () => readSessionGroupCatalog(env);
  const put = (
    names: string[],
    options: Partial<Omit<Parameters<typeof putSessionGroups>[0], "names">> = {},
  ) => putSessionGroups({ cfg, names, ...options });
  const defaults = (name: string, cwd: string | null, worktree = true) =>
    updateSessionGroupDefaults(name, { cwd, worktree }, env);
  const groups = (...names: string[]) => names.map((name, position) => ({ name, position }));
  const register = (name: string) => ensureSessionGroupRegistered(name, env);
  const rename = (options: Partial<Parameters<typeof renameSessionGroup>[0]> = {}) =>
    renameSessionGroup({ cfg, env, name: "Old", to: "New", ...options });
  const remove = (name: string) => deleteSessionGroup({ cfg, name, env });
  const groupDefaults = (name: string, cwd: string, worktree = true) => ({ name, cwd, worktree });

  beforeEach(async () => {
    state = await createOpenClawTestState({ scenario: "empty", layout: "state-only" });
    root = state.stateDir;
    env = state.env;
    await ensureSessionGroupCatalog(env);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await state.cleanup();
  });

  async function seedMember(
    id: string,
    category = "Old",
    agentId = "main",
    sessionId = id,
    entry: Partial<SessionEntry> = {},
  ) {
    const storePath = path.join(root, "agents", agentId, "sessions", "sessions.json");
    const target = { agentId, storePath, sessionKey: `agent:${agentId}:dashboard:${id}` };
    await replaceSessionEntry({ ...target, env }, { ...member(sessionId, category), ...entry });
    const read = () => loadSessionEntry(target);
    return { target, read, category: () => read()?.category };
  }

  const member = (sessionId: string, category = "Old"): SessionEntry => ({
    sessionId,
    updatedAt: Date.now(),
    category,
  });

  it("replaces the ordered catalog with deduped trimmed names", async () => {
    expect(catalog().groups).toEqual([]);
    const result = await put(["Work", "  Personal  ", "Work", ""]);
    expect(result).toEqual(groups("Work", "Personal"));
    expect(catalog().groups).toEqual(result);
    expect(await put(["Personal"])).toEqual(groups("Personal"));
  });

  it("rejects dropping a group that still has member sessions", async () => {
    const original = await put(["Keep", "Gone"]);
    const session = await seedMember("a", "Gone", "main", "a1");

    const rejected = put(["Keep"]);
    await expect(rejected).rejects.toThrow(SessionGroupNotEmptyError);
    await expect(rejected).rejects.toThrow('"Gone" (1)');
    expect(catalog().groups).toEqual(original);
    expect(session.category()).toBe("Gone");

    await remove("Gone");
    expect(session.category()).toBeUndefined();
    expect(await put(["Keep"])).toEqual(groups("Keep"));
  });

  it("propagates changed member authorization before reporting a non-empty drop", async () => {
    const original = await put(["Keep", "Gone"]);
    const session = await seedMember("changed-member", "Gone");
    const error = new SessionMutationAuthorizationChangedError({
      code: "INVALID_REQUEST",
      message: "session changed before sessions.groups.put; retry the request",
    });
    const assertTargetCurrent = vi.fn(() => {
      throw error;
    });

    await expect(put(["Keep"], { assertTargetCurrent })).rejects.toThrow(error);
    expect(assertTargetCurrent).toHaveBeenCalledExactlyOnceWith({
      agentId: "main",
      sessionKey: session.target.sessionKey,
    });
    expect(catalog().groups).toEqual(original);
    expect(session.category()).toBe("Gone");
  });

  it("roundtrips normalized sidebar order, including catalog section ids", async () => {
    await put(["Alpha", " Beta ", "Alpha"], {
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
    });
    expect(catalog().groups.map((group) => group.name)).toEqual(["Alpha", "Beta"]);
    const expectedSectionOrder = [
      "work",
      "catalog:codex",
      "category:Beta",
      "category:Alpha",
      "groups",
    ];
    expect(catalog().sectionOrder).toEqual(expectedSectionOrder);
    expect(readConfigMachineState("sidebar.sectionOrder", { env })).toEqual(expectedSectionOrder);

    await put(["Beta", "Alpha"]);
    const { db } = openOpenClawStateDatabase({ env });
    expect(readSessionGroupCatalogSnapshot(db)).toMatchObject({
      groups: groups("Beta", "Alpha"),
      sectionOrder: expectedSectionOrder,
    });
  });

  it("rejects renaming an unknown group after defaults schema activation", async () => {
    await put(["Client"]);
    await defaults("Client", "/repos/client");

    await expect(rename({ name: "Missing", to: "Other" })).rejects.toThrow(
      "unknown session group: Missing",
    );
    expect(catalog().groups).toEqual(groups("Client"));
    expect(catalog().defaults).toEqual([groupDefaults("Client", "/repos/client")]);
  });

  it("clears New Session defaults without removing the group", async () => {
    await put(["Client"]);
    await defaults("Client", "/repos/client");

    expect(await defaults("Client", null, false)).toEqual([{ name: "Client", worktree: false }]);
  });

  it("does not recreate a deleted group from a stale defaults update", async () => {
    await put(["Client"]);
    await remove("Client");

    expect(await defaults("Client", "/repos/client")).toBeNull();
    expect(catalog().groups).toEqual([]);
  });

  it("keeps a stale defaults update schema-free on a legacy database", async () => {
    // Publish fixture DDL before reopening; admitted files do not observe outside writers.
    const { db } = openOpenClawStateDatabase({ env });
    db.exec("ALTER TABLE session_groups DROP COLUMN cwd;");
    db.exec("ALTER TABLE session_groups DROP COLUMN worktree;");
    closeOpenClawStateDatabaseForTest();

    expect(await defaults("Missing", "/repos/missing")).toBeNull();
    const columns = openOpenClawStateDatabase({ env })
      .db.prepare("PRAGMA table_info(session_groups)")
      .all() as Array<{ name: string }>;
    const columnNames = columns.map((column) => column.name);
    expect(columnNames).not.toContain("cwd");
    expect(columnNames).not.toContain("worktree");
  });

  it("publishes catalog writes and serves repeated viewers without parent-thread SQLite", async () => {
    await put(["Work"]);
    requireNodeSqlite();
    const counters = observeMainThreadSql();
    try {
      const operation = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
      expect(await register("Work")).toBe(false);
      expect(operation).not.toHaveBeenCalled();
      expect(catalog().groups).toEqual(groups("Work"));
      operation.mockRestore();
      expect(await register("  Travel  ")).toBe(true);
      expect(await register("Travel")).toBe(false);
      await put(["Work", "Travel"], { sectionOrder: ["category:Travel"] });
      await defaults("Travel", "/repos/travel");
      const expected = {
        groups: groups("Work", "Travel"),
        defaults: [{ name: "Work" }, groupDefaults("Travel", "/repos/travel")],
        sectionOrder: ["category:Travel"],
      };
      for (let viewer = 0; viewer < 50; viewer += 1) {
        await ensureSessionGroupCatalog(env);
        expect(catalog()).toEqual(expect.objectContaining(expected));
      }
      counters.expectIdle();
    } finally {
      counters.restore();
    }
    expect(catalog().groups).toEqual(groups("Work", "Travel"));
  });

  it("keeps the original state directory and atomic append order across overlapping registrations", async () => {
    const originalEnv = { ...env };
    const redirectedRoot = path.join(root, "redirected");
    const registrations = ["First", "Second", "First"].map(register);
    env.OPENCLAW_STATE_DIR = redirectedRoot;
    expect(await Promise.all(registrations)).toEqual([true, true, false]);
    expect(readSessionGroupCatalog(originalEnv).groups).toEqual(groups("First", "Second"));
    await expect(fs.stat(redirectedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("shares committed catalog facts and lifecycle invalidation across state-directory aliases", async () => {
    await put(["Work", "Travel"]);
    const aliasPath = path.join(root, "alias");
    await fs.symlink(root, aliasPath, process.platform === "win32" ? "junction" : "dir");
    const aliasEnv = { ...env, OPENCLAW_STATE_DIR: aliasPath };
    await ensureSessionGroupCatalog(aliasEnv);
    expect(readSessionGroupCatalog(aliasEnv).groups).toEqual(catalog().groups);

    await updateSessionGroupDefaults("Travel", { cwd: "/repos/travel", worktree: true }, aliasEnv);
    expect(catalog().defaults).toEqual([
      { name: "Work" },
      groupDefaults("Travel", "/repos/travel"),
    ]);
    await put(["Travel", "Work"], { sectionOrder: ["category:Travel", "work"] });
    expect(readSessionGroupCatalog(aliasEnv).groups).toEqual(groups("Travel", "Work"));
    expect(readSessionGroupCatalog(aliasEnv).sectionOrder).toEqual(["category:Travel", "work"]);

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
    expect(catalog().groups).toEqual(reopened);
    expect(readSessionGroupCatalog(aliasEnv).groups).toEqual(reopened);
    expect(readSessionGroupCatalog(aliasEnv).defaults).toEqual([
      { name: "Work" },
      groupDefaults("Travel", "/repos/travel"),
    ]);
    expect(await register("Later")).toBe(true);
    expect(catalog().groups.at(-1)).toEqual({ name: "Later", position: 3 });
  });

  it("registers after a queued removal instead of using the preceding catalog", async () => {
    await put(["Work"]);
    const removal = mutateSessionGroupCatalog({ kind: "put", cfg, names: [] }, env);
    const registration = register("Work");

    expect((await removal).snapshot.groups).toEqual([]);
    expect(await registration).toBe(true);
    expect(catalog().groups).toEqual(groups("Work"));
  });

  it("rechecks a missing category after another writer registers it", async () => {
    await put(["Work"]);
    // This native kernel fixture interleaves catalog preparation and BEGIN.
    // The real worker grants/refusals are covered in session-groups.registration.test.ts.
    const stages: string[] = [];
    vi.spyOn(workerAdmission, "requestSqliteWorkerOperationAdmission").mockImplementation(
      (request) => {
        stages.push(request.stage);
      },
    );
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

    const database = openOpenClawStateDatabase({ env });
    expect(
      mutateSessionGroupCatalogInDatabase(database, { kind: "register", name: "Travel" }, env)
        .changed,
    ).toBe(false);
    expect(readSessionGroupCatalogSnapshot(database.db).groups).toEqual(groups("Work", "Travel"));
    expect(
      mutateSessionGroupCatalogInDatabase(database, { kind: "register", name: "Later" }, env)
        .changed,
    ).toBe(true);
    expect(readSessionGroupCatalogSnapshot(database.db).groups.at(-1)).toEqual({
      name: "Later",
      position: 2,
    });
    expect(stages).toEqual(["transaction", "commit", "transaction", "commit"]);
  });

  it("renames a group and repoints member categories without bumping updatedAt", async () => {
    await put(["Old", "Other"], {
      sectionOrder: ["ungrouped", "category:Old", "work", "category:Other"],
    });
    // Store saves run maintenance pruning; stale timestamps would be dropped.
    const updatedAtA = Date.now() - 1_000;
    const updatedAtB = Date.now() - 2_000;
    const sessionA = await seedMember("a", "Old", "main", "a1", { updatedAt: updatedAtA });
    const sessionB = await seedMember("b", "Other", "main", "b1", { updatedAt: updatedAtB });
    const sessionC = await seedMember("c", " Old ", "main", "c1", {
      updatedAt: updatedAtB,
      skillsSnapshot: { prompt: "retained session prompt", skills: [] },
    });

    const result = await renameSessionGroup({ cfg, name: "Old", to: "New", env });
    expect(result.updatedSessions).toBe(2);
    expect(result.groups.map((group) => group.name)).toEqual(["New", "Other"]);
    expect(result.sectionOrder).toEqual(["ungrouped", "category:New", "work", "category:Other"]);

    expect(sessionA.read()).toMatchObject({ category: "New", updatedAt: updatedAtA });
    expect(sessionB.category()).toBe("Other");
    expect(sessionC.read()).toMatchObject({
      sessionId: "c1",
      updatedAt: updatedAtB,
      category: "New",
      skillsSnapshot: { prompt: "retained session prompt", skills: [] },
    });
  });

  it.each([
    { action: "rename", targetExists: false, stopAgent: "main" },
    { action: "rename", targetExists: true, stopAgent: "other" },
    { action: "delete", targetExists: false, stopAgent: "other" },
  ])(
    "keeps group state coherent when $action stops in $stopAgent (target exists: $targetExists)",
    async ({ action, targetExists, stopAgent }) => {
      await put(targetExists ? ["Old", "New"] : ["Old"], {
        cfg: groupCfg,
        sectionOrder: ["category:Old", "work", ...(targetExists ? ["category:New"] : [])],
      });
      await defaults("Old", "/repos/old");
      if (targetExists) {
        await defaults("New", "/repos/new", false);
      }
      const sessions = new Map<string, Awaited<ReturnType<typeof seedMember>>>();
      for (const agentId of ["main", "other"]) {
        sessions.set(
          agentId,
          await seedMember("closing-caller", "Old", agentId, `${agentId}-closing-caller`),
        );
      }
      const category = (agentId: string) => sessions.get(agentId)?.category();
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
      expect(catalog().groups).toContainEqual({ name: "Old", position: 0 });
      expect(catalog().sectionOrder).toContain("category:Old");
      if (action === "rename") {
        expect(catalog().defaults).toContainEqual({
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
      expect(catalog().groups.map(({ name }) => name)).toEqual(action === "rename" ? ["New"] : []);
      expect(catalog().sectionOrder).not.toContain("category:Old");
    },
  );

  it("merges a rename into an existing target group", async () => {
    await put(["A", "B"], { sectionOrder: ["category:A", "ungrouped", "category:B"] });
    await seedMember("a", "A", "main", "a1");
    const result = await renameSessionGroup({ cfg, name: "A", to: "B", env });
    expect(result.groups).toEqual([{ name: "B", position: 1 }]);
    expect(result.sectionOrder).toEqual(["ungrouped", "category:B"]);
    expect(result.updatedSessions).toBe(1);
  });

  it("stops a rename if its empty destination is removed during member planning", async () => {
    await put(["Old"]);
    const session = await seedMember("removed-destination");
    let removed = false;
    await expect(
      rename({
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
    expect(session.category()).toBe("Old");
    expect(catalog().groups).toContainEqual({ name: "Old", position: 0 });
  });

  it("keeps absent-group deletion and same-name rename idempotent", async () => {
    const session = await seedMember("orphan-group", "Missing");
    expect(await renameSessionGroup({ cfg, name: "Missing", to: "Missing", env })).toMatchObject({
      groups: [],
      updatedSessions: 0,
    });
    expect(await remove("Missing")).toMatchObject({
      groups: [],
      updatedSessions: 1,
    });
    expect(session.category()).toBeUndefined();
    expect(await remove("Missing")).toMatchObject({
      groups: [],
      updatedSessions: 0,
    });
  });

  it("retains source defaults changed while a rename moves its members", async () => {
    await put(["Old"], { sectionOrder: ["category:Old"] });
    await defaults("Old", "/repos/before", false);
    const session = await seedMember("changed-group");
    const updateCategories = sessionGroupCategories.updateSessionGroupCategoriesInWorker;
    vi.spyOn(sessionGroupCategories, "updateSessionGroupCategoriesInWorker").mockImplementationOnce(
      async (params) => {
        const updated = await updateCategories(params);
        // Interleave after member custody settles, before the rename retires its source.
        await defaults("Old", "/repos/after");
        return updated;
      },
    );
    await expect(rename()).rejects.toThrow('session group "Old" changed before completion');
    expect(session.category()).toBe("New");
    expect(catalog().defaults).toEqual(
      expect.arrayContaining([
        groupDefaults("Old", "/repos/after"),
        groupDefaults("New", "/repos/before", false),
      ]),
    );
    expect(catalog().sectionOrder).toContain("category:Old");
  });

  it("retains a group when a member is assigned after its store was swept", async () => {
    await put(["Old"], { cfg: groupCfg, sectionOrder: ["category:Old"] });
    const lateKey = "agent:main:dashboard:late";
    const session = await seedMember("existing");
    await seedMember("existing", "Old", "other", "other-existing");
    let inserted = false;
    await expect(
      rename({
        cfg: groupCfg,
        assertTargetCurrent: ({ agentId }) => {
          if (agentId !== "other" || inserted) {
            return;
          }
          inserted = true;
          expect(session.category()).toBe("New");
          runOpenClawAgentWriteTransaction(
            (database) => {
              writeSessionEntry(database, lateKey, member("late"));
            },
            { agentId: "main", env },
          );
        },
      }),
    ).rejects.toThrow("still has members");
    expect(inserted).toBe(true);
    expect(loadSessionEntry({ ...session.target, sessionKey: lateKey })?.category).toBe("Old");
    expect(catalog().groups.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["Old", "New"]),
    );
    expect(catalog().sectionOrder).toContain("category:Old");
  });

  it("keeps the source sidebar slot when the merge target has no stored slot", async () => {
    await put(["A", "B"], { sectionOrder: ["category:A", "work"] });

    const result = await renameSessionGroup({ cfg, name: "A", to: "B", env });

    expect(result.groups).toEqual([{ name: "B", position: 1 }]);
    expect(result.sectionOrder).toEqual(["category:B", "work"]);
  });
});
