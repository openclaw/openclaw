import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __testing_resolveActiveTurnsDir,
  clearActiveTurn,
  loadActiveTurnMarkers,
  removeActiveTurnMarker,
  writeActiveTurn,
} from "./active-turns.js";

function makeTempEnv(): { env: NodeJS.ProcessEnv; stateDir: string } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-scenario-"));
  return { env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv, stateDir };
}

describe("active-turns crash scenarios", () => {
  let cleanup: string | undefined;

  afterEach(() => {
    if (cleanup) {
      fs.rmSync(cleanup, { recursive: true, force: true });
    }
  });

  it("Scenario 1: gateway crash mid-turn — marker survives", async () => {
    const { env, stateDir } = makeTempEnv();
    cleanup = stateDir;

    // Simulate: agent starts processing a turn.
    writeActiveTurn("crash-sess-1", "agent:main:telegram:dm:123", env);
    await new Promise((r) => setTimeout(r, 200));

    // Simulate: process crashes (clearActiveTurn never called).
    // On next startup, marker should still be on disk.
    const markers = await loadActiveTurnMarkers(env);
    expect(markers.length).toBe(1);
    expect(markers[0].sessionId).toBe("crash-sess-1");
    expect(markers[0].sessionKey).toBe("agent:main:telegram:dm:123");
  });

  it("Scenario 2: clean completion — marker removed", async () => {
    const { env, stateDir } = makeTempEnv();
    cleanup = stateDir;

    writeActiveTurn("clean-sess", "key-clean", env);
    await new Promise((r) => setTimeout(r, 200));

    // Simulate: response delivered, run completes normally.
    clearActiveTurn("clean-sess", env);
    await new Promise((r) => setTimeout(r, 200));

    const markers = await loadActiveTurnMarkers(env);
    expect(markers.length).toBe(0);
  });

  it("Scenario 3: multiple concurrent turns — one crashes, others complete", async () => {
    const { env, stateDir } = makeTempEnv();
    cleanup = stateDir;

    writeActiveTurn("turn-a", "key-a", env);
    writeActiveTurn("turn-b", "key-b", env);
    writeActiveTurn("turn-c", "key-c", env);
    await new Promise((r) => setTimeout(r, 200));

    // turn-b completes normally.
    clearActiveTurn("turn-b", env);
    await new Promise((r) => setTimeout(r, 200));

    // Simulate crash: turn-a and turn-c still pending.
    const markers = await loadActiveTurnMarkers(env);
    expect(markers.length).toBe(2);
    const ids = markers.map((m) => m.sessionId).toSorted();
    expect(ids).toEqual(["turn-a", "turn-c"]);
  });

  it("Scenario 4: recovery consume-then-process — marker cleared before delivery", async () => {
    const { env, stateDir } = makeTempEnv();
    cleanup = stateDir;

    writeActiveTurn("recover-1", "key-r1", env);
    writeActiveTurn("recover-2", "key-r2", env);
    await new Promise((r) => setTimeout(r, 200));

    // Simulate recovery: consume markers first (like recoverInterruptedTurns).
    const markers = await loadActiveTurnMarkers(env);
    for (const marker of markers) {
      await removeActiveTurnMarker(marker.sessionId, env);
    }

    // All markers cleared even before "delivery" attempt.
    const remaining = await loadActiveTurnMarkers(env);
    expect(remaining.length).toBe(0);
  });

  it("Scenario 5: crash during recovery — markers already consumed won't re-send", async () => {
    const { env, stateDir } = makeTempEnv();
    cleanup = stateDir;

    writeActiveTurn("rr-1", "key-rr1", env);
    writeActiveTurn("rr-2", "key-rr2", env);
    await new Promise((r) => setTimeout(r, 200));

    // First recovery pass: consume rr-1.
    await loadActiveTurnMarkers(env);
    await removeActiveTurnMarker("rr-1", env);
    // Simulate: crash during rr-2 delivery.

    // Second recovery pass after second restart.
    const markers2 = await loadActiveTurnMarkers(env);
    expect(markers2.length).toBe(1);
    expect(markers2[0].sessionId).toBe("rr-2");
    // rr-1 was already consumed — not re-processed.
  });

  it("Scenario 6: run replaced (same sessionId, new handle) — marker updated", async () => {
    const { env, stateDir } = makeTempEnv();
    cleanup = stateDir;

    writeActiveTurn("replace-sess", "key-old", env);
    await new Promise((r) => setTimeout(r, 200));

    // Same sessionId, different sessionKey (run replaced).
    writeActiveTurn("replace-sess", "key-new", env);
    await new Promise((r) => setTimeout(r, 200));

    const markers = await loadActiveTurnMarkers(env);
    expect(markers.length).toBe(1);
    expect(markers[0].sessionKey).toBe("key-new");
  });

  it("Scenario 7: rapid write-clear cycle — no stale marker left", async () => {
    const { env, stateDir } = makeTempEnv();
    cleanup = stateDir;

    // Rapid fire: write and clear quickly.
    for (let i = 0; i < 10; i++) {
      writeActiveTurn(`rapid-${i}`, `key-${i}`, env);
    }
    await new Promise((r) => setTimeout(r, 300));

    for (let i = 0; i < 10; i++) {
      clearActiveTurn(`rapid-${i}`, env);
    }
    await new Promise((r) => setTimeout(r, 300));

    const markers = await loadActiveTurnMarkers(env);
    expect(markers.length).toBe(0);
  });

  it("Scenario 8: clear from old turn does not delete new turn marker", async () => {
    const { env, stateDir } = makeTempEnv();
    cleanup = stateDir;

    // Turn A starts.
    writeActiveTurn("sess-race", "key-A", env);
    await new Promise((r) => setTimeout(r, 200));

    // Turn A ends — clearActiveTurn fires (fire-and-forget).
    clearActiveTurn("sess-race", env);

    // Turn B starts immediately for the same session before clear runs.
    writeActiveTurn("sess-race", "key-B", env);
    await new Promise((r) => setTimeout(r, 400));

    // Turn B's marker should survive — not deleted by turn A's clear.
    const markers = await loadActiveTurnMarkers(env);
    expect(markers.length).toBe(1);
    expect(markers[0].sessionKey).toBe("key-B");
  });

  it("Scenario 9: marker file has valid JSON but missing fields", async () => {
    const { env, stateDir } = makeTempEnv();
    cleanup = stateDir;

    const dir = __testing_resolveActiveTurnsDir(env);
    fs.mkdirSync(dir, { recursive: true });
    // Valid JSON but missing sessionId.
    fs.writeFileSync(path.join(dir, "bad-fields.json"), JSON.stringify({ foo: "bar" }));
    writeActiveTurn("good-one", "key-good", env);
    await new Promise((r) => setTimeout(r, 200));

    const markers = await loadActiveTurnMarkers(env);
    // Only the valid marker should be returned.
    expect(markers.length).toBe(1);
    expect(markers[0].sessionId).toBe("good-one");
  });
});
