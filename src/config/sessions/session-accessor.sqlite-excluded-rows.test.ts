import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  iterateSessionEntryKeys,
  readExactSessionEntryRow,
  readSessionEntryCount,
  readSessionEntryStore,
} from "./session-accessor.sqlite-entry-store.js";
import { readReferencedSessionIds } from "./session-accessor.sqlite-lifecycle-state.js";
import { readSessionMaintenanceCapCandidates } from "./session-accessor.sqlite-maintenance-candidates.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function openDatabase(encoding?: "UTF-8" | "UTF-16le" | "UTF-16be") {
  const stateDir = tempDirs.make("openclaw-excluded-rows-");
  const pathname = path.join(stateDir, "agent.sqlite");
  if (encoding) {
    const seed = new DatabaseSync(pathname);
    try {
      seed.exec(
        `PRAGMA encoding='${encoding}'; CREATE TABLE encoding_probe(value TEXT); DROP TABLE encoding_probe;`,
      );
    } finally {
      seed.close();
    }
  }
  return openOpenClawAgentDatabase({
    agentId: "main",
    path: pathname,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

function insertEntry(
  database: OpenClawAgentDatabase,
  key: string,
  id: string,
  json?: string | Buffer,
) {
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, CAST(? AS TEXT), ?)",
    )
    .run(key, id, json ?? JSON.stringify({ sessionId: id, updatedAt: 1 }), 1);
}

function trackMaterializedKeys(database: OpenClawAgentDatabase) {
  const materializedKeys: string[] = [];
  const prepare = database.db.prepare.bind(database.db);
  vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    const iterate = statement.iterate.bind(statement);
    vi.spyOn(statement, "iterate").mockImplementation(function* (...args) {
      for (const row of iterate(...args)) {
        if (typeof row.session_key === "string") {
          materializedKeys.push(row.session_key);
        }
        yield row;
      }
      return undefined;
    });
    return statement;
  });
  return materializedKeys;
}

const readers = [
  {
    name: "references",
    read: (database: OpenClawAgentDatabase, excludedKeys: ReadonlySet<string>) =>
      [...readReferencedSessionIds(database, excludedKeys)].toSorted(),
  },
  {
    name: "cap candidates",
    read: (database: OpenClawAgentDatabase, excludedKeys: ReadonlySet<string>) =>
      Object.values(readSessionMaintenanceCapCandidates({ database, excludedKeys })).map(
        (entry) => entry.sessionId,
      ),
  },
];

describe.each(readers)("SQLite $name exclusions", ({ read }) => {
  it("does not materialize excluded entries before discarding them", () => {
    const database = openDatabase();
    insertEntry(
      database,
      "agent:main:excluded",
      "excluded",
      JSON.stringify({
        sessionId: "excluded",
        updatedAt: 1,
        skillsSnapshot: { prompt: "x".repeat(64 * 1024), skills: [] },
      }),
    );
    insertEntry(database, "agent:main:kept", "kept");
    const materializedKeys = trackMaterializedKeys(database);

    expect(read(database, new Set(["agent:main:excluded"]))).toEqual(["kept"]);
    expect(materializedKeys).toEqual(["agent:main:kept"]);
  });

  it.each([
    { name: "empty", excluded: [], expected: ["a", "b", "c"] },
    { name: "missing", excluded: ["missing"], expected: ["a", "b", "c"] },
    { name: "all", excluded: ["a", "b", "c"], expected: [] },
    { name: "mixed", excluded: ["b", "missing"], expected: ["a", "c"] },
  ])("preserves $name exclusion results and cap order", ({ excluded, expected }) => {
    const database = openDatabase();
    for (const key of ["c", "a", "b"]) {
      insertEntry(database, key, key);
    }
    expect(read(database, new Set(excluded))).toEqual(expected);
  });

  it.each(["UTF-8", "UTF-16le", "UTF-16be"] as const)(
    "preserves exact exclusions across %s text conversion",
    (encoding) => {
      const database = openDatabase(encoding);
      const keys = ["agent:main:\uFFFD", "agent:main:a\uFFFE", "agent:main:b\uFFFF", "ordinary"];
      for (const [index, key] of keys.entries()) {
        insertEntry(database, key, `id-${index}`);
      }
      expect(database.db.prepare("PRAGMA encoding").get()?.encoding).toBe(encoding);
      const excluded = new Set(["agent:main:\uFFFE", "agent:main:\uFFFF", ...keys.slice(1)]);
      expect(read(database, excluded).toSorted()).toEqual(
        encoding === "UTF-8" ? ["id-0"] : ["id-0", "id-1", "id-2"],
      );
      const storedKeys = database.db.prepare("SELECT session_key FROM session_nodes").all();
      expect(read(database, new Set(storedKeys.map((row) => String(row.session_key))))).toEqual([]);
    },
  );

  it.each(["UTF-8", "UTF-16le", "UTF-16be"] as const)(
    "preserves returned-key membership for NUL text in %s",
    (encoding) => {
      const database = openDatabase(encoding);
      const key = "nul\0tail";
      insertEntry(database, key, "kept");
      const returnedKey = String(
        database.db.prepare("SELECT session_key FROM session_nodes").get()?.session_key,
      );
      // Older supported Node bindings return only the text before NUL.
      expect([key, "nul"]).toContain(returnedKey);
      expect(read(database, new Set([key]))).toEqual(returnedKey === key ? [] : ["kept"]);
      expect(read(database, new Set([returnedKey]))).toEqual([]);
    },
  );

  it("preserves exact UTF-16 membership without replacing unmatched surrogates", () => {
    const database = openDatabase();
    const keys = ["\uFFFD", "\uD83E\uDD9E", "quoted'key", "日本語"];
    for (const [index, key] of keys.entries()) {
      insertEntry(database, key, `id-${index}`);
    }
    const excluded = new Set(["\uD800", "\uDC00", ...keys.slice(1)]);
    expect(read(database, excluded)).toEqual(["id-0"]);
  });
});

