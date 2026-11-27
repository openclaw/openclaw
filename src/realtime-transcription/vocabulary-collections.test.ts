import { describe, expect, it, vi } from "vitest";
import type { PluginStateKeyedStore } from "../plugin-state/plugin-state-store.types.js";
import { VocabularyCollections, VocabularyCollectionWriteError } from "./vocabulary-collections.js";
import type {
  VocabularyAuthority,
  VocabularyCollection,
  VocabularyGrant,
  VocabularyOperation,
} from "./vocabulary-types.js";

const draft = (canonical = "SyntheticQuokka") => ({
  schemaVersion: 1,
  label: "Synthetic team",
  terms: [{ id: "term-one", canonical, aliases: [], locales: [], enabled: true }],
});

type Store = Pick<
  PluginStateKeyedStore<VocabularyCollection, 2>,
  "observe" | "compareAndApply" | "entriesInKeyRange"
>;

/** Fixed external I/O fixture: tests service policy/CAS use, not SQLite durability or host ACLs. */
function fixture() {
  const rows = new Map<string, VocabularyCollection>();
  const versions = new Map<string, number>();
  const allowed = new Set<VocabularyOperation>(["read", "edit", "manage", "export", "disclose"]);
  const membership = new Set(["scope-a"]);
  let connected = true;
  let clock = 1_000;
  let nextId = 0;
  let afterWrite: (() => void) | undefined;
  const assertAllowed = (scopeId: string, operation: VocabularyOperation) => {
    if (!connected || !membership.has(scopeId) || !allowed.has(operation)) {
      throw new Error("private denial detail must not escape");
    }
  };
  const authority: VocabularyAuthority = {
    async authorize({ scopeId, operation }) {
      assertAllowed(scopeId, operation);
      return {
        actorId: "person-one",
        expiresAt: 2_000,
        assertCurrent: () => assertAllowed(scopeId, operation),
        revalidate: async () => assertAllowed(scopeId, operation),
        onInvalidated: () => () => {},
      };
    },
  };
  const openStore = vi.fn((grant: VocabularyGrant): Store => ({
    async observe(key) {
      grant.assertCurrent();
      return { value: structuredClone(rows.get(key)), comparison: String(versions.get(key) ?? 0) };
    },
    async compareAndApply(key, comparison, intent) {
      grant.assertCurrent();
      if (comparison !== String(versions.get(key) ?? 0)) {
        return {
          status: "conflict",
          current: {
            value: structuredClone(rows.get(key)),
            comparison: String(versions.get(key) ?? 0),
          },
        };
      }
      if (intent.action !== "set") {
        throw new Error("unexpected write shape");
      }
      rows.set(key, structuredClone(intent.value));
      versions.set(key, (versions.get(key) ?? 0) + 1);
      afterWrite?.();
      return { status: "applied" };
    },
    async entriesInKeyRange(range) {
      grant.assertCurrent();
      return [...rows]
        .filter(([key]) => key >= range.keyStartInclusive && key < range.keyEndExclusive)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, range.limit)
        .map(([key, value]) => ({ key, value: structuredClone(value), createdAt: 1_000 }));
    },
  }));
  const options = { authority, openStore, now: () => clock, id: () => `collection-${++nextId}` };
  return {
    service: new VocabularyCollections(options),
    rows,
    allowed,
    membership,
    openStore,
    disconnect: () => {
      connected = false;
    },
    reconnect: () => {
      connected = true;
    },
    advance: () => {
      clock = 2_000;
    },
    afterWrite: (action: () => void) => {
      afterWrite = action;
    },
  };
}

