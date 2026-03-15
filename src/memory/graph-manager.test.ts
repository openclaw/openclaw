import { describe, it, expect, beforeEach, afterEach } from "vitest";

type DatabaseSyncCtor = typeof import("node:sqlite").DatabaseSync;

// node:sqlite is experimental and may not be available in all test environments
let DatabaseSync: DatabaseSyncCtor | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqlite = require("node:sqlite");
  DatabaseSync = sqlite.DatabaseSync;
} catch {
  // Will skip tests below if not available
}

import {
  GraphMemoryManager,
  resolveGraphConfig,
  type GraphManagerConfig,
} from "./graph-manager.js";

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    narrative TEXT NOT NULL,
    type TEXT NOT NULL,
    tier TEXT NOT NULL,
    weight INTEGER NOT NULL,
    reinforcement INTEGER NOT NULL DEFAULT 1,
    epoch TEXT NOT NULL DEFAULT 'founding',
    tags TEXT NOT NULL DEFAULT '[]',
    narrative_role TEXT NOT NULL DEFAULT 'detail',
    last_accessed TEXT NOT NULL DEFAULT '2026-01-01',
    created_at TEXT NOT NULL DEFAULT (date('now')),
    updated_at TEXT NOT NULL DEFAULT (date('now'))
);

CREATE TABLE IF NOT EXISTS edges (
    source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    context TEXT,
    created_at TEXT NOT NULL DEFAULT (date('now')),
    PRIMARY KEY (source_id, target_id, relation)
);

CREATE TABLE IF NOT EXISTS self_model (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    narrative TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (date('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    id, title, narrative, tags,
    content=nodes,
    content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, id, title, narrative, tags)
    VALUES (new.rowid, new.id, new.title, new.narrative, new.tags);
END;
`;

const SEED_NODES = [
  {
    id: "A001",
    title: "Faith as Foundation",
    narrative: "Ric is a member of the Church of Jesus Christ of Latter-day Saints.",
    type: "semantic",
    tier: "anchor",
    weight: 10,
  },
  {
    id: "T001",
    title: "First Day — First Boot",
    narrative: "This was the first day using OpenClaw.",
    type: "episodic",
    tier: "transition",
    weight: 8,
  },
  {
    id: "D001",
    title: "Technical Setup",
    narrative: "TypeScript, Node.js, pnpm, Linux workstation with GTX 1650.",
    type: "semantic",
    tier: "detail",
    weight: 3,
  },
  {
    id: "D002",
    title: "Music — Core Identity",
    narrative:
      "Ric was an All-Northwest singer. BYU Varsity Jazz. Baudboys a cappella at Microsoft.",
    type: "semantic",
    tier: "detail",
    weight: 5,
  },
];

const SEED_EDGES = [
  { source: "T001", target: "A001", relation: "supports" },
  { source: "D002", target: "A001", relation: "deepens" },
];

function makeConfig(overrides?: Partial<GraphManagerConfig>): GraphManagerConfig {
  return {
    dbPath: ":memory:",
    fts: true,
    anchorBoost: 1.5,
    transitionBoost: 1.2,
    autoReinforce: true,
    ...overrides,
  };
}

function seedDb(db: InstanceType<DatabaseSyncCtor>): void {
  db.exec(SCHEMA);
  const insertNode = db.prepare(
    `INSERT INTO nodes (id, title, narrative, type, tier, weight)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const n of SEED_NODES) {
    insertNode.run(n.id, n.title, n.narrative, n.type, n.tier, n.weight);
  }
  const insertEdge = db.prepare(
    `INSERT INTO edges (source_id, target_id, relation) VALUES (?, ?, ?)`,
  );
  for (const e of SEED_EDGES) {
    insertEdge.run(e.source, e.target, e.relation);
  }
}

const describeIfSqlite = DatabaseSync ? describe : describe.skip;

