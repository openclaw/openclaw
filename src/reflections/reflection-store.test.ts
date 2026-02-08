import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendReflection,
  getReflectionById,
  listReflections,
  readAllReflections,
  resolveReflectionsPath,
} from "./reflection-store.js";

describe("reflection-store", () => {
  it("appends JSONL entries and can read them back", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reflect-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };

    const one = await appendReflection({
      env,
      now: () => new Date("2026-02-07T00:00:00.000Z"),
      cwd: () => "/tmp",
      hostname: () => "host",
      platform: "darwin",
      openclawVersion: "0.0.0-test",
      input: {
        title: "First",
        tags: ["Onboarding", "notes"],
        whatWorked: "A",
      },
    });
    const two = await appendReflection({
      env,
      now: () => new Date("2026-02-07T01:00:00.000Z"),
      cwd: () => "/tmp",
      hostname: () => "host",
      platform: "darwin",
      openclawVersion: "0.0.0-test",
      input: {
        title: "Second",
        tags: ["notes"],
        whatDidnt: "B",
      },
    });

    const filePath = resolveReflectionsPath(env);
    const raw = await fs.readFile(filePath, "utf-8");
    expect(raw.trim().split(/\r?\n/)).toHaveLength(2);

    const all = await readAllReflections(env);
    expect(all.map((r) => r.id)).toEqual([one.id, two.id]);
  });

  it("lists newest first, supports limit and tag filter", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reflect-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };

    const older = await appendReflection({
      env,
      now: () => new Date("2026-02-07T00:00:00.000Z"),
      input: { title: "Older", tags: ["alpha"] },
    });
    const newer = await appendReflection({
      env,
      now: () => new Date("2026-02-07T02:00:00.000Z"),
      input: { title: "Newer", tags: ["beta", "alpha"] },
    });

    const listed = await listReflections({}, env);
    expect(listed.map((r) => r.id)).toEqual([newer.id, older.id]);

    const limited = await listReflections({ limit: 1 }, env);
    expect(limited.map((r) => r.id)).toEqual([newer.id]);

    const filtered = await listReflections({ tag: "ALPHA" }, env);
    expect(filtered.map((r) => r.id)).toEqual([newer.id, older.id]);

    const filtered2 = await listReflections({ tag: "beta" }, env);
    expect(filtered2.map((r) => r.id)).toEqual([newer.id]);
  });

  it("shows entries by id", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reflect-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };

    const entry = await appendReflection({
      env,
      now: () => new Date("2026-02-07T00:00:00.000Z"),
      input: { title: "Hello" },
    });

    const found = await getReflectionById(entry.id, env);
    expect(found?.id).toBe(entry.id);

    const missing = await getReflectionById("does-not-exist", env);
    expect(missing).toBeNull();
  });
});