describe("shared vocabulary collection management", () => {
  it("fails closed without scope authority and never opens storage", async () => {
    const f = fixture();
    const service = new VocabularyCollections({ openStore: f.openStore });
    await expect(service.create("scope-a", draft())).rejects.toMatchObject({ code: "unavailable" });
    await expect(service.read({ scopeId: "scope-a", collectionId: "guessed" })).rejects.toThrow(
      "Vocabulary unavailable",
    );
    expect(f.openStore).not.toHaveBeenCalled();
  });

  it("denies guessed other-workspace IDs, exports, lists, and absent IDs without disclosing metadata", async () => {
    const f = fixture();
    f.membership.add("scope-b");
    const secret = await f.service.create("scope-b", draft("OtherWorkspaceSynthetic"));
    f.membership.delete("scope-b");
    f.openStore.mockClear();
    for (const action of [
      () => f.service.read(secret),
      () => f.service.export(secret),
      () => f.service.list("scope-b"),
      () => f.service.delete(secret, 1),
    ]) {
      await expect(action()).rejects.toThrow("Vocabulary unavailable");
    }
    expect(f.openStore).not.toHaveBeenCalled();
    await expect(
      f.service.read({ scopeId: "scope-a", collectionId: secret.collectionId }),
    ).rejects.toThrow("Vocabulary unavailable");
  });

  it("separates export and audit permission, strips administrative data, and preserves unrelated rows", async () => {
    const f = fixture();
    f.membership.add("scope-b");
    const a = await f.service.create("scope-a", draft());
    const b = await f.service.create("scope-b", draft("Unchanged synthetic"));
    const saved = structuredClone(f.rows.get(`scope-b:${b.collectionId}`));
    const exported = JSON.parse(await f.service.export(a));
    expect(Object.keys(exported).toSorted()).toEqual(["label", "schemaVersion", "terms"]);
    expect(await f.service.read(a)).not.toHaveProperty("audit");
    expect((await f.service.readAuthorized(a)).collection.audit).toEqual([]);
    f.allowed.delete("export");
    await expect(f.service.export(a)).rejects.toMatchObject({ code: "unavailable" });
    f.allowed.delete("manage");
    await expect(f.service.audit(a)).rejects.toMatchObject({ code: "unavailable" });
    await f.service.replace(a, 1, draft("Updated synthetic"));
    expect(f.rows.get(`scope-b:${b.collectionId}`)).toEqual(saved);
  });

  it("does not let edit permission expose revisions when read access is absent", async () => {
    const f = fixture();
    const ref = await f.service.create("scope-a", draft());
    f.allowed.delete("read");
    await expect(f.service.replace(ref, 99, draft())).rejects.toThrow("Vocabulary unavailable");
    await expect(f.service.create("scope-a", draft())).rejects.toThrow("Vocabulary unavailable");
    expect(f.rows.get(`scope-a:${ref.collectionId}`)?.revision).toBe(1);
    expect(f.rows.size).toBe(1);
  });

  it("captures editable input before authorization yields and keeps public snapshots immutable", async () => {
    const f = fixture();
    const input = draft();
    const pending = f.service.create("scope-a", input);
    input.terms[0]!.canonical = "Changed while authorization waits";
    const row = await pending;
    expect(row.terms[0]?.canonical).toBe("SyntheticQuokka");
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.terms)).toBe(true);
    expect(Object.isFrozen(row.terms[0])).toBe(true);
  });

  it("validates tombstone scope and version before listing or accepting stale writes", async () => {
    const f = fixture();
    const ref = await f.service.create("scope-a", draft());
    await f.service.delete(ref, 1);
    const tombstone = f.rows.get(`scope-a:${ref.collectionId}`)!;
    Object.defineProperty(tombstone, "scopeId", { value: "scope-b", configurable: true });
    await expect(f.service.list("scope-a")).rejects.toThrow("Vocabulary unavailable");
    Object.defineProperty(tombstone, "scopeId", { value: "scope-a", configurable: true });
    Object.defineProperty(tombstone, "schemaVersion", { value: 99, configurable: true });
    await expect(f.service.list("scope-a")).rejects.toMatchObject({ code: "unsupported-version" });
    await expect(f.service.replace(ref, 2, draft())).rejects.toMatchObject({
      code: "unsupported-version",
    });
    expect(tombstone.revision).toBe(2);
  });

  it("reauthorizes reconnects, rejects expired grants, and leaves unknown schema bytes untouched", async () => {
    const f = fixture();
    const ref = await f.service.create("scope-a", draft());
    f.disconnect();
    await expect(f.service.read(ref)).rejects.toMatchObject({ code: "unavailable" });
    f.reconnect();
    await expect(f.service.read(ref)).resolves.toMatchObject({ revision: 1 });
    const stored = f.rows.get(`scope-a:${ref.collectionId}`)!;
    Object.defineProperty(stored, "schemaVersion", { value: 99, configurable: true });
    await expect(f.service.read(ref)).rejects.toMatchObject({ code: "unsupported-version" });
    expect(stored.schemaVersion).toBe(99);
    f.advance();
    await expect(f.service.read(ref)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("retains committed and unknown write outcomes without automatically replaying", async () => {
    const f = fixture();
    const original = await f.service.create("scope-a", draft());
    f.afterWrite(() => f.disconnect());
    await expect(f.service.replace(original, 1, draft("Committed synthetic"))).rejects.toEqual(
      expect.objectContaining({ outcome: "committed", code: "unavailable" }),
    );
    expect(f.rows.get(`scope-a:${original.collectionId}`)?.revision).toBe(2);
    f.reconnect();
    f.afterWrite(() => {
      throw new Error("lost reply with private content");
    });
    const result = f.service.replace(original, 2, draft("Uncertain synthetic"));
    await expect(result).rejects.toBeInstanceOf(VocabularyCollectionWriteError);
    await expect(result).rejects.toMatchObject({ outcome: "unknown", code: "outcome-unknown" });
    expect(f.rows.get(`scope-a:${original.collectionId}`)?.revision).toBe(3);
  });
});
