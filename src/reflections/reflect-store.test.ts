import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  addReflection,
  getReflection,
  listReflections,
  resolveReflectionsJsonlPath,
} from "./reflect-store.js";

async function withTempStateDir<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reflections-"));
  const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
  try {
    return await fn(env);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("reflect-store", () => {
  it("adds reflections as JSONL under the state dir", async () => {
    await withTempStateDir(async (env) => {
      const entry = await addReflection({
        env,
        title: "AAR 1",
        body: "Worked on CLI.\n\nWhat went well: tests.",
        tags: ["aar", "cli"],
        id: "fixed-id",
        createdAt: "2026-02-07T12:00:00.000Z",
      });

      const filePath = resolveReflectionsJsonlPath(env);
      expect(filePath.startsWith(env.OPENCLAW_STATE_DIR!)).toBe(true);
      const raw = await fs.readFile(filePath, "utf-8");
      expect(raw).toContain("fixed-id");
      expect(raw.trim().split("\n").length).toBe(1);
      expect(entry.id).toBe("fixed-id");
    });
  });

  it("lists newest first and supports limit", async () => {
    await withTempStateDir(async (env) => {
      await addReflection({ env, id: "a", createdAt: "2026-02-07T10:00:00.000Z", body: "a" });
      await addReflection({ env, id: "b", createdAt: "2026-02-07T11:00:00.000Z", body: "b" });
      await addReflection({ env, id: "c", createdAt: "2026-02-07T09:00:00.000Z", body: "c" });

      const all = await listReflections({ env });
      expect(all.map((e) => e.id)).toEqual(["b", "a", "c"]);

      const limited = await listReflections({ env, limit: 2 });
      expect(limited.map((e) => e.id)).toEqual(["b", "a"]);
    });
  });

  it("gets a reflection by id", async () => {
    await withTempStateDir(async (env) => {
      await addReflection({ env, id: "a", createdAt: "2026-02-07T10:00:00.000Z", body: "hello" });
      const found = await getReflection({ env, id: "a" });
      expect(found?.body).toBe("hello");
      const missing = await getReflection({ env, id: "nope" });
      expect(missing).toBe(null);
    });
  });
});
