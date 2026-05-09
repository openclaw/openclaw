import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSessionStore } from "./store-load.js";

function makeValidStore(...sessionIds: string[]): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  for (const id of sessionIds) {
    store[id] = { sessionId: id, updatedAt: Date.now() };
  }
  return store;
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "session-recovery-"));
}

function setOlderThan(filePath: string, secondsAgo: number): void {
  const now = Date.now() / 1000;
  const target = now - secondsAgo;
  fs.utimesSync(filePath, new Date(target * 1000), new Date(target * 1000));
}

function setNowMtime(filePath: string): void {
  const now = new Date();
  fs.utimesSync(filePath, now, now);
}

function getFileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

describe("session store load recovery", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when main file is missing even if .bak exists", () => {
    const bakPath = `${storePath}.bak`;
    writeJson(bakPath, makeValidStore("bak-session"));
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("recovers 3 entries from .bak when main file is zero bytes", () => {
    fs.writeFileSync(storePath, "", "utf-8");
    writeJson(`${storePath}.bak`, makeValidStore("s1", "s2", "s3"));
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(3);
    if (process.platform !== "win32") {
      expect(getFileMode(storePath)).toBe(0o600);
    }
  });

  it("recovers from .bak when main file has malformed JSON", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    writeJson(`${storePath}.bak`, makeValidStore("bak-session"));
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("recovers from stale legacy tmp when main is malformed", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const tmpFile = path.join(tmpDir, `sessions.json.${crypto.randomUUID()}.tmp`);
    writeJson(tmpFile, makeValidStore("tmp1", "tmp2"));
    setOlderThan(tmpFile, 15);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(2);
  });

  it("recovers from stale fs-safe tmp when main is malformed", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const fsSafeTmp = path.join(tmpDir, ".sessions.json.12345.abcdef-1234.tmp");
    writeJson(fsSafeTmp, makeValidStore("fs-safe-1", "fs-safe-2"));
    setOlderThan(fsSafeTmp, 15);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(2);
  });

  it("does not recover from .bak when main file is valid empty object", () => {
    writeJson(storePath, {});
    writeJson(`${storePath}.bak`, makeValidStore("bak-session"));
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("recovers from stale fs-safe tmp preferred over fresh legacy tmp", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const fsSafeTmp = path.join(tmpDir, ".sessions.json.12345.abcdef-1234.tmp");
    writeJson(fsSafeTmp, makeValidStore("fs-safe"));
    setOlderThan(fsSafeTmp, 15);
    const freshLegacyTmp = path.join(tmpDir, `sessions.json.${crypto.randomUUID()}.tmp`);
    writeJson(freshLegacyTmp, makeValidStore("fresh"));
    setNowMtime(freshLegacyTmp);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["fs-safe"]).toBeDefined();
    expect(store["fresh"]).toBeUndefined();
  });

  it("self-heals main file after recovery from .bak", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    writeJson(`${storePath}.bak`, makeValidStore("heal-session"));
    loadSessionStore(storePath, { skipCache: true });
    const healedRaw = fs.readFileSync(storePath, "utf-8");
    const healedParsed = JSON.parse(healedRaw);
    expect(healedParsed["heal-session"]).toBeDefined();
  });
});
