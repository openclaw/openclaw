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
  const prepare = (
    value: GatewaySessionRow,
    ancestors?: ReturnType<typeof prepareSessionAncestor>[],
    revision?: Parameters<ConnectionSessionRows["prepareDelivery"]>[2],
    connection = owner,
  ) => connection.prepareDelivery(value, ancestors, revision, diff);
  const deliver = (value: GatewaySessionRow, connection = owner) =>
    connection.deliver(prepare(value, undefined, undefined, connection));
  const close = async () => {
    owners.forEach((value) => value.clear());
    expect(await read()).toEqual(before);
  };
  return { owner, owners, resets, read, before, prepare, deliver, close };
}

it("retains only handed-off vectors, separates ancestor admission, and restarts generations in full", async () => {
  const { owner, resets, read, before, prepare, deliver, close } = await fixture();
  const first = row("agent:main:one", { label: "a".repeat(500), lastRunError: "old" });
  try {
    prepare(first);
    expect(await read()).toEqual(before);
    deliver(first);
    expect((await read()).entries - before.entries).toBe(1);
    owner.clearAncestors();
    const changed = prepare(row(first.key, { label: first.label, updatedAt: 2 }));
    expect(changed.rows?.encoded[0]).toBe(
      '{"key":"agent:main:one","agentId":"main","version":2,"base":1,"set":{"updatedAt":2},"remove":["lastRunError"]}',
    );
    owner.deliver(changed);
    const replacement = prepare(row(first.key, { sessionId: "replacement" }));
    expect(replacement.rows?.wire[0]).toHaveProperty("full");
    await read();
    expect(resets).toEqual([]);
    owner.deliver(replacement);
    owner.clear("projection");
    expect(prepare(first).rows?.wire[0]).toMatchObject({
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
  const { owners, resets, read, before, prepare, deliver, close } = await fixture(25);
  const rows = Array.from({ length: SESSION_ROW_DELTA_MAX_ENTRIES }, (_, i) =>
    row(`agent:main:memory-${i}`, { label: "reusable".repeat(100) }),
  );
  try {
    for (const connection of owners) {
      for (const value of rows) {
        deliver(value, connection);
      }
    }
    const retained = await read();
    expect(retained.entries - before.entries).toBe(25 * SESSION_ROW_DELTA_MAX_ENTRIES);
    expect(retained.estimatedBytes - before.estimatedBytes).toBeLessThanOrEqual(
      25 * 2 * 1024 * 1024,
    );
    deliver(rows[0]!);
    deliver(row("agent:main:overflow"));
    expect(prepare(rows[0]!).rows?.wire[0]).toHaveProperty("base");
    expect(prepare(rows[1]!).rows?.wire[0]).toHaveProperty("full");
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
  const { owner, read, before, prepare, close } = await fixture();
  const wide = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`field${i}`, i]));
  let rejected: GatewaySessionRow | undefined;
  try {
    for (let i = 0; i < SESSION_ROW_DELTA_MAX_ENTRIES; i++) {
      const next = row(`agent:main:wide-${i}`, wide);
      const delivery = prepare(next);
      owner.deliver(delivery);
      if ("retain" in delivery.rows!.wire[0]!) {
        rejected = next;
        break;
      }
    }
    expect((await read()).estimatedBytes - before.estimatedBytes).toBeLessThanOrEqual(
      2 * 1024 * 1024,
    );
    if (!rejected) {
      throw new Error("Expected the vector byte limit");
    }
    expect(prepare(rejected).rows?.wire[0]).toMatchObject({ full: rejected, retain: false });
  } finally {
    await close();
  }
});

it("resends an unchanged ancestor after its socket row baseline is evicted", async () => {
  const { owner, prepare, deliver, close } = await fixture();
  const parent = row("agent:main:parent", { snapshotAt: 1 });
  const child = row("agent:main:child");
  const prepared = [prepareSessionAncestor(parent)];
  const recoveryRevision = "00000000-0000-4000-8000-000000000001";
  try {
    const first = prepare(child, prepared);
    owner.deliver(first);
    expect(prepare(child, prepared).ancestor?.ancestorSessionRefs).toHaveLength(1);
    for (let index = 0; index < SESSION_ROW_DELTA_MAX_ENTRIES; index++) {
      deliver(row(`agent:main:leaf-${index}`));
    }
    const recovered = prepare(child, prepared, recoveryRevision);
    expect(recovered.ancestor?.ancestorSessions).toEqual([
      { ...parent, ancestorRevision: recoveryRevision },
    ]);
    expect(recovered.ancestor?.ancestorSessionRefs).toBeUndefined();
    owner.deliver(recovered);
    expect(prepare(child, prepared).ancestor?.ancestorSessionRefs).toHaveLength(1);
  } finally {
    await close();
  }
});
