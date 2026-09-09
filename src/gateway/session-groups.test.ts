import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
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
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seedSessionStore(
    entries: Record<string, SessionEntry>,
    agentId = "main",
    explicitStorePath?: string,
  ): Promise<string> {
    const storePath =
      explicitStorePath ?? path.join(root, "agents", agentId, "sessions", "sessions.json");
    for (const [sessionKey, entry] of Object.entries(entries)) {
      await replaceSessionEntry({ agentId, storePath, sessionKey, env }, entry);
    }
    return storePath;
  }

  it("keeps custom member database leases in each mutation's state root", async () => {
    const sessionKey = "agent:main:dashboard:scoped-state";
    const fixtures = ["a", "b"].map((name) => {
      const scopedEnv = { ...env, OPENCLAW_STATE_DIR: path.join(root, name) };
      const storePath = path.join(root, name, "custom.sqlite");
      const scopedCfg: OpenClawConfig = { session: { store: storePath } };
      return { env: scopedEnv, storePath, cfg: scopedCfg };
    });
    for (const fixture of fixtures) {
      putSessionGroups({ agentId: "main", names: ["Old"], cfg: fixture.cfg, env: fixture.env });
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath: fixture.storePath, env: fixture.env },
        { sessionId: "scoped-state", updatedAt: Date.now(), category: "Old" },
      );
    }
    // A warm handle retains the seed's lease and masks a missing mutation environment.
    closeOpenClawAgentDatabasesForTest();
    for (const fixture of fixtures) {
      const result = await renameSessionGroup({
        agentId: "main",
        name: "Old",
        to: "New",
        cfg: fixture.cfg,
        env: fixture.env,
      });
      expect(result.updatedSessions).toBe(1);
      const state = openOpenClawStateDatabase({ env: fixture.env });
      expect(
        state.db
          .prepare("SELECT path FROM agent_database_leases WHERE path = ?")
          .all(fixture.storePath),
      ).toEqual([{ path: fixture.storePath }]);
      expect(
        loadSessionEntry({
          agentId: "main",
          sessionKey,
          storePath: fixture.storePath,
          env: fixture.env,
          readConsistency: "latest",
        })?.category,
      ).toBe("New");
    }
  });

  it("replaces the ordered catalog with deduped trimmed names", () => {
    expect(listSessionGroups("main", env)).toEqual([]);
    const groups = putSessionGroups({
      agentId: "main",
      cfg,
      names: ["Work", "  Personal  ", "Work", ""],
      env,
    });
    expect(groups).toEqual([
      { name: "Work", position: 0 },
      { name: "Personal", position: 1 },
    ]);
    expect(listSessionGroups("main", env)).toEqual(groups);
    expect(putSessionGroups({ agentId: "main", cfg, names: ["Personal"], env })).toEqual([
      { name: "Personal", position: 0 },
    ]);
  });

  it("rejects dropping a group that still has member sessions", async () => {
    const groups = putSessionGroups({ agentId: "main", cfg, names: ["Keep", "Gone"], env });
    const sessionKey = "agent:main:dashboard:a";
    const storePath = await seedSessionStore({
      [sessionKey]: { sessionId: "a1", updatedAt: Date.now(), category: "Gone" },
    });
    const sessionTarget = { agentId: "main", storePath, sessionKey };

    expect(() => putSessionGroups({ agentId: "main", cfg, names: ["Keep"], env })).toThrow(
      SessionGroupNotEmptyError,
    );
    expect(() => putSessionGroups({ agentId: "main", cfg, names: ["Keep"], env })).toThrow(
      '"Gone" (1)',
    );
    expect(listSessionGroups("main", env)).toEqual(groups);
    expect(loadSessionEntry(sessionTarget)?.category).toBe("Gone");

    await deleteSessionGroup({ agentId: "main", cfg, name: "Gone", env });
    expect(loadSessionEntry(sessionTarget)?.category).toBeUndefined();
    expect(putSessionGroups({ agentId: "main", cfg, names: ["Keep"], env })).toEqual([
      { name: "Keep", position: 0 },
    ]);
  });

  it("propagates changed member authorization before reporting a non-empty drop", async () => {
    const groups = putSessionGroups({ agentId: "main", cfg, names: ["Keep", "Gone"], env });
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

    expect(() =>
      putSessionGroups({ agentId: "main", cfg, names: ["Keep"], env, assertTargetCurrent }),
    ).toThrow(error);
    expect(assertTargetCurrent).toHaveBeenCalledExactlyOnceWith({ agentId: "main", sessionKey });
    expect(listSessionGroups("main", env)).toEqual(groups);
    expect(loadSessionEntry({ agentId: "main", storePath, sessionKey })?.category).toBe("Gone");
  });

  it("roundtrips normalized sidebar order, including catalog section ids", () => {
    putSessionGroups({
      agentId: "main",
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
    expect(listSessionGroups("main", env).map((group) => group.name)).toEqual(["Alpha", "Beta"]);
    const expectedSectionOrder = [
      "work",
      "catalog:codex",
      "category:Beta",
      "category:Alpha",
      "groups",
    ];
    expect(listSidebarSectionOrder("main", env)).toEqual(expectedSectionOrder);

    putSessionGroups({ agentId: "main", cfg, names: ["Beta", "Alpha"], env });
    expect(listSidebarSectionOrder("main", env)).toEqual(expectedSectionOrder);
  });

  it("preserves New Session defaults through reorder and rename", async () => {
    putSessionGroups({ agentId: "main", cfg, names: ["Client", "Other"], env });
    expect(
      updateSessionGroupDefaults("Client", { cwd: "/repos/client", worktree: true }, "main", env),
    ).toContainEqual({
      name: "Client",
      cwd: "/repos/client",
      worktree: true,
    });

    putSessionGroups({ agentId: "main", cfg, names: ["Other", "Client"], env });
    await renameSessionGroup({ agentId: "main", cfg, name: "Client", to: "Customer", env });
    expect(listSessionGroupDefaults("main", env)).toContainEqual({
      name: "Customer",
      cwd: "/repos/client",
      worktree: true,
    });
  });

  it("rejects renaming an unknown group without losing another group defaults", async () => {
    putSessionGroups({ agentId: "main", cfg, names: ["Client"], env });
    updateSessionGroupDefaults("Client", { cwd: "/repos/client", worktree: true }, "main", env);

    await expect(
      renameSessionGroup({ agentId: "main", cfg, name: "Missing", to: "Other", env }),
    ).rejects.toThrow("unknown session group: Missing");
    expect(listSessionGroups("main", env)).toEqual([{ name: "Client", position: 0 }]);
    expect(listSessionGroupDefaults("main", env)).toEqual([
      { name: "Client", cwd: "/repos/client", worktree: true },
    ]);
  });

  it("clears New Session defaults without removing the group", () => {
    putSessionGroups({ agentId: "main", cfg, names: ["Client"], env });
    updateSessionGroupDefaults("Client", { cwd: "/repos/client", worktree: true }, "main", env);

    expect(
      updateSessionGroupDefaults("Client", { cwd: null, worktree: false }, "main", env),
    ).toEqual([{ name: "Client", worktree: false }]);
  });

  it("does not recreate a deleted group from a stale defaults update", async () => {
    putSessionGroups({ agentId: "main", cfg, names: ["Client"], env });
    await deleteSessionGroup({ agentId: "main", cfg, name: "Client", env });

    expect(
      updateSessionGroupDefaults("Client", { cwd: "/repos/client", worktree: true }, "main", env),
    ).toBeNull();
    expect(listSessionGroups("main", env)).toEqual([]);
  });

  it("absorbs ad-hoc categories at the end of the catalog", () => {
    putSessionGroups({ agentId: "main", cfg, names: ["Work"], env });
    ensureSessionGroupRegistered("Travel", "main", env);
    ensureSessionGroupRegistered("Travel", "main", env);
    expect(listSessionGroups("main", env)).toEqual([
      { name: "Work", position: 0 },
      { name: "Travel", position: 1 },
    ]);
  });

  it("renames a group and repoints member categories without bumping updatedAt", async () => {
    putSessionGroups({
      agentId: "main",
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

    const result = await renameSessionGroup({ agentId: "main", cfg, name: "Old", to: "New", env });
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
    putSessionGroups({
      agentId: "main",
      cfg,
      names: ["Gone"],
      sectionOrder: ["category:Gone", "ungrouped", "work"],
      env,
    });
    const storePath = await seedSessionStore({
      "agent:main:dashboard:a": { sessionId: "a1", updatedAt: Date.now(), category: "Gone" },
    });

    const result = await deleteSessionGroup({ agentId: "main", cfg, name: "Gone", env });
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
      putSessionGroups({
        agentId: stopAgent,
        cfg: groupCfg,
        names: targetExists ? ["Old", "New"] : ["Old"],
        sectionOrder: ["category:Old", "work", ...(targetExists ? ["category:New"] : [])],
        env,
      });
      updateSessionGroupDefaults("Old", { cwd: "/repos/old", worktree: true }, stopAgent, env);
      if (targetExists) {
        updateSessionGroupDefaults("New", { cwd: "/repos/new", worktree: false }, stopAgent, env);
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
        agentId: stopAgent,
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
      expect(category("main")).toBe("Old");
      expect(category("other")).toBe("Old");
      expect(listSessionGroups(stopAgent, env)).toContainEqual({ name: "Old", position: 0 });
      expect(listSidebarSectionOrder(stopAgent, env)).toContain("category:Old");
      if (action === "rename") {
        expect(listSessionGroupDefaults(stopAgent, env)).toContainEqual({
          name: "New",
          cwd: targetExists ? "/repos/new" : "/repos/old",
          worktree: !targetExists,
        });
      }
      const retry = { agentId: stopAgent, cfg: groupCfg, name: "Old", env };
      await (action === "rename"
        ? renameSessionGroup({ ...retry, to: "New" })
        : deleteSessionGroup(retry));
      expect(category(stopAgent)).toBe(action === "rename" ? "New" : undefined);
      expect(category(stopAgent === "main" ? "other" : "main")).toBe("Old");
      expect(listSessionGroups(stopAgent, env).map(({ name }) => name)).toEqual(
        action === "rename" ? ["New"] : [],
      );
      expect(listSidebarSectionOrder(stopAgent, env)).not.toContain("category:Old");
    },
  );

  it("merges a rename into an existing target group", async () => {
    putSessionGroups({
      agentId: "main",
      cfg,
      names: ["A", "B"],
      sectionOrder: ["category:A", "ungrouped", "category:B"],
      env,
    });
    await seedSessionStore({
      "agent:main:dashboard:a": { sessionId: "a1", updatedAt: Date.now(), category: "A" },
    });
    const result = await renameSessionGroup({ agentId: "main", cfg, name: "A", to: "B", env });
    expect(result.groups).toEqual([{ name: "B", position: 1 }]);
    expect(result.sectionOrder).toEqual(["ungrouped", "category:B"]);
    expect(result.updatedSessions).toBe(1);
  });

  it("stops a rename if its empty destination is removed during member planning", async () => {
    putSessionGroups({ agentId: "main", cfg, names: ["Old"], env });
    const sessionKey = "agent:main:dashboard:removed-destination";
    const storePath = await seedSessionStore({
      [sessionKey]: { sessionId: "removed-destination", updatedAt: Date.now(), category: "Old" },
    });
    let removed = false;
    await expect(
      renameSessionGroup({
        agentId: "main",
        cfg,
        name: "Old",
        to: "New",
        env,
        assertTargetCurrent: () => {
          if (!removed) {
            removed = true;
            queueMicrotask(() => {
              putSessionGroups({ agentId: "main", cfg, names: ["Old"], env });
            });
          }
        },
      }),
    ).rejects.toThrow(/New/);
    expect(loadSessionEntry({ agentId: "main", storePath, sessionKey })?.category).toBe("Old");
    expect(listSessionGroups("main", env)).toContainEqual({ name: "Old", position: 0 });
  });

  it("keeps absent-group deletion and same-name rename idempotent", async () => {
    const sessionKey = "agent:main:dashboard:orphan-group";
    const storePath = await seedSessionStore({
      [sessionKey]: { sessionId: "orphan-group", updatedAt: Date.now(), category: "Missing" },
    });
    expect(
      await renameSessionGroup({ agentId: "main", cfg, name: "Missing", to: "Missing", env }),
    ).toMatchObject({
      groups: [],
      updatedSessions: 0,
    });
    expect(await deleteSessionGroup({ agentId: "main", cfg, name: "Missing", env })).toMatchObject({
      groups: [],
      updatedSessions: 1,
    });
    expect(loadSessionEntry({ agentId: "main", storePath, sessionKey })?.category).toBeUndefined();
    expect(await deleteSessionGroup({ agentId: "main", cfg, name: "Missing", env })).toMatchObject({
      groups: [],
      updatedSessions: 0,
    });
  });

  it("retains source defaults changed while a rename moves its members", async () => {
    putSessionGroups({ agentId: "main", cfg, names: ["Old"], sectionOrder: ["category:Old"], env });
    updateSessionGroupDefaults("Old", { cwd: "/repos/before", worktree: false }, "main", env);
    const sessionKey = "agent:main:dashboard:changed-group";
    const storePath = await seedSessionStore({
      [sessionKey]: { sessionId: "changed-group", updatedAt: Date.now(), category: "Old" },
    });
    await expect(
      renameSessionGroup({
        agentId: "main",
        cfg,
        name: "Old",
        to: "New",
        env,
        assertTargetCurrent: () => {
          updateSessionGroupDefaults("Old", { cwd: "/repos/after", worktree: true }, "main", env);
        },
      }),
    ).rejects.toThrow(/changed/);
    expect(loadSessionEntry({ agentId: "main", storePath, sessionKey })?.category).toBe("New");
    expect(listSessionGroupDefaults("main", env)).toEqual(
      expect.arrayContaining([
        { name: "Old", cwd: "/repos/after", worktree: true },
        { name: "New", cwd: "/repos/before", worktree: false },
      ]),
    );
    expect(listSidebarSectionOrder("main", env)).toContain("category:Old");
  });

  it("retains a group when a member is assigned after its store was swept", async () => {
    putSessionGroups({ agentId: "main", cfg, names: ["Old"], sectionOrder: ["category:Old"], env });
    const mainKey = "agent:main:dashboard:existing";
    const lateKey = "agent:main:dashboard:late";
    const mainStore = await seedSessionStore({
      [mainKey]: { sessionId: "existing", updatedAt: Date.now(), category: "Old" },
    });
    let inserted = false;
    await expect(
      renameSessionGroup({
        agentId: "main",
        cfg,
        name: "Old",
        to: "New",
        env,
        assertCurrent: () => {
          if (
            inserted ||
            loadSessionEntry({ agentId: "main", storePath: mainStore, sessionKey: mainKey })
              ?.category !== "New"
          ) {
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
    expect(listSessionGroups("main", env).map(({ name }) => name)).toEqual(
      expect.arrayContaining(["Old", "New"]),
    );
    expect(listSidebarSectionOrder("main", env)).toContain("category:Old");
  });

  it.each(
    ["rename", "delete"].flatMap((action) =>
      [false, true].map((sharedStore) => ({ action, sharedStore })),
    ),
  )(
    "$action leaves the other agent's same-name membership intact (shared store: $sharedStore)",
    async ({ action, sharedStore }) => {
      const sharedStorePath = sharedStore ? path.join(root, "shared.sqlite") : undefined;
      const groupCfg: OpenClawConfig = {
        ...(sharedStorePath ? { session: { store: sharedStorePath } } : {}),
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, other: {} },
        },
      };
      for (const agentId of ["main", "other"]) {
        putSessionGroups({ cfg: groupCfg, agentId, names: ["Shared"], env });
      }
      const ownerKey = "agent:main:dashboard:owner";
      const otherKey = "agent:other:dashboard:other";
      const updatedAt = Date.now();
      const ownerStore = await seedSessionStore(
        {
          [ownerKey]: { sessionId: "owner", updatedAt, category: "Shared", pinnedAt: updatedAt },
        },
        "main",
        sharedStorePath,
      );
      const otherEntry = {
        sessionId: "other",
        updatedAt,
        category: "Shared",
        pinnedAt: updatedAt,
      } satisfies SessionEntry;
      const otherStore = await seedSessionStore(
        { [otherKey]: otherEntry },
        "other",
        sharedStorePath,
      );
      const otherTarget = { agentId: "other", storePath: otherStore, sessionKey: otherKey, env };
      const before = loadSessionEntry(otherTarget);
      expect(before).toMatchObject(otherEntry);
      const params = { cfg: groupCfg, agentId: "main", name: "Shared", env };

      const result =
        action === "rename"
          ? await renameSessionGroup({ ...params, to: "Renamed" })
          : await deleteSessionGroup(params);

      // The old global sweep changes this row despite the explicit owner param.
      expect(loadSessionEntry(otherTarget)).toEqual(before);
      expect(
        loadSessionEntry({ agentId: "main", storePath: ownerStore, sessionKey: ownerKey, env }),
      ).toMatchObject({ sessionId: "owner", updatedAt, pinnedAt: updatedAt });
      expect(
        loadSessionEntry({ agentId: "main", storePath: ownerStore, sessionKey: ownerKey, env })
          ?.category,
      ).toBe(action === "rename" ? "Renamed" : undefined);
      expect(result.updatedSessions).toBe(1);
      expect(listSessionGroups("other", env)).toEqual([{ name: "Shared", position: 0 }]);
    },
  );

  it("keeps same-name defaults and sidebar order independent between agents", () => {
    putSessionGroups({
      cfg,
      agentId: "main",
      names: ["Shared", "Main only"],
      sectionOrder: ["category:Shared", "category:Main only"],
      env,
    });
    putSessionGroups({
      cfg,
      agentId: "other",
      names: ["Other only", "Shared"],
      sectionOrder: ["category:Other only", "category:Shared"],
      env,
    });
    updateSessionGroupDefaults("Shared", { cwd: "/repos/main", worktree: true }, "main", env);
    updateSessionGroupDefaults("Shared", { cwd: "/repos/other", worktree: false }, "other", env);
    putSessionGroups({
      cfg,
      agentId: "main",
      names: ["Shared"],
      sectionOrder: ["category:Shared"],
      env,
    });

    expect(listSessionGroups("other", env)).toEqual([
      { name: "Other only", position: 0 },
      { name: "Shared", position: 1 },
    ]);
    expect(listSessionGroupDefaults("other", env)).toContainEqual({
      name: "Shared",
      cwd: "/repos/other",
      worktree: false,
    });
    expect(listSidebarSectionOrder("other", env)).toEqual([
      "category:Other only",
      "category:Shared",
    ]);
  });

  it("keeps the source sidebar slot when the merge target has no stored slot", async () => {
    putSessionGroups({
      agentId: "main",
      cfg,
      names: ["A", "B"],
      sectionOrder: ["category:A", "work"],
      env,
    });

    const result = await renameSessionGroup({ agentId: "main", cfg, name: "A", to: "B", env });

    expect(result.groups).toEqual([{ name: "B", position: 1 }]);
    expect(result.sectionOrder).toEqual(["category:B", "work"]);
  });
});