describeIfSqlite("GraphMemoryManager", () => {
  let db: InstanceType<DatabaseSyncCtor>;
  let manager: GraphMemoryManager;

  beforeEach(() => {
    if (!DatabaseSync) {
      throw new Error("node:sqlite DatabaseSync unavailable in this environment");
    }
    db = new DatabaseSync(":memory:");
    seedDb(db);
    manager = GraphMemoryManager.createFromDb(db, makeConfig());
  });

  afterEach(async () => {
    await manager.close();
  });

  it("search returns FTS results ranked by score", async () => {
    const results = await manager.search("faith church");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("A001");
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].snippet).toContain("Faith as Foundation");
  });

  it("anchor tier gets boosted above detail tier", async () => {
    // Insert via the nodes table (trigger handles FTS)
    db.exec(`INSERT INTO nodes (id, title, narrative, type, tier, weight)
             VALUES ('D099', 'Faith Detail', 'Also about the Church of Jesus Christ.', 'semantic', 'detail', 10)`);

    const results = await manager.search("Church Jesus Christ");
    expect(results.length).toBeGreaterThanOrEqual(2);
    // A001 (anchor, w=10, boost=1.5) should score higher than D099 (detail, w=10, boost=1.0)
    const a001 = results.find((r) => r.path === "A001");
    const d099 = results.find((r) => r.path === "D099");
    expect(a001).toBeDefined();
    expect(d099).toBeDefined();
    expect(a001!.score).toBeGreaterThan(d099!.score);
  });

  it("auto-reinforcement increments counter on search", async () => {
    const before = (
      db.prepare("SELECT reinforcement FROM nodes WHERE id = ?").get("A001") as {
        reinforcement: number;
      }
    ).reinforcement;

    await manager.search("faith church");

    const after = (
      db.prepare("SELECT reinforcement FROM nodes WHERE id = ?").get("A001") as {
        reinforcement: number;
      }
    ).reinforcement;

    expect(after).toBe(before + 1);
  });

  it("readFile with node ID returns narrative and edges", async () => {
    const result = await manager.readFile({ relPath: "A001" });
    expect(result.path).toBe("A001");
    expect(result.text).toContain("Faith as Foundation");
    expect(result.text).toContain("supports");
    expect(result.text).toContain("T001");
    expect(result.text).toContain("deepens");
    expect(result.text).toContain("D002");
  });

  it("readFile with non-node path returns empty text", async () => {
    const result = await manager.readFile({ relPath: "memory/2026-03-09.md" });
    expect(result.text).toBe("");
    expect(result.path).toBe("memory/2026-03-09.md");
  });

  it("search with empty query returns empty", async () => {
    const results = await manager.search("");
    expect(results).toEqual([]);
  });

  it("status reports graph backend", async () => {
    const s = manager.status();
    expect(s.backend).toBe("graph");
    expect(s.provider).toBe("sqlite-fts5");
    expect(s.files).toBe(4); // 4 seed nodes
    expect((s.custom as Record<string, unknown>)?.graphBackend).toBe(true);
  });

  it("probeEmbeddingAvailability returns ok", async () => {
    const result = await manager.probeEmbeddingAvailability();
    expect(result.ok).toBe(true);
  });

  it("probeVectorAvailability returns false", async () => {
    const result = await manager.probeVectorAvailability();
    expect(result).toBe(false);
  });
});

describe("resolveGraphConfig", () => {
  it("resolves relative dbPath against workspace", () => {
    const config = resolveGraphConfig({
      workspaceDir: "/home/user/.openclaw/workspace",
    });
    expect(config.dbPath.replaceAll("\\", "/")).toMatch(
      /\/home\/user\/\.openclaw\/workspace\/memory\/graph\/tommy_memory\.db$/,
    );
    expect(config.fts).toBe(true);
    expect(config.anchorBoost).toBe(1.5);
    expect(config.transitionBoost).toBe(1.2);
    expect(config.autoReinforce).toBe(true);
  });

  it("preserves absolute dbPath", () => {
    const config = resolveGraphConfig({
      workspaceDir: "/home/user/.openclaw/workspace",
      raw: { dbPath: "/opt/memory/graph.db" },
    });
    expect(config.dbPath).toBe("/opt/memory/graph.db");
  });

  it("applies custom boost values", () => {
    const config = resolveGraphConfig({
      workspaceDir: "/tmp",
      raw: { anchorBoost: 2.0, transitionBoost: 1.5 },
    });
    expect(config.anchorBoost).toBe(2.0);
    expect(config.transitionBoost).toBe(1.5);
  });
});
