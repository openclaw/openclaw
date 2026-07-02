import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_STORE_TEMP_STALE_MS } from "./artifacts.js";
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

function setOlderThanMs(filePath: string, millisecondsAgo: number): void {
  const target = Date.now() - millisecondsAgo;
  fs.utimesSync(filePath, new Date(target), new Date(target));
}

function setNowMtime(filePath: string): void {
  const now = new Date();
  fs.utimesSync(filePath, now, now);
}

function makeSessionStoreTmpPath(dir: string, storeBase = "sessions.json"): string {
  return path.join(dir, `${storeBase}.12345.${crypto.randomUUID()}.tmp`);
}

function makeLegacySessionStoreTmpPath(dir: string, storeBase = "sessions.json"): string {
  return path.join(dir, `${storeBase}.${crypto.randomUUID()}.tmp`);
}

describe("session store load recovery", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when main file is missing even if .bak exists", () => {
    const bakPath = `${storePath}.bak`;
    writeJson(bakPath, makeValidStore("bak-session"));
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("does not recover from .bak when main file is zero bytes", () => {
    fs.writeFileSync(storePath, "", "utf-8");
    writeJson(`${storePath}.bak`, makeValidStore("s1", "s2", "s3"));
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(0);
    expect(fs.readFileSync(storePath, "utf-8")).toBe("");
  });

  it("does not recover from .bak when main file has malformed JSON", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    writeJson(`${storePath}.bak`, makeValidStore("bak-session"));
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(0);
    expect(fs.readFileSync(storePath, "utf-8")).toBe("{bad json");
  });

  it("recovers from stale legacy tmp when main is malformed", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const tmpFile = makeLegacySessionStoreTmpPath(tmpDir);
    writeJson(tmpFile, makeValidStore("tmp1", "tmp2"));
    setOlderThanMs(tmpFile, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(2);
  });

  it("recovers from stale session-store tmp when main is malformed", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const sessionTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(sessionTmp, makeValidStore("session-tmp-1", "session-tmp-2"));
    setOlderThanMs(sessionTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(2);
  });

  it("does not rewrite the malformed primary when recovering from stale tmp", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const sessionTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(sessionTmp, makeValidStore("tmp-recovered"));
    setOlderThanMs(sessionTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const renameSpy = vi.spyOn(fs, "renameSync");

    const store = loadSessionStore(storePath, { skipCache: true });

    expect(store["tmp-recovered"]).toBeDefined();
    expect(fs.readFileSync(storePath, "utf-8")).toBe("{bad json");
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer primary installed during tmp recovery", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const sessionTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(sessionTmp, makeValidStore("from-tmp"));
    setOlderThanMs(sessionTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const newerPrimary = makeValidStore("newer-primary");
    const originalOpenSync = fs.openSync.bind(fs);
    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      if (target === sessionTmp) {
        originalWriteFileSync(storePath, JSON.stringify(newerPrimary, null, 2), "utf-8");
      }
      return originalOpenSync(target, flags, mode);
    });

    const store = loadSessionStore(storePath, { skipCache: true });

    expect(store["from-tmp"]).toBeDefined();
    expect(JSON.parse(fs.readFileSync(storePath, "utf-8"))["newer-primary"]).toBeDefined();
    expect(openSpy).toHaveBeenCalled();
  });

  it("reads tmp recovery candidates through the opened file descriptor", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const sessionTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(sessionTmp, makeValidStore("fd-bound"));
    setOlderThanMs(sessionTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const readSpy = vi.spyOn(fs, "readFileSync");

    const store = loadSessionStore(storePath, { skipCache: true });

    expect(store["fd-bound"]).toBeDefined();
    expect(readSpy.mock.calls.some(([target]) => typeof target === "number")).toBe(true);
    expect(readSpy.mock.calls.some(([target]) => target === sessionTmp)).toBe(false);
  });

  it("does not recover from .bak when main file is valid empty object", () => {
    writeJson(storePath, {});
    writeJson(`${storePath}.bak`, makeValidStore("bak-session"));
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("does not recover from .bak or tmp when main file contains valid []", () => {
    writeJson(storePath, []);
    writeJson(`${storePath}.bak`, makeValidStore("bak-session"));
    const staleTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(staleTmp, makeValidStore("stale-session"));
    setOlderThanMs(staleTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(0);
    expect(store["bak-session"]).toBeUndefined();
    expect(store["stale-session"]).toBeUndefined();
  });

  it("recovers from stale current tmp preferred over fresh legacy tmp", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const sessionTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(sessionTmp, makeValidStore("session-tmp"));
    setOlderThanMs(sessionTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const freshLegacyTmp = makeLegacySessionStoreTmpPath(tmpDir);
    writeJson(freshLegacyTmp, makeValidStore("fresh"));
    setNowMtime(freshLegacyTmp);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["session-tmp"]).toBeDefined();
    expect(store["fresh"]).toBeUndefined();
  });

  it("prefers newest stale tmp when multiple valid candidates exist", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const olderTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(olderTmp, makeValidStore("older-session"));
    setOlderThanMs(olderTmp, SESSION_STORE_TEMP_STALE_MS + 60_000);
    const newerTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(newerTmp, makeValidStore("newer-session"));
    setOlderThanMs(newerTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["newer-session"]).toBeDefined();
    expect(store["older-session"]).toBeUndefined();
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("ignores temp artifacts younger than the cleanup stale window", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const youngTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(youngTmp, makeValidStore("young-only"));
    setOlderThanMs(youngTmp, 60_000);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("skips empty {} tmp candidate and continues to next valid candidate", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const emptyTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(emptyTmp, {});
    setOlderThanMs(emptyTmp, SESSION_STORE_TEMP_STALE_MS + 30_000);
    const validTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(validTmp, makeValidStore("recovered"));
    setOlderThanMs(validTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["recovered"]).toBeDefined();
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("skips unrelated json tmp (no sessionId entries) and continues scanning", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const unrelatedTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(unrelatedTmp, { version: 1, config: { foo: "bar" } });
    setOlderThanMs(unrelatedTmp, SESSION_STORE_TEMP_STALE_MS + 30_000);
    const validTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(validTmp, makeValidStore("recovered"));
    setOlderThanMs(validTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["recovered"]).toBeDefined();
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("ignores .bak and falls through to stale tmp", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    writeJson(`${storePath}.bak`, { version: 1, config: { foo: "bar" } });
    const validTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(validTmp, makeValidStore("from-tmp"));
    setOlderThanMs(validTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["from-tmp"]).toBeDefined();
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("does not recover from .bak or tmp when the primary store cannot be read", () => {
    fs.mkdirSync(storePath);
    writeJson(`${storePath}.bak`, makeValidStore("bak-session"));
    const validTmp = makeSessionStoreTmpPath(tmpDir);
    writeJson(validTmp, makeValidStore("tmp-session"));
    setOlderThanMs(validTmp, SESSION_STORE_TEMP_STALE_MS + 1_000);

    const store = loadSessionStore(storePath, { skipCache: true });

    expect(Object.keys(store)).toHaveLength(0);
    expect(store["bak-session"]).toBeUndefined();
    expect(store["tmp-session"]).toBeUndefined();
    expect(fs.statSync(storePath).isDirectory()).toBe(true);
  });
});
