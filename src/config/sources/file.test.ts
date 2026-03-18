import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createFileConfigSource } from "./file.js";
import * as path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("createFileConfigSource", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "openclaw-file-source-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns source with kind file and watchPath", async () => {
    const configPath = path.join(tmpDir, "openclaw.json");
    await writeFile(configPath, '{"gateway":{"mode":"local"}}', "utf-8");
    const source = createFileConfigSource({ configPath, env: process.env });
    expect(source.kind).toBe("file");
    expect(source.watchPath).toBe(configPath);
    const snap = await source.readSnapshot();
    expect(snap.path).toBe(configPath);
    expect(snap.exists).toBe(true);
    expect(snap.config?.gateway?.mode).toBe("local");
  });

  it("readSnapshot returns valid snapshot for missing file", async () => {
    const configPath = path.join(tmpDir, "openclaw.json");
    const source = createFileConfigSource({ configPath, env: process.env });
    const snap = await source.readSnapshot();
    expect(snap.exists).toBe(false);
    expect(snap.valid).toBe(true);
  });
});
