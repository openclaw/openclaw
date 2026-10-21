import { expect, it } from "vitest";
import { SESSION_ROW_DELTA_MAX_ENTRIES } from "../../packages/gateway-protocol/src/session-row-deltas.js";
import { ConnectionSessionRows } from "./session-ancestor-references.js";
import { observeSessionEventRowRetention } from "./session-event-row-retention.test-support.js";
import { createSessionRowDeltaDiffer } from "./session-row-delta-fields.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

function row(key: string, extra: Record<string, unknown> = {}): GatewaySessionRow {
  return Object.freeze({
    key,
    sessionId: key,
    agentId: "main",
    kind: "direct",
    updatedAt: 1,
    ...extra,
  });
}

async function fixture(connectionCount = 1) {
  const resets: Array<{ cause: string; count: number }> = [];
  const read = observeSessionEventRowRetention(({ cause, count }) => resets.push({ cause, count }));
  const owners = Array.from({ length: connectionCount }, () => new ConnectionSessionRows());
  const owner = owners[0]!;
  owner.clear();
  const before = await read();
  const diff = createSessionRowDeltaDiffer();
  const close = async () => {
    owners.forEach((value) => value.clear());
    expect(await read()).toEqual(before);
  };
  return { owner, owners, resets, read, before, diff, close };
}

it("retains only handed-off vectors, separates ancestor admission, and restarts generations in full", async () => {
  const { owner, resets, read, before, diff, close } = await fixture();
  const first = row("agent:main:one", { label: "a".repeat(500), lastRunError: "old" });
  try {
    owner.prepareRows([first], diff);
    expect(await read()).toEqual(before);
    owner.prepareRows([first], diff).delivered();
    expect((await read()).entries - before.entries).toBe(1);
    owner.clearAncestors();
    const changed = owner.prepareRows([row(first.key, { label: first.label, updatedAt: 2 })], diff);
    expect(changed.wire[0]).toMatchObject({
      base: 1,
      version: 2,
      set: { updatedAt: 2 },
      remove: ["lastRunError"],
    });
    changed.delivered();
    const replacement = owner.prepareRows([row(first.key, { sessionId: "replacement" })], diff);
    expect(replacement.wire[0]).toHaveProperty("full");
    await read();
    expect(resets).toEqual([]);
    replacement.delivered();
    owner.clear("projection");
    expect(owner.prepareRows([first], diff).wire[0]).toMatchObject({ version: 4, full: first });
  } finally {
    await close();
  }
  expect(resets).toEqual([
    { cause: "generation", count: 1 },
    { cause: "projection", count: 1 },
  ]);
});

it("evicts by handed-off row order and bounds 25 fully populated connections", async () => {
  const { owner, owners, resets, read, before, diff, close } = await fixture(25);
  const rows = Array.from({ length: SESSION_ROW_DELTA_MAX_ENTRIES }, (_, i) =>
    row(`agent:main:memory-${i}`, { label: "reusable".repeat(100) }),
  );
  try {
    for (const connection of owners) {
      for (const value of rows) {
        connection.prepareRows([value], diff).delivered();
      }
    }
    const retained = await read();
    expect(retained.entries - before.entries).toBe(25 * SESSION_ROW_DELTA_MAX_ENTRIES);
    expect(retained.estimatedBytes - before.estimatedBytes).toBeLessThanOrEqual(
      25 * 2 * 1024 * 1024,
    );
    owner.prepareRows([rows[0]!], diff).delivered();
    owner.prepareRows([row("agent:main:overflow")], diff).delivered();
    expect(owner.prepareRows([rows[0]!], diff).wire[0]).toHaveProperty("base");
    expect(owner.prepareRows([rows[1]!], diff).wire[0]).toHaveProperty("full");
    await read();
    expect(resets).toEqual([{ cause: "evicted", count: 1 }]);
  } finally {
    await close();
  }
  expect(resets).toEqual([
    { cause: "evicted", count: 1 },
    { cause: "close", count: 25 * SESSION_ROW_DELTA_MAX_ENTRIES },
  ]);
});

it("sends retain:false without disturbing the LRU when vectors exceed the byte cap", async () => {
  const { owner, read, before, diff, close } = await fixture();
  const wide = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`field${i}`, i]));
  let rejected: GatewaySessionRow | undefined;
  try {
    for (let i = 0; i < SESSION_ROW_DELTA_MAX_ENTRIES; i++) {
      const next = row(`agent:main:wide-${i}`, wide);
      const delivery = owner.prepareRows([next], diff);
      delivery.delivered();
      if ("retain" in delivery.wire[0]!) {
        rejected = next;
        break;
      }
    }
    expect(rejected).toBeDefined();
    expect((await read()).estimatedBytes - before.estimatedBytes).toBeLessThanOrEqual(
      2 * 1024 * 1024,
    );
    if (!rejected) {
      throw new Error("Expected the vector byte limit");
    }
    expect(owner.prepareRows([rejected], diff).wire[0]).toMatchObject({
      full: rejected,
      retain: false,
    });
  } finally {
    await close();
  }
});
