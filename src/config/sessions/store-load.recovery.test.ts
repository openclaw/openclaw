import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { loadSessionStore } from "./store-load.js";

function makeStore(entries: Array<[string, string]>): string {
  const store: Record<string, unknown> = {};
  for (const [key, sid] of entries) {
    store[key] = { sessionId: sid, startedAt: Date.now(), status: "running" };
  }
  return JSON.stringify(store);
}

function makeStoreObj(entries: Array<[string, string]>) {
  const store: Record<string, unknown> = {};
  for (const [key, sid] of entries) {
    store[key] = { sessionId: sid, startedAt: Date.now(), status: "running" };
  }
  return store;
}

async function makeStaleTmp(
  storePath: string,
  name: string,
  entries: Array<[string, string]>,
  ageMs: number,
) {
  const tp = `${storePath}.${name}.tmp`;
  await fs.writeFile(tp, makeStore(entries), "utf-8");
  const oldTime = new Date(Date.now() - ageMs);
  await fs.utimes(tp, oldTime, oldTime);
}

describe("session store recovery", () => {
  // --- A. Behavior Definition ---

  it("main missing (ENOENT) -> no recovery", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(`${sp}.bak`, makeStore([["old", "x"]]), "utf-8");
      const store = loadSessionStore(sp, { skipCache: true });
      expect(Object.keys(store)).toHaveLength(0);
    });
  });

  it("main 0-byte -> recovery from .bak", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "", "utf-8");
      await fs.writeFile(
        `${sp}.bak`,
        makeStore([
          ["s1", "a"],
          ["s2", "b"],
        ]),
        "utf-8",
      );
      const store = loadSessionStore(sp, { skipCache: true });
      expect(Object.keys(store)).toHaveLength(2);
      expect(store.s1?.sessionId).toBe("a");
      expect(store.s2?.sessionId).toBe("b");
    });
  });

  it("main parse error -> recovery from .bak", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "{bad json!!!", "utf-8");
      await fs.writeFile(`${sp}.bak`, makeStore([["s1", "a"]]), "utf-8");
      const store = loadSessionStore(sp, { skipCache: true });
      expect(Object.keys(store)).toHaveLength(1);
      expect(store.s1?.sessionId).toBe("a");
    });
  });

  it("main parse error -> recovery from stale .tmp", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "{bad json!!!", "utf-8");
      await makeStaleTmp(
        sp,
        "abc",
        [
          ["a", "1"],
          ["b", "2"],
          ["c", "3"],
        ],
        10000,
      );
      const store = loadSessionStore(sp, { skipCache: true });
      expect(Object.keys(store)).toHaveLength(3);
    });
  });

  it("main valid {} -> no recovery", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "{}", "utf-8");
      await fs.writeFile(`${sp}.bak`, makeStore([["old", "x"]]), "utf-8");
      const store = loadSessionStore(sp, { skipCache: true });
      expect(Object.keys(store)).toHaveLength(0);
    });
  });

  it("main valid {} with newline -> no recovery", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "{}\n", "utf-8");
      await fs.writeFile(`${sp}.bak`, makeStore([["old", "x"]]), "utf-8");
      const store = loadSessionStore(sp, { skipCache: true });
      expect(Object.keys(store)).toHaveLength(0);
    });
  });

  it("main non-object JSON (array) -> recovery", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "[1,2,3]", "utf-8");
      await fs.writeFile(`${sp}.bak`, makeStore([["s1", "a"]]), "utf-8");
      const store = loadSessionStore(sp, { skipCache: true });
      expect(Object.keys(store)).toHaveLength(1);
      expect(store.s1?.sessionId).toBe("a");
    });
  });

  it("main non-object JSON (string) -> recovery", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, JSON.stringify("broken"), "utf-8");
      await fs.writeFile(`${sp}.bak`, makeStore([["s1", "a"]]), "utf-8");
      const store = loadSessionStore(sp, { skipCache: true });
      expect(Object.keys(store)).toHaveLength(1);
    });
  });

  it("main non-object JSON (number) -> recovery", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "123", "utf-8");
      await fs.writeFile(`${sp}.bak`, makeStore([["s1", "a"]]), "utf-8");
      const store = loadSessionStore(sp, { skipCache: true });
      expect(Object.keys(store)).toHaveLength(1);
    });
  });

  it("main valid with data -> unaffected", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(
        sp,
        makeStore([
          ["s1", "a"],
          ["s2", "b"],
        ]),
        "utf-8",
      );
      await fs.writeFile(`${sp}.bak`, makeStore([["old", "x"]]), "utf-8");
      const store = loadSessionStore(sp, { skipCache: true });
      expect(Object.keys(store)).toHaveLength(2);
      expect(store.s1?.sessionId).toBe("a");
    });
  });

  // --- B. Candidate Selection ---

  it("sourceRank: .bak(3) preferred over stale tmp(2)", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "{bad", "utf-8");
      await fs.writeFile(
        `${sp}.bak`,
        makeStore([["bak", "recovered"]]),
        "utf-8",
      );
      await makeStaleTmp(sp, "stale", [["tmp", "x"]], 10000);
      const store = loadSessionStore(sp, { skipCache: true });
      expect(store.bak?.sessionId).toBe("recovered");
    });
  });

  it("fresh tmp used as fallback when no stale or bak exists", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "{bad", "utf-8");
      // Fresh tmp — lowest sourceRank but still available as fallback
      const fresh = `${sp}.fresh.tmp`;
      await fs.writeFile(
        fresh,
        makeStore([
          ["f1", "a"],
          ["f2", "b"],
        ]),
        "utf-8",
      );
      const store = loadSessionStore(sp, { skipCache: true });
      // Recovery succeeds from fresh tmp when no .bak or stale tmp exists
      expect(Object.keys(store)).toHaveLength(2);
      expect(store.f1?.sessionId).toBe("a");
      expect(store.f2?.sessionId).toBe("b");
    });
  });

  it("stale tmp preferred over fresh tmp (sourceRank 2 > 1)", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "{bad", "utf-8");
      // Fresh tmp — sourceRank=1 (lowest priority, still available as fallback)
      const fresh = `${sp}.fresh.tmp`;
      await fs.writeFile(fresh, makeStore([["f1", "x"]]), "utf-8");
      // Stale tmp — sourceRank=2 (higher priority, wins)
      await makeStaleTmp(sp, "stale", [["s1", "a"]], 10000);
      const store = loadSessionStore(sp, { skipCache: true });
      // Stale tmp wins because sourceRank=2 > fresh sourceRank=1
      expect(store.s1?.sessionId).toBe("a");
    });
  });

  it("multiple stale tmps -> newest mtime wins", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "{bad", "utf-8");
      await makeStaleTmp(
        sp,
        "older",
        [
          ["a", "1"],
          ["b", "2"],
          ["c", "3"],
          ["d", "4"],
          ["e", "5"],
        ],
        12000,
      );
      await makeStaleTmp(
        sp,
        "newer",
        [
          ["x", "1"],
          ["y", "2"],
        ],
        8000,
      );
      const store = loadSessionStore(sp, { skipCache: true });
      expect(Object.keys(store)).toHaveLength(2);
      expect(store.x?.sessionId).toBe("1");
    });
  });

  it(".bak always included even with 60+ stale tmps", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "{bad", "utf-8");
      await fs.writeFile(
        `${sp}.bak`,
        makeStore([["bak", "recovered"]]),
        "utf-8",
      );
      for (let i = 0; i < 60; i++) {
        const entries: Array<[string, string]> = [];
        for (let j = 0; j <= i; j++)
          entries.push([`t${i}s${j}`, `id-${j}`]);
        await makeStaleTmp(sp, `t${i}`, entries, (60 - i) * 1000);
      }
      const store = loadSessionStore(sp, { skipCache: true });
      expect(store.bak?.sessionId).toBe("recovered");
    });
  });

  it("candidate with only non-object entries -> rejected", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "{bad json", "utf-8");
      const tp = `${sp}.bad.tmp`;
      await fs.writeFile(
        tp,
        JSON.stringify({ foo: "bar", bad: 123 }),
        "utf-8",
      );
      const oldTime = new Date(Date.now() - 10000);
      await fs.utimes(tp, oldTime, oldTime);
      const store = loadSessionStore(sp, { skipCache: true });
      expect(Object.keys(store)).toHaveLength(0);
    });
  });

  it("candidate with empty {} -> rejected", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "{bad json", "utf-8");
      await fs.writeFile(`${sp}.bak`, "{}", "utf-8");
      const store = loadSessionStore(sp, { skipCache: true });
      expect(Object.keys(store)).toHaveLength(0);
    });
  });

  it("candidate with object entries but no sessionId -> rejected", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "{bad json", "utf-8");
      const tp = `${sp}.junk.tmp`;
      await fs.writeFile(
        tp,
        JSON.stringify({ junk: { foo: "bar" } }),
        "utf-8",
      );
      const oldTime = new Date(Date.now() - 10000);
      await fs.utimes(tp, oldTime, oldTime);
      const store = loadSessionStore(sp, { skipCache: true });
      expect(Object.keys(store)).toHaveLength(0);
    });
  });

  it("no valid candidates -> empty", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "{bad json", "utf-8");
      const store = loadSessionStore(sp, { skipCache: true });
      expect(Object.keys(store)).toHaveLength(0);
    });
  });

  // --- C. Self-Heal Writeback ---

  it("recovery rewrites corrupted main store atomically (self-heal)", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "{bad json!!!", "utf-8");
      await fs.writeFile(
        `${sp}.bak`,
        makeStore([
          ["s1", "a"],
          ["s2", "b"],
        ]),
        "utf-8",
      );
      const store = loadSessionStore(sp, { skipCache: true });
      expect(Object.keys(store)).toHaveLength(2);

      // Verify main file was self-healed
      const content = await fs.readFile(sp, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.s1?.sessionId).toBe("a");
      expect(parsed.s2?.sessionId).toBe("b");

      // Reload to confirm
      const store2 = loadSessionStore(sp, { skipCache: true });
      expect(Object.keys(store2)).toHaveLength(2);
    });
  });

  it("0-byte main self-heals from .bak", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "", "utf-8");
      await fs.writeFile(`${sp}.bak`, makeStore([["s1", "a"]]), "utf-8");
      const store = loadSessionStore(sp, { skipCache: true });
      expect(Object.keys(store)).toHaveLength(1);

      // Verify self-heal
      const content = await fs.readFile(sp, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.s1?.sessionId).toBe("a");
    });
  });
});

  it("self-heal file has mode 0o600 on non-Windows", async () => {
    if (process.platform === "win32") return;
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      await fs.writeFile(sp, "{bad json!!!", "utf-8");
      await fs.writeFile(
        `${sp}.bak`,
        makeStore([["s1", "a"]]),
        "utf-8",
      );
      loadSessionStore(sp, { skipCache: true });
      // Self-heal should have created main with 0o600
      const stat = await fs.stat(sp);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  it("parseable object with invalid entries does not trigger recovery", async () => {
    await withTempDir({ prefix: "pr2-" }, async (dir) => {
      const sp = path.join(dir, "sessions.json");
      // Main file is parseable but has invalid entries
      await fs.writeFile(
        sp,
        JSON.stringify({ junk: { foo: "bar" } }),
        "utf-8",
      );
      await fs.writeFile(`${sp}.bak`, makeStore([["s1", "a"]]), "utf-8");
      const store = loadSessionStore(sp, { skipCache: true });
      // Should NOT recover — main file is parseable object
      expect(Object.keys(store)).toHaveLength(1);
      expect(store.junk).toBeDefined();
    });
  });
