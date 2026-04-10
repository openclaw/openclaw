// Octopus Orchestrator — PendingLog unit tests (M4-05)

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PendingLog, type PendingTransition } from "./pending-log.ts";

function makeTmpLog(): string {
  const dir = mkdtempSync(join(tmpdir(), "pending-log-test-"));
  return join(dir, "pending.jsonl");
}

function makeTransition(armId: string): Omit<PendingTransition, "id"> {
  return {
    arm_id: armId,
    event_type: "state_change",
    payload: { status: "running" },
    ts: Date.now(),
  };
}

describe("PendingLog", () => {
  const paths: string[] = [];

  function tracked(p: string): string {
    paths.push(p);
    return p;
  }

  afterEach(() => {
    for (const p of paths) {
      const dir = join(p, "..");
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    paths.length = 0;
  });

  it("append 5 transitions, replay returns 5", async () => {
    const log = new PendingLog(tracked(makeTmpLog()));

    for (let i = 0; i < 5; i++) {
      await log.append(makeTransition(`arm-${i}`));
    }

    const collected: PendingTransition[] = [];
    const count = await log.replay((t) => {
      collected.push(t);
    });

    expect(count).toBe(5);
    expect(collected).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(collected[i].arm_id).toBe(`arm-${i}`);
    }
  });

  it("ack 3 of 5, replay returns 2", async () => {
    const log = new PendingLog(tracked(makeTmpLog()));
    const ids: string[] = [];

    for (let i = 0; i < 5; i++) {
      const entry = await log.append(makeTransition(`arm-${i}`));
      ids.push(entry.id);
    }

    await log.ack(ids[0]);
    await log.ack(ids[2]);
    await log.ack(ids[4]);

    const remaining: PendingTransition[] = [];
    const count = await log.replay((t) => {
      remaining.push(t);
    });

    expect(count).toBe(2);
    expect(remaining.map((t) => t.arm_id)).toEqual(["arm-1", "arm-3"]);
  });

  it("clear empties the log", async () => {
    const log = new PendingLog(tracked(makeTmpLog()));

    await log.append(makeTransition("arm-a"));
    await log.append(makeTransition("arm-b"));
    await log.clear();

    const count = await log.replay(() => {});
    expect(count).toBe(0);
  });

  it("append to non-existent file creates it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pending-log-test-"));
    const deepPath = join(dir, "nested", "deep", "pending.jsonl");
    paths.push(deepPath);

    const log = new PendingLog(deepPath);
    const entry = await log.append(makeTransition("arm-x"));

    expect(entry.id).toBeDefined();
    expect(existsSync(deepPath)).toBe(true);
  });

  it("replay on empty file returns 0", async () => {
    const log = new PendingLog(tracked(makeTmpLog()));
    await log.clear(); // creates an empty file

    const count = await log.replay(() => {});
    expect(count).toBe(0);
  });

  it("IDs are unique across appends", async () => {
    const log = new PendingLog(tracked(makeTmpLog()));
    const ids = new Set<string>();

    for (let i = 0; i < 20; i++) {
      const entry = await log.append(makeTransition(`arm-${i}`));
      ids.add(entry.id);
    }

    expect(ids.size).toBe(20);
  });

  it("replay on missing file returns 0", async () => {
    const log = new PendingLog("/tmp/does-not-exist-pending-log-test.jsonl");
    const count = await log.replay(() => {});
    expect(count).toBe(0);
  });

  it("ack on missing file is a no-op", async () => {
    const log = new PendingLog("/tmp/does-not-exist-pending-log-test.jsonl");
    await expect(log.ack("nonexistent-id")).resolves.toBeUndefined();
  });
});