describe("SQLite exclusion survivor semantics", () => {
  describe.each(["UTF-8", "UTF-16le", "UTF-16be"] as const)("%s JSON boundaries", (encoding) => {
    it.each([
      ["literal NUL", "\u0000", undefined],
      ["literal NUL and suffix", "\u0000garbage", undefined],
      ["valid escaped NUL", "", undefined],
      ["raw noncharacters", "", "noncharacters"],
      ["raw high surrogate", "", "high"],
      ["raw low surrogate", "", "low"],
      ["raw noncharacters with NUL", "\u0000", "noncharacters"],
      ["raw high surrogate with NUL", "\u0000", "high"],
      ["raw low surrogate with NUL", "\u0000", "low"],
    ] as const)(
      "preserves %s metadata parsing and prompt projection",
      (_name, suffix, rawLabel) => {
        const database = openDatabase(encoding);
        const key = "agent:main:survivor";
        const prompt = "unused saved prompt".repeat(32);
        const json =
          JSON.stringify({
            sessionId: "raw",
            updatedAt: 1,
            previousSessionId: "historical",
            label: rawLabel ? "RAW_LABEL" : "escaped\u0000日本語🦞",
            skillsSnapshot: { prompt, skills: [] },
          }) + suffix;
        let stored: string | Buffer = json;
        if (rawLabel) {
          const bytes = {
            noncharacters: {
              "UTF-8": "efbfbeefbfbf",
              "UTF-16le": "feffffff",
              "UTF-16be": "fffeffff",
            },
            high: { "UTF-8": "eda080", "UTF-16le": "00d8", "UTF-16be": "d800" },
            low: { "UTF-8": "edb080", "UTF-16le": "00dc", "UTF-16be": "dc00" },
          }[rawLabel][encoding];
          const encode = (value: string) => {
            const buffer = Buffer.from(value, encoding === "UTF-8" ? "utf8" : "utf16le");
            return encoding === "UTF-16be" ? buffer.swap16() : buffer;
          };
          const marker = json.indexOf("RAW_LABEL");
          stored = Buffer.concat([
            encode(json.slice(0, marker)),
            Buffer.from(bytes, "hex"),
            encode(json.slice(marker + "RAW_LABEL".length)),
          ]);
        }
        insertEntry(database, key, "raw", stored);
        const storedBytes = database.db.prepare(
          "SELECT hex(entry_json) AS bytes FROM session_nodes",
        );
        const bytesBefore = storedBytes.get()?.bytes;
        // Compare the actual full-reader contract, including older Node TEXT bindings.
        const full = readSessionEntryStore(database, { allowCanonicalRepair: true });
        const fullEntry = full[key];
        const metadata = fullEntry ? { ...fullEntry } : undefined;
        if (metadata) {
          delete metadata.skillsSnapshot;
          // SQLite's JSON projection normalizes raw UTF-16 noncharacters; full TEXT reads retain them.
          if (rawLabel === "noncharacters" && encoding !== "UTF-8" && !suffix) {
            metadata.label = "\uFFFD\uFFFD";
          }
        }
        expect(readSessionMaintenanceCapCandidates({ database, excludedKeys: new Set() })).toEqual(
          metadata ? { [key]: metadata } : {},
        );
        expect([...readReferencedSessionIds(database)].toSorted()).toEqual(
          fullEntry ? ["historical", "raw"] : ["raw"],
        );
        expect(readReferencedSessionIds(database, undefined, ["historical"])).toEqual(
          new Set(fullEntry ? ["historical"] : []),
        );
        expect(readReferencedSessionIds(database, undefined, ["raw"])).toEqual(new Set(["raw"]));
        expect(readSessionEntryCount(database)).toBe(Object.keys(full).length);
        expect([...iterateSessionEntryKeys(database)]).toEqual(Object.keys(full));
        if (fullEntry) {
          const listed = readExactSessionEntryRow(database, key, "list");
          expect(listed?.entry).toEqual(metadata);
          if (!suffix) {
            expect(listed?.row.entry_json).not.toContain(prompt);
          }
        } else {
          expect(() => readExactSessionEntryRow(database, key)).toThrow(
            "invalid persisted session row",
          );
          expect(() => readExactSessionEntryRow(database, key, "list")).toThrow(
            "invalid persisted session row",
          );
        }
        expect(
          readSessionMaintenanceCapCandidates({ database, excludedKeys: new Set([key]) }),
        ).toEqual({});
        expect([...readReferencedSessionIds(database, new Set([key]))]).toEqual([]);
        expect(storedBytes.get()?.bytes).toBe(bytesBefore);
      },
    );
  });

  it.each([
    ["malformed", "{", false],
    ["retained placeholder", "{}", false],
    ["JSON5", '{sessionId:"raw",updatedAt:1}', false],
    ["non-finite timestamp", '{"sessionId":"raw","updatedAt":1e999}', false],
    ["duplicate identity", '{"sessionId":null,"sessionId":"raw","updatedAt":1}', true],
    [
      "duplicate prompts",
      '{"sessionId":"raw","updatedAt":1,"skillsSnapshot":{},"skillsSnapshot":{"prompt":"last","skills":[]}}',
      true,
    ],
    [
      "deep JSON",
      `{"sessionId":"raw","updatedAt":1,"skillsSnapshot":{"prompt":${"[".repeat(1001)}0${"]".repeat(1001)},"skills":[]}}`,
      true,
    ],
  ])("preserves raw IDs and parser behavior for %s", (_name, json, readable) => {
    const database = openDatabase();
    insertEntry(database, "survivor", "raw", json);
    insertEntry(database, "excluded", "excluded");
    const excludedKeys = new Set(["excluded"]);
    expect([...readReferencedSessionIds(database, excludedKeys)]).toEqual(["raw"]);
    expect(readReferencedSessionIds(database, excludedKeys, ["raw"])).toEqual(new Set(["raw"]));
    expect(readSessionMaintenanceCapCandidates({ database, excludedKeys })).toEqual(
      readable ? { survivor: JSON.parse(json) } : {},
    );
  });

  it("retains surviving historical references, including archived entries", () => {
    const database = openDatabase();
    insertEntry(
      database,
      "archived",
      "current",
      JSON.stringify({
        sessionId: "current",
        updatedAt: 1,
        previousSessionId: " previous ",
        usageFamilySessionIds: ["family", "current"],
        compactionCheckpoints: [
          {
            sessionId: "checkpoint",
            preCompaction: { sessionId: "pre" },
            postCompaction: { sessionId: "post" },
          },
        ],
      }),
    );
    database.db
      .prepare("UPDATE session_nodes SET archived_at = 1 WHERE session_key = ?")
      .run("archived");
    const excludedKeys = new Set(["missing"]);
    expect([...readReferencedSessionIds(database, excludedKeys)].toSorted()).toEqual(
      ["current", "previous", "family", "checkpoint", "pre", "post"].toSorted(),
    );
    expect(readSessionMaintenanceCapCandidates({ database, excludedKeys })).toEqual({});
  });
});

