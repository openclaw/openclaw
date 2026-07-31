import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  addSessionGroup,
  deleteSessionGroup,
  ensureSessionGroupRegistered,
  listSidebarSectionOrder,
  listSessionGroups,
  putSessionGroups,
  renameSessionGroup,
  reorderSessionGroups,
} from "./session-groups.js";

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

  async function seedSessionStore(entries: Record<string, SessionEntry>): Promise<string> {
    const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
    for (const [sessionKey, entry] of Object.entries(entries)) {
      await replaceSessionEntry({ agentId: "main", storePath, sessionKey }, entry);
    }
    return storePath;
  }

  it("replaces the ordered catalog with deduped trimmed names", () => {
    expect(listSessionGroups(env)).toEqual([]);
    const groups = putSessionGroups(["Work", "  Personal  ", "Work", ""], undefined, env);
    expect(groups).toEqual([
      { name: "Work", position: 0 },
      { name: "Personal", position: 1 },
    ]);
    expect(listSessionGroups(env)).toEqual(groups);
    expect(putSessionGroups(["Personal"], undefined, env)).toEqual([
      { name: "Personal", position: 0 },
    ]);
  });

  it("roundtrips normalized sidebar order, including catalog section ids", () => {
    putSessionGroups(
      ["Alpha", " Beta ", "Alpha"],
      [
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
    );
    expect(listSessionGroups(env).map((group) => group.name)).toEqual(["Alpha", "Beta"]);
    expect(listSidebarSectionOrder(env)).toEqual([
      "work",
      "catalog:codex",
      "category:Beta",
      "category:Alpha",
      "groups",
    ]);

    putSessionGroups(["Beta", "Alpha"], undefined, env);
    expect(listSidebarSectionOrder(env)).toEqual([
      "work",
      "catalog:codex",
      "category:Beta",
      "category:Alpha",
      "groups",
    ]);
  });

  it("lazily adds sidebar_sections to a pre-existing current-schema database", () => {
    const databasePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("DROP TABLE sidebar_sections;");
    legacy.close();

    const reopened = openOpenClawStateDatabase({ env });
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("sidebar_sections"),
    ).toBeUndefined();
    expect(listSidebarSectionOrder(env)).toEqual([]);
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("sidebar_sections"),
    ).toEqual({ name: "sidebar_sections" });
  });

  it("absorbs ad-hoc categories at the end of the catalog", () => {
    putSessionGroups(["Work"], undefined, env);
    ensureSessionGroupRegistered("Travel", env);
    ensureSessionGroupRegistered("Travel", env);
    expect(listSessionGroups(env)).toEqual([
      { name: "Work", position: 0 },
      { name: "Travel", position: 1 },
    ]);
  });

  it("renames a group and repoints member categories without bumping updatedAt", async () => {
    putSessionGroups(
      ["Old", "Other"],
      ["ungrouped", "category:Old", "work", "category:Other"],
      env,
    );
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
    putSessionGroups(["Gone"], ["category:Gone", "ungrouped", "work"], env);
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

  it("merges a rename into an existing target group", async () => {
    putSessionGroups(["A", "B"], ["category:A", "ungrouped", "category:B"], env);
    await seedSessionStore({
      "agent:main:dashboard:a": { sessionId: "a1", updatedAt: Date.now(), category: "A" },
    });
    const result = await renameSessionGroup({ cfg, name: "A", to: "B", env });
    expect(result.groups).toEqual([{ name: "B", position: 1 }]);
    expect(result.sectionOrder).toEqual(["ungrouped", "category:B"]);
    expect(result.updatedSessions).toBe(1);
  });

  it("adds groups idempotently without touching existing rows", () => {
    expect(addSessionGroup("Work", env)).toEqual({ name: "Work", position: 0 });
    expect(addSessionGroup("Personal", env)).toEqual({ name: "Personal", position: 1 });
    expect(addSessionGroup("Work", env)).toEqual({ name: "Work", position: 0 });
    expect(listSessionGroups(env).map((group) => group.name)).toEqual(["Work", "Personal"]);
  });

  it("replaces the catalog and removes omitted groups", () => {
    putSessionGroups(["A", "B", "C"], undefined, env);
    expect(listSessionGroups(env).map((group) => group.name)).toEqual(["A", "B", "C"]);
    putSessionGroups(["B"], undefined, env);
    expect(listSessionGroups(env).map((group) => group.name)).toEqual(["B"]);
  });

  it("preserves concurrent adds through the atomic add path", () => {
    // Tab 1 adds group A.
    addSessionGroup("A", env);
    // Tab 2 concurrently adds group B without reading A first.
    addSessionGroup("B", env);
    expect(listSessionGroups(env).map((group) => group.name)).toEqual(["A", "B"]);
  });

  it("reorders listed groups and compacts unlisted groups to unique positions", () => {
    putSessionGroups(["A", "B", "C"], undefined, env);
    reorderSessionGroups(["C", "B"], undefined, env);
    // Listed groups get positions 0..N-1; unlisted groups keep their prior
    // relative order and are appended at unique contiguous positions.
    expect(listSessionGroups(env)).toEqual([
      { name: "C", position: 0 },
      { name: "B", position: 1 },
      { name: "A", position: 2 },
    ]);
  });

  it("preserves unique positions across consecutive partial reorders", () => {
    putSessionGroups(["A", "B", "C"], undefined, env);
    reorderSessionGroups(["C", "B"], undefined, env);
    expect(listSessionGroups(env)).toEqual([
      { name: "C", position: 0 },
      { name: "B", position: 1 },
      { name: "A", position: 2 },
    ]);
    // Second partial reorder from a different client session; unlisted
    // groups C and B must retain their relative order after A moves to
    // the front.
    reorderSessionGroups(["A"], undefined, env);
    expect(listSessionGroups(env)).toEqual([
      { name: "A", position: 0 },
      { name: "C", position: 1 },
      { name: "B", position: 2 },
    ]);
  });

  it("persists the full sidebar section order atomically during reorder", () => {
    putSessionGroups(["A", "B"], ["ungrouped", "category:A", "work", "category:B"], env);
    reorderSessionGroups(["B", "A"], ["work", "ungrouped", "category:B", "category:A"], env);
    expect(listSessionGroups(env).map((group) => group.name)).toEqual(["B", "A"]);
    expect(listSidebarSectionOrder(env)).toEqual(["work", "ungrouped", "category:B", "category:A"]);
  });
});
