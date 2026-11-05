// Every partition stays below its persisted-value limit, including maximally escaped text.
import { describe, expect, it, vi } from "vitest";
import {
  MAX_PLUGIN_STATE_VALUE_BYTES,
  PLUGIN_STATE_NAMESPACE_MAX_BYTES,
} from "../../plugin-state/plugin-state-store.kernel.js";
import { serializePluginStoreJson } from "../../plugin-state/plugin-store-validation.js";
import { clawStoreRows, readStoredClaw, writeStoredClaw, type StoredClaw } from "./claw-store.js";
import { fullClaw, NOW, id } from "./claw-store.test-support.js";

// The claw namespace's rows, held in memory in place of the plugin-state store.
const storedRows = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../plugin-state/plugin-state-store.js", () => ({
  prepareCorePluginStateReplacement: () => ({
    entries: async () => [...storedRows].map(([key, value]) => ({ key, value })),
    replace: async (values: ReadonlyMap<string, unknown>) => {
      storedRows.clear();
      for (const [key, value] of values) {
        storedRows.set(key, structuredClone(value));
      }
    },
  }),
}));

// Serializes a row as the plugin-state store does, throwing past the value limit.
function storedBytes(value: unknown): number {
  const fail = (message: string) => new Error(message);
  const errors = { invalid: fail, limit: fail };
  const json = serializePluginStoreJson({
    value,
    label: "claw row",
    errors,
    maxBytes: MAX_PLUGIN_STATE_VALUE_BYTES,
  });
  return Buffer.byteLength(json);
}

describe("claw record size", () => {
  it.each(["\u0001".repeat(256), "界".repeat(256), "😀".repeat(128)])(
    "keeps full-capacity sections below value and namespace budgets for escaped and Unicode text",
    (text) => {
      const rows = clawStoreRows(fullClaw(text));
      for (const row of Object.values(rows)) {
        expect(storedBytes(row)).toBeLessThan(MAX_PLUGIN_STATE_VALUE_BYTES);
      }
      // The namespace owner can retain the complete snapshot within its resident byte budget.
      const residentBytes = Object.entries(rows).reduce(
        (sum, [key, row]) => sum + 128 + 2 * (key.length + JSON.stringify(row).length),
        0,
      );
      expect(residentBytes).toBeLessThan(PLUGIN_STATE_NAMESPACE_MAX_BYTES);
      expect(() => storedBytes(fullClaw(text))).toThrow();
    },
  );
});

describe("claw record rows", () => {
  const binding = { device_id: "browser-a", role: "operator", peer_key: "iroh:a", bound_at: NOW };
  const claw = (): StoredClaw => {
    const discovery = { owner_account_id: null, published_binding_seq: 0, mailbox_cursor: null };
    const base = { v: 1 as const, claw_id: id(1), hostname: null, authority: null, binding: null };
    return { ...base, discovery: { ...discovery, published_snapshot_seq: 0 } };
  };

  it("stores token bindings in their own row and reads them back with the record", async () => {
    storedRows.clear();
    await writeStoredClaw({ ...claw(), token_bindings: [binding] });
    expect(storedRows.get("current")).not.toHaveProperty("token_bindings");
    expect(storedRows.get("token-bindings")).toEqual({ v: 1, bindings: [binding] });
    expect((await readStoredClaw())?.token_bindings).toEqual([binding]);
  });

  it("keeps bindings saved inside an older record until the next write moves them out", async () => {
    storedRows.clear();
    storedRows.set("current", { ...claw(), token_bindings: [binding] });
    expect((await readStoredClaw())?.token_bindings).toEqual([binding]);
    storedRows.set("token-bindings", { v: 1, bindings: [] });
    expect((await readStoredClaw())?.token_bindings).toEqual([]);
  });
});