describe("SQLite candidate reference reads", () => {
  it("does not materialize unrelated node metadata for one candidate", () => {
    const database = openDatabase();
    for (let index = 0; index < 32; index += 1) {
      insertEntry(
        database,
        `unrelated-${index}`,
        `current-${index}`,
        JSON.stringify({
          sessionId: `current-${index}`,
          updatedAt: 1,
          skillsSnapshot: { prompt: 'escaped "prompt"\\\n'.repeat(4096), skills: [] },
        }),
      );
    }
    insertEntry(database, "matched", "\u00a0candidate\ufeff");
    const keys = trackMaterializedKeys(database);
    expect(readReferencedSessionIds(database, undefined, ["candidate"])).toEqual(
      new Set(["candidate"]),
    );
    expect(keys).toEqual(["matched"]);
  });

  it.each([
    ["literal", '"previousSessionId":" candidate "'],
    ["escaped key", '"previous\\u0053essionId":" candidate "'],
    ["duplicate key", '"previousSessionId":null,"previousSessionId":" candidate "'],
    ["usage family", '"usageFamilySessionIds":[" candidate "]'],
    [
      "checkpoint",
      '"compactionCheckpoints":[{"sessionId":"candidate","preCompaction":{},"postCompaction":{}}]',
    ],
    [
      "pre-compaction",
      '"compactionCheckpoints":[{"preCompaction":{"sessionId":" candidate "},"postCompaction":{}}]',
    ],
    [
      "post-compaction",
      '"compactionCheckpoints":[{"preCompaction":{},"postCompaction":{"sessionId":" candidate "}}]',
    ],
    [
      "overdepth",
      `"previousSessionId":"candidate","unknown":${"[".repeat(1001)}0${"]".repeat(1001)}`,
    ],
  ])("protects %s references using the entry parser", (_name, fields) => {
    const database = openDatabase();
    insertEntry(database, "owner", "current", `{"sessionId":"current","updatedAt":1,${fields}}`);
    expect(readReferencedSessionIds(database, undefined, ["candidate"])).toEqual(
      new Set(["candidate"]),
    );
    expect(readReferencedSessionIds(database, new Set(["owner"]), ["candidate"])).toEqual(
      new Set(),
    );
  });

  it.each(['"previousSessionId":1', '"usageFamilySessionIds":[1]', '"compactionCheckpoints":[{}]'])(
    "retains parser failures for malformed references: %s",
    (fields) => {
      const database = openDatabase();
      insertEntry(database, "owner", "current", `{"sessionId":"current","updatedAt":1,${fields}}`);
      expect(() => readReferencedSessionIds(database, undefined, ["candidate"])).toThrow(TypeError);
      expect(readReferencedSessionIds(database, new Set(["owner"]), ["candidate"])).toEqual(
        new Set(),
      );
    },
  );

  it.each(["UTF-8", "UTF-16le", "UTF-16be"] as const)(
    "protects raw current IDs after %s text conversion",
    (encoding) => {
      const database = openDatabase(encoding);
      const bytes = {
        "UTF-8": ["eda080", "edb080", "ff", "c080", "efbfbe", "efbfbf", "610062"],
        "UTF-16le": ["00d8", "00dc", "feff", "ffff", "610000006200"],
        "UTF-16be": ["d800", "dc00", "fffe", "ffff", "006100000062"],
      }[encoding];
      insertEntry(database, "owner", "current");
      for (const hex of bytes) {
        database.db
          .prepare("UPDATE session_nodes SET current_session_id = CAST(? AS TEXT)")
          .run(Buffer.from(hex, "hex"));
        const returnedId = String(
          database.db.prepare("SELECT current_session_id FROM session_nodes").get()
            ?.current_session_id,
        );
        expect(readReferencedSessionIds(database, undefined, [returnedId])).toEqual(
          new Set([returnedId]),
        );
        expect(readReferencedSessionIds(database, new Set(["owner"]), [returnedId])).toEqual(
          new Set(),
        );
      }
    },
  );

  it.each(["UTF-8", "UTF-16le", "UTF-16be"] as const)(
    "preserves exact excluded-key membership for candidates in %s",
    (encoding) => {
      const database = openDatabase(encoding);
      const keys = ["nul\0tail", "a\uFFFE", "b\uFFFF", "c\uFFFD", "日本語🦞"];
      for (const [index, key] of keys.entries()) {
        insertEntry(database, key, `current-${index}`);
      }
      const returned = database.db
        .prepare("SELECT session_key, current_session_id FROM session_nodes")
        .all();
      for (const row of returned) {
        const candidate = String(row.current_session_id);
        const excluded = new Set(keys);
        expect(readReferencedSessionIds(database, excluded, [candidate])).toEqual(
          new Set(excluded.has(String(row.session_key)) ? [] : [candidate]),
        );
      }
    },
  );

  it("reads references added during a transaction freshly", () => {
    const database = openDatabase();
    insertEntry(database, "owner", "current");
    expect(readReferencedSessionIds(database, undefined, ["late"])).toEqual(new Set());
    database.db.exec("BEGIN IMMEDIATE");
    try {
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ?")
        .run(JSON.stringify({ sessionId: "current", updatedAt: 1, previousSessionId: "late" }));
      expect(readReferencedSessionIds(database, undefined, ["late"])).toEqual(new Set(["late"]));
    } finally {
      database.db.exec("ROLLBACK");
    }
    expect(readReferencedSessionIds(database, undefined, ["late"])).toEqual(new Set());
  });
});
