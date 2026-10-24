import { expect, it } from "vitest";
import { SESSION_ROW_DELTA_MAX_ENTRIES } from "../../packages/gateway-protocol/src/session-row-deltas.js";
import { ConnectionSessionRows, prepareSessionAncestor } from "./session-ancestor-references.js";
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
    owner.prepareDelivery(first, undefined, undefined, diff);
    expect(await read()).toEqual(before);
    owner.deliver(owner.prepareDelivery(first, undefined, undefined, diff));
    expect((await read()).entries - before.entries).toBe(1);
    owner.clearAncestors();
    const changed = owner.prepareDelivery(
      row(first.key, { label: first.label, updatedAt: 2 }),
      undefined,
      undefined,
      diff,
    );
    expect(changed.rows?.wire[0]).toMatchObject({
      base: 1,
      version: 2,
      set: { updatedAt: 2 },
      remove: ["lastRunError"],
    });
    expect(changed.rows?.encoded[0]).toBe(
      '{"key":"agent:main:one","agentId":"main","version":2,"base":1,"set":{"updatedAt":2},"remove":["lastRunError"]}',
    );
    owner.deliver(changed);
    const replacement = owner.prepareDelivery(
      row(first.key, { sessionId: "replacement" }),
      undefined,
      undefined,
      diff,
    );
    expect(replacement.rows?.wire[0]).toHaveProperty("full");
    await read();
    expect(resets).toEqual([]);
    owner.deliver(replacement);
    owner.clear("projection");
    expect(owner.prepareDelivery(first, undefined, undefined, diff).rows?.wire[0]).toMatchObject({
      version: 4,
      full: first,
    });
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
        connection.deliver(connection.prepareDelivery(value, undefined, undefined, diff));
      }
    }
    const retained = await read();
    expect(retained.entries - before.entries).toBe(25 * SESSION_ROW_DELTA_MAX_ENTRIES);
    expect(retained.estimatedBytes - before.estimatedBytes).toBeLessThanOrEqual(
      25 * 2 * 1024 * 1024,
    );
    owner.deliver(owner.prepareDelivery(rows[0]!, undefined, undefined, diff));
    owner.deliver(owner.prepareDelivery(row("agent:main:overflow"), undefined, undefined, diff));
    expect(
      owner.prepareDelivery(rows[0]!, undefined, undefined, diff).rows?.wire[0],
    ).toHaveProperty("base");
    expect(
      owner.prepareDelivery(rows[1]!, undefined, undefined, diff).rows?.wire[0],
    ).toHaveProperty("full");
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
      const delivery = owner.prepareDelivery(next, undefined, undefined, diff);
      owner.deliver(delivery);
      if ("retain" in delivery.rows!.wire[0]!) {
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
    expect(owner.prepareDelivery(rejected, undefined, undefined, diff).rows?.wire[0]).toMatchObject(
      {
        full: rejected,
        retain: false,
      },
    );
  } finally {
    await close();
  }
});

it("resends an unchanged ancestor after its socket row baseline is evicted", async () => {
  const { owner, diff, close } = await fixture();
  const parent = row("agent:main:parent", { snapshotAt: 1 });
  const child = row("agent:main:child");
  const prepared = [prepareSessionAncestor(parent)];
  const recoveryRevision = "00000000-0000-4000-8000-000000000001";
  try {
    const first = owner.prepareDelivery(child, prepared, undefined, diff);
    owner.deliver(first);
    expect(
      owner.prepareDelivery(child, prepared, undefined, diff).ancestor?.ancestorSessionRefs,
    ).toHaveLength(1);
    for (let index = 0; index < SESSION_ROW_DELTA_MAX_ENTRIES; index++) {
      owner.deliver(
        owner.prepareDelivery(row(`agent:main:leaf-${index}`), undefined, undefined, diff),
      );
    }
    const recovered = owner.prepareDelivery(child, prepared, recoveryRevision, diff);
    expect(recovered.ancestor?.ancestorSessions).toEqual([
      { ...parent, ancestorRevision: recoveryRevision },
    ]);
    expect(recovered.ancestor?.ancestorSessionRefs).toBeUndefined();
    owner.deliver(recovered);
    expect(
      owner.prepareDelivery(child, prepared, undefined, diff).ancestor?.ancestorSessionRefs,
    ).toHaveLength(1);
  } finally {
    await close();
  }
});
