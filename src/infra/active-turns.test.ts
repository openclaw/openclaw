import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __testing_resolveActiveTurnsDir,
  clearActiveTurn,
  loadActiveTurnMarkers,
  removeActiveTurnMarker,
  writeActiveTurn,
} from "./active-turns.js";

function makeTempEnv(): { env: NodeJS.ProcessEnv; stateDir: string } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "active-turns-test-"));
  return { env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv, stateDir };
}

describe("active-turns", () => {
  let cleanup: string | undefined;

  beforeEach(() => {
    cleanup = undefined;
  });

  afterEach(() => {
    if (cleanup) {
      fs.rmSync(cleanup, { recursive: true, force: true });
    }
  });

  it("writeActiveTurn creates a marker file", async () => {
    const { env, stateDir } = makeTempEnv();
    cleanup = stateDir;

    writeActiveTurn("sess-1", "agent:main:telegram:dm:123", env);
    // Wait for fire-and-forget async write to complete.
    await new Promise((r) => setTimeout(r, 200));

    const dir = __testing_resolveActiveTurnsDir(env);
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toBe("sess-1.json");

    const content = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf-8"));
    expect(content.sessionId).toBe("sess-1");
    expect(content.sessionKey).toBe("agent:main:telegram:dm:123");
    expect(typeof content.startedAt).toBe("number");
  });

  it("clearActiveTurn removes the marker file", async () => {
    const { env, stateDir } = makeTempEnv();
    cleanup = stateDir;

    writeActiveTurn("sess-2", "key-2", env);
    await new Promise((r) => setTimeout(r, 200));

    const dir = __testing_resolveActiveTurnsDir(env);
    expect(fs.readdirSync(dir).length).toBe(1);

    clearActiveTurn("sess-2", env);
    await new Promise((r) => setTimeout(r, 200));

    expect(fs.readdirSync(dir).length).toBe(0);
  });

  it("clearActiveTurn does not throw for missing files", async () => {
    const { env, stateDir } = makeTempEnv();
    cleanup = stateDir;

    // Should not throw.
    clearActiveTurn("nonexistent", env);
    await new Promise((r) => setTimeout(r, 100));
  });

  it("loadActiveTurnMarkers returns all valid markers", async () => {
    const { env, stateDir } = makeTempEnv();
    cleanup = stateDir;

    writeActiveTurn("s1", "key-1", env);
    writeActiveTurn("s2", "key-2", env);
    await new Promise((r) => setTimeout(r, 200));

    const markers = await loadActiveTurnMarkers(env);
    expect(markers.length).toBe(2);
    const ids = markers.map((m) => m.sessionId).toSorted();
    expect(ids).toEqual(["s1", "s2"]);
  });

  it("loadActiveTurnMarkers returns empty array when dir does not exist", async () => {
    const env = { OPENCLAW_STATE_DIR: "/tmp/nonexistent-dir-12345" } as NodeJS.ProcessEnv;
    const markers = await loadActiveTurnMarkers(env);
    expect(markers).toEqual([]);
  });

  it("loadActiveTurnMarkers skips corrupt files", async () => {
    const { env, stateDir } = makeTempEnv();
    cleanup = stateDir;

    const dir = __testing_resolveActiveTurnsDir(env);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bad.json"), "not-json{{{");
    writeActiveTurn("good", "key-good", env);
    await new Promise((r) => setTimeout(r, 200));

    const markers = await loadActiveTurnMarkers(env);
    expect(markers.length).toBe(1);
    expect(markers[0].sessionId).toBe("good");
  });

  it("writeActiveTurn skips probe sessions", async () => {
    const { env, stateDir } = makeTempEnv();
    cleanup = stateDir;

    writeActiveTurn("probe-health", "probe-key", env);
    await new Promise((r) => setTimeout(r, 200));

    const dir = __testing_resolveActiveTurnsDir(env);
    const exists = fs.existsSync(dir);
    if (exists) {
      expect(fs.readdirSync(dir).length).toBe(0);
    }
  });

  it("removeActiveTurnMarker removes a specific marker", async () => {
    const { env, stateDir } = makeTempEnv();
    cleanup = stateDir;

    writeActiveTurn("s1", "key-1", env);
    writeActiveTurn("s2", "key-2", env);
    await new Promise((r) => setTimeout(r, 200));

    await removeActiveTurnMarker("s1", env);

    const markers = await loadActiveTurnMarkers(env);
    expect(markers.length).toBe(1);
    expect(markers[0].sessionId).toBe("s2");
  });

  it("sanitizes sessionId with path separators", async () => {
    const { env, stateDir } = makeTempEnv();
    cleanup = stateDir;

    writeActiveTurn("a/b\\c:d", "key-path", env);
    await new Promise((r) => setTimeout(r, 200));

    const dir = __testing_resolveActiveTurnsDir(env);
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
    // Should not contain path separators in filename.
    expect(files[0]).not.toMatch(/[/\\:]/);
  });
});
