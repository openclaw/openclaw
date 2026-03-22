import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as jsonFiles from "../../infra/json-files.js";
import { loadConfig } from "../config.js";
import {
  clearSessionStoreCacheForTest,
  decodeDirectorySessionStoreEntryFileName,
  encodeDirectorySessionStoreKey,
  loadSessionStore,
  migrateSessionStoreToDirectory,
  readSessionUpdatedAt,
  resolveSessionStoreDir,
  resolveSessionStoreStatePath,
  saveSessionStore,
  updateLastRoute,
  updateSessionStoreEntry,
} from "./store.js";

vi.mock("../config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

describe("directory session store", () => {
  let fixtureRoot = "";
  let caseId = 0;

  const makeCaseDir = async (prefix: string): Promise<string> => {
    const dir = path.join(fixtureRoot, `${prefix}-${caseId++}`);
    await fsPromises.mkdir(dir, { recursive: true });
    return dir;
  };

  const writeLegacyStore = async (
    entries: Record<string, Record<string, unknown>>,
    prefix: string,
  ): Promise<string> => {
    const dir = await makeCaseDir(prefix);
    const storePath = path.join(dir, "sessions.json");
    await fsPromises.writeFile(storePath, JSON.stringify(entries, null, 2), "utf-8");
    return storePath;
  };

  beforeAll(async () => {
    fixtureRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-dir-store-test-"));
  });

  beforeEach(() => {
    clearSessionStoreCacheForTest();
    vi.mocked(loadConfig).mockReturnValue({});
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await fsPromises.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("round-trips directory entry filenames without ambiguity", () => {
    const cases = [
      "agent:main:direct:+15551234567",
      "agent:main:100%done",
      "agent:main:path/with/slashes",
      "agent:main:path\\with\\backslashes",
      "agent:main:a--b",
    ];

    for (const sessionKey of cases) {
      const encoded = encodeDirectorySessionStoreKey(sessionKey);
      expect(decodeDirectorySessionStoreEntryFileName(encoded)).toBe(sessionKey);
    }

    expect(encodeDirectorySessionStoreKey("agent:main:a:b")).not.toBe(
      encodeDirectorySessionStoreKey("agent:main:a--b"),
    );
  });

  it("hashes oversized session keys into fixed-length filenames", async () => {
    const longKey = `agent:main:${"x".repeat(400)}`;
    const encoded = encodeDirectorySessionStoreKey(longKey);

    expect(encoded.startsWith("session-hash-")).toBe(true);
    expect(encoded.length).toBeLessThan(80);
    expect(decodeDirectorySessionStoreEntryFileName(encoded)).toBeNull();

    const storePath = await writeLegacyStore(
      {
        [longKey]: { sessionId: "sess-long", updatedAt: 10 },
      },
      "long-key",
    );

    await expect(migrateSessionStoreToDirectory(storePath)).resolves.toBe(true);
    expect(loadSessionStore(storePath)[longKey]?.sessionId).toBe("sess-long");
  });

  it("migrates legacy sessions.json into an authoritative sessions.d layout", async () => {
    const storePath = await writeLegacyStore(
      {
        "Agent:Main:Main": { sessionId: "sess-older", updatedAt: 10 },
        "agent:main:main": { sessionId: "sess-newer", updatedAt: 20, modelOverride: "gpt-5.2" },
        "agent:main:other": { sessionId: "sess-other", updatedAt: 30 },
      },
      "migrate",
    );

    await expect(migrateSessionStoreToDirectory(storePath)).resolves.toBe(true);

    const storeDir = resolveSessionStoreDir(storePath);
    expect(fs.existsSync(resolveSessionStoreStatePath(storePath))).toBe(true);
    expect(fs.existsSync(storeDir)).toBe(true);
    expect(
      fs.readdirSync(path.dirname(storePath)).some((name) => name.startsWith("sessions.json.bak.")),
    ).toBe(true);

    const loaded = loadSessionStore(storePath);
    expect(Object.keys(loaded).toSorted()).toEqual(["agent:main:main", "agent:main:other"]);
    expect(loaded["agent:main:main"]?.sessionId).toBe("sess-newer");
    expect(loaded["agent:main:main"]?.modelOverride).toBe("gpt-5.2");
  });

  it("persists empty stores back to legacy json when migration has no entries", async () => {
    const storePath = await writeLegacyStore(
      {
        "agent:main:main": { sessionId: "sess-1", updatedAt: 10 },
      },
      "empty-legacy",
    );

    await saveSessionStore(storePath, {});
    clearSessionStoreCacheForTest();

    expect(loadSessionStore(storePath)).toEqual({});
    expect(fs.readFileSync(storePath, "utf-8").trim()).toBe("{}");
    expect(fs.existsSync(resolveSessionStoreStatePath(storePath))).toBe(false);
  });

  it("keeps legacy JSON authoritative when staged migration fails", async () => {
    const storePath = await writeLegacyStore(
      {
        "agent:main:main": { sessionId: "sess-1", updatedAt: 10, modelOverride: "before" },
      },
      "migrate-fail",
    );

    const originalWriteTextAtomic = jsonFiles.writeTextAtomic;
    const writeSpy = vi.spyOn(jsonFiles, "writeTextAtomic");
    let injected = false;
    writeSpy.mockImplementation(async (filePath, content, options) => {
      if (
        !injected &&
        String(filePath).includes(".staging-") &&
        String(filePath).endsWith(".json")
      ) {
        injected = true;
        throw new Error("boom");
      }
      return await originalWriteTextAtomic(filePath, content, options);
    });

    await expect(migrateSessionStoreToDirectory(storePath)).rejects.toThrow("boom");

    expect(fs.existsSync(storePath)).toBe(true);
    expect(fs.existsSync(resolveSessionStoreStatePath(storePath))).toBe(false);
    const loaded = loadSessionStore(storePath);
    expect(loaded["agent:main:main"]?.modelOverride).toBe("before");
  });

  it("invalidates the directory cache when the version stamp changes", async () => {
    const storePath = await writeLegacyStore(
      {
        "agent:main:main": { sessionId: "sess-1", updatedAt: 10, thinkingLevel: "low" },
      },
      "version",
    );

    await migrateSessionStoreToDirectory(storePath);
    expect(loadSessionStore(storePath)["agent:main:main"]?.thinkingLevel).toBe("low");

    const entryPath = path.join(
      resolveSessionStoreDir(storePath),
      "entries",
      encodeDirectorySessionStoreKey("agent:main:main"),
    );
    fs.writeFileSync(
      entryPath,
      JSON.stringify({ sessionId: "sess-1", updatedAt: 11, thinkingLevel: "high" }, null, 2),
      "utf-8",
    );
    const statePath = resolveSessionStoreStatePath(storePath);
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
      version: number;
      updatedAt: number;
    };
    fs.writeFileSync(
      statePath,
      JSON.stringify({ ...state, version: state.version + 1, updatedAt: Date.now() }, null, 2),
      "utf-8",
    );

    expect(loadSessionStore(storePath)["agent:main:main"]?.thinkingLevel).toBe("high");
  });

  it("updates one directory entry without scanning the whole store", async () => {
    const storePath = await writeLegacyStore(
      {
        "agent:main:main": { sessionId: "sess-1", updatedAt: 10, thinkingLevel: "low" },
        "agent:main:other": { sessionId: "sess-2", updatedAt: 20, thinkingLevel: "medium" },
      },
      "entry-update",
    );

    await migrateSessionStoreToDirectory(storePath);
    const readdirSpy = vi.spyOn(fs, "readdirSync");

    await updateSessionStoreEntry({
      storePath,
      sessionKey: "AGENT:MAIN:MAIN",
      update: async () => ({ thinkingLevel: "high" }),
    });

    expect(readdirSpy).not.toHaveBeenCalled();
    const loaded = loadSessionStore(storePath);
    expect(loaded["agent:main:main"]?.thinkingLevel).toBe("high");
    expect(loaded["agent:main:other"]?.thinkingLevel).toBe("medium");
  });

  it("updates last route without loading the full directory store", async () => {
    const storePath = await writeLegacyStore(
      {
        "agent:main:main": { sessionId: "sess-1", updatedAt: 10, thinkingLevel: "low" },
      },
      "last-route",
    );

    await migrateSessionStoreToDirectory(storePath);
    const readdirSpy = vi.spyOn(fs, "readdirSync");

    await updateLastRoute({
      storePath,
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "telegram",
        to: " 12345 ",
      },
    });

    expect(readdirSpy).not.toHaveBeenCalled();
    const loaded = loadSessionStore(storePath);
    expect(loaded["agent:main:main"]?.lastChannel).toBe("telegram");
    expect(loaded["agent:main:main"]?.lastTo).toBe("12345");
  });

  it("reads updatedAt directly from a single directory entry", async () => {
    const storePath = await writeLegacyStore(
      {
        "agent:main:main": { sessionId: "sess-1", updatedAt: 77 },
        "agent:main:other": { sessionId: "sess-2", updatedAt: 88 },
      },
      "updated-at",
    );

    await migrateSessionStoreToDirectory(storePath);
    const readdirSpy = vi.spyOn(fs, "readdirSync");

    expect(
      readSessionUpdatedAt({
        storePath,
        sessionKey: "AGENT:MAIN:OTHER",
      }),
    ).toBe(88);
    expect(readdirSpy).not.toHaveBeenCalled();
  });

  it("skips blocked prototype keys when loading directory stores", async () => {
    const storePath = await writeLegacyStore(
      {
        "agent:main:main": { sessionId: "sess-1", updatedAt: 10 },
      },
      "blocked-key",
    );

    await migrateSessionStoreToDirectory(storePath);
    const entriesDir = path.join(resolveSessionStoreDir(storePath), "entries");
    fs.writeFileSync(
      path.join(entriesDir, encodeDirectorySessionStoreKey("__proto__")),
      JSON.stringify({ sessionKey: "__proto__", entry: { sessionId: "evil", updatedAt: 99 } }),
      "utf-8",
    );

    const loaded = loadSessionStore(storePath);
    expect(loaded["agent:main:main"]?.sessionId).toBe("sess-1");
    expect(Object.getPrototypeOf(loaded)).not.toEqual({ sessionId: "evil", updatedAt: 99 });
    expect(Object.prototype.hasOwnProperty.call(loaded, "__proto__")).toBe(false);
  });

  it("rejects symlinked legacy stores during migration", async () => {
    if (process.platform === "win32") {
      return;
    }

    const dir = await makeCaseDir("legacy-symlink");
    const targetPath = path.join(dir, "target.json");
    const storePath = path.join(dir, "sessions.json");
    await fsPromises.writeFile(
      targetPath,
      JSON.stringify({ "agent:main:main": { sessionId: "sess-1", updatedAt: 10 } }),
      "utf-8",
    );
    await fsPromises.symlink(targetPath, storePath);

    await expect(migrateSessionStoreToDirectory(storePath)).resolves.toBe(false);
    expect(fs.existsSync(resolveSessionStoreStatePath(storePath))).toBe(false);
  });

  it("rejects writable directory stores before updating entries", async () => {
    if (process.platform === "win32") {
      return;
    }

    const storePath = await writeLegacyStore(
      {
        "agent:main:main": { sessionId: "sess-1", updatedAt: 10 },
      },
      "unsafe-dir",
    );

    await migrateSessionStoreToDirectory(storePath);
    const entriesDir = path.join(resolveSessionStoreDir(storePath), "entries");
    await fsPromises.chmod(entriesDir, 0o777);

    await expect(
      updateSessionStoreEntry({
        storePath,
        sessionKey: "agent:main:main",
        update: async () => ({ thinkingLevel: "high" }),
      }),
    ).rejects.toThrow(/writable session-store directory/);
  });

  it("enforces maintenance when fast-path directory writes update an entry", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "365d",
          maxEntries: 1,
          rotateBytes: 10_485_760,
        },
      },
    });

    const storePath = await writeLegacyStore(
      {
        "agent:main:main": { sessionId: "sess-1", updatedAt: 10 },
        "agent:main:other": { sessionId: "sess-2", updatedAt: 20 },
      },
      "maintenance-fast-path",
    );

    await migrateSessionStoreToDirectory(storePath);
    await updateLastRoute({
      storePath,
      sessionKey: "agent:main:main",
      channel: "telegram",
      to: "12345",
    });

    expect(Object.keys(loadSessionStore(storePath))).toEqual(["agent:main:main"]);
  });

  it("ignores dotfiles and symlinked entry files when loading directory stores", async () => {
    if (process.platform === "win32") {
      return;
    }

    const storePath = await writeLegacyStore(
      {
        "agent:main:main": { sessionId: "sess-1", updatedAt: 10 },
      },
      "fs-hardening",
    );

    await migrateSessionStoreToDirectory(storePath);
    const entriesDir = path.join(resolveSessionStoreDir(storePath), "entries");
    const outsidePath = path.join(path.dirname(storePath), "outside.json");
    fs.writeFileSync(outsidePath, JSON.stringify({ sessionId: "bad", updatedAt: 999 }), "utf-8");
    fs.writeFileSync(
      path.join(entriesDir, ".hidden.json"),
      JSON.stringify({ sessionId: "hidden", updatedAt: 1 }),
      "utf-8",
    );
    fs.symlinkSync(
      outsidePath,
      path.join(entriesDir, encodeDirectorySessionStoreKey("agent:main:evil")),
      "file",
    );

    const loaded = loadSessionStore(storePath);
    expect(loaded["agent:main:main"]?.sessionId).toBe("sess-1");
    expect(loaded["agent:main:evil"]).toBeUndefined();
  });
});
