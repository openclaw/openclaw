// Tests for EAGAIN retry in session-store reads (fix for #99994).
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore } from "./store-load.js";
import { clearSessionStoreCacheForTest } from "./store-writer-state.js";
import { useTempSessionsFixture, writeSessionStoreForTest } from "./test-helpers.js";

const fixture = useTempSessionsFixture("eagain-test-");

describe("loadSessionStore EAGAIN retry", () => {
  const origReadFileSync = fs.readFileSync;
  let readFileSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSessionStoreForTest(fixture.storePath(), {
      "agent:default:test": { sessionId: "test", updatedAt: Date.now() },
    });
    readFileSyncSpy = vi.spyOn(fs, "readFileSync");
  });

  afterEach(() => {
    readFileSyncSpy.mockRestore();
    clearSessionStoreCacheForTest();
  });

  it("retries readFileSync on EAGAIN and loads the store once the read succeeds", () => {
    let calls = 0;
    readFileSyncSpy.mockImplementation(((
      filePath: fs.PathOrFileDescriptor,
      encoding?: BufferEncoding,
    ) => {
      calls++;
      if (calls < 3) {
        const err = new Error(
          "Unknown system error -11: Unknown system error -11, read",
        ) as NodeJS.ErrnoException;
        err.code = "EAGAIN";
        err.errno = -11;
        throw err;
      }
      return origReadFileSync(filePath as string, encoding);
    }) as typeof fs.readFileSync);

    const store = loadSessionStore(fixture.storePath(), { skipCache: true });

    expect(calls).toBe(3);
    expect(store).toHaveProperty("agent:default:test");
  });

  it("returns an empty store after exhausting retries on persistent EAGAIN", () => {
    let calls = 0;
    readFileSyncSpy.mockImplementation(() => {
      calls++;
      const err = new Error(
        "Unknown system error -11: Unknown system error -11, read",
      ) as NodeJS.ErrnoException;
      err.code = "EAGAIN";
      err.errno = -11;
      throw err;
    });

    const store = loadSessionStore(fixture.storePath(), { skipCache: true });

    expect(calls).toBe(3);
    expect(store).toEqual({});
  });

  it("retries on transient empty reads from a race with file swap", () => {
    let calls = 0;
    readFileSyncSpy.mockImplementation(((
      filePath: fs.PathOrFileDescriptor,
      encoding?: BufferEncoding,
    ) => {
      calls++;
      if (calls < 3) {
        return "";
      }
      return origReadFileSync(filePath as string, encoding);
    }) as typeof fs.readFileSync);

    const store = loadSessionStore(fixture.storePath(), { skipCache: true });

    expect(calls).toBe(3);
    expect(store).toHaveProperty("agent:default:test");
  });

  it("loads the store on the first attempt when there is no error", () => {
    const store = loadSessionStore(fixture.storePath(), { skipCache: true });

    expect(store).toHaveProperty("agent:default:test");
    expect(readFileSyncSpy).toHaveBeenCalledTimes(1);
  });

  it("returns an empty store immediately for missing files (ENOENT) without retry waits", () => {
    let calls = 0;
    readFileSyncSpy.mockImplementation(() => {
      calls++;
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      err.errno = -2;
      throw err;
    });

    const store = loadSessionStore(fixture.storePath(), { skipCache: true });

    expect(calls).toBe(1);
    expect(store).toEqual({});
  });

  it("returns an empty store immediately for permission errors (EACCES) without retry waits", () => {
    let calls = 0;
    readFileSyncSpy.mockImplementation(() => {
      calls++;
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      err.errno = -13;
      throw err;
    });

    const store = loadSessionStore(fixture.storePath(), { skipCache: true });

    expect(calls).toBe(1);
    expect(store).toEqual({});
  });
});
