import { expect, it } from "vitest";
import { SESSION_ROW_DELTA_MAX_ENTRIES } from "../../packages/gateway-protocol/src/session-row-deltas.js";
import { ConnectionSessionRows } from "./session-ancestor-references.js";
import { readSessionEventRowRetention } from "./session-event-row-retention.js";
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

it("retains only handed-off vectors, separates ancestor admission, and restarts generations in full", () => {
  const owner = new ConnectionSessionRows();
  const before = readSessionEventRowRetention();
  const diff = createSessionRowDeltaDiffer();
  const first = row("agent:main:one", { label: "a".repeat(500), lastRunError: "old" });
  try {
    owner.prepareRows([first], diff);
    expect(readSessionEventRowRetention()).toEqual(before);
    owner.prepareRows([first], diff).delivered();
    owner.clearAncestors();
    const changed = owner.prepareRows([row(first.key, { label: first.label, updatedAt: 2 })], diff);
    expect(changed.wire[0]).toMatchObject({
      base: 1,
      version: 2,
      set: { updatedAt: 2 },
      remove: ["lastRunError"],
    });
    changed.delivered();
    expect(
      owner.prepareRows([row(first.key, { sessionId: "replacement" })], diff).wire[0],
    ).toHaveProperty("full");
    owner.clear();
    expect(owner.prepareRows([first], diff).wire[0]).toMatchObject({ version: 3, full: first });
  } finally {
    owner.clear();
  }
  expect(readSessionEventRowRetention()).toEqual(before);
});

it("evicts by handed-off row order and bounds 25 fully populated connections", () => {
  const before = readSessionEventRowRetention();
  const owners = Array.from({ length: 25 }, () => new ConnectionSessionRows());
  const rows = Array.from({ length: SESSION_ROW_DELTA_MAX_ENTRIES }, (_, i) =>
    row(`agent:main:memory-${i}`, { label: "reusable".repeat(100) }),
  );
  const diff = createSessionRowDeltaDiffer();
  try {
    for (const owner of owners) {
      for (const value of rows) {
        owner.prepareRows([value], diff).delivered();
      }
    }
    const retained = readSessionEventRowRetention();
    expect(retained.entries - before.entries).toBe(25 * SESSION_ROW_DELTA_MAX_ENTRIES);
    expect(retained.bytes - before.bytes).toBeLessThanOrEqual(25 * 2 * 1024 * 1024);
    const owner = owners[0]!;
    owner.prepareRows([rows[0]!], diff).delivered();
    owner.prepareRows([row("agent:main:overflow")], diff).delivered();
    expect(owner.prepareRows([rows[0]!], diff).wire[0]).toHaveProperty("base");
    expect(owner.prepareRows([rows[1]!], diff).wire[0]).toHaveProperty("full");
  } finally {
    owners.forEach((owner) => owner.clear());
  }
  expect(readSessionEventRowRetention()).toEqual(before);
});

it("sends retain:false without disturbing the LRU when vectors exceed the byte cap", () => {
  const owner = new ConnectionSessionRows();
  const before = readSessionEventRowRetention();
  const diff = createSessionRowDeltaDiffer();
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
    expect(readSessionEventRowRetention().bytes - before.bytes).toBeLessThanOrEqual(
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
    owner.clear();
  }
  expect(readSessionEventRowRetention()).toEqual(before);
});
