// Covers identity-based restoration of redacted values inside config object
// arrays: removing, reordering, or inserting rows must restore each retained
// row's own redacted values (matched by stable `id`) instead of following array
// position. Arrays without a stable id keep positional restoration.
//
// The sensitive leaf is named `mark` here (marked sensitive purely through the
// authored hints) rather than a real credential key: sensitivity in restore is
// driven by the hint path, not the field name, so the identity logic is
// exercised identically while the fixtures carry no secret-shaped values. The
// real production path this protects is e.g. `agents.list[].memorySearch.remote.apiKey`.
import { describe, expect, it } from "vitest";
import type { ConfigUiHints } from "../shared/config-ui-hints-types.js";
import { createRedactedArrayOriginalResolver } from "./redact-snapshot.array-identity.js";
import { redactConfigObject, REDACTED_SENTINEL, restoreRedactedValues } from "./redact-snapshot.js";
import { buildConfigSchema } from "./schema.js";

const AGENT_MARK_HINTS = {
  "agents.list[].mark": { sensitive: true },
} as unknown as ConfigUiHints;

const NESTED_MARK_HINTS = {
  "agents.list[].telemetry.remote.mark": { sensitive: true },
} as unknown as ConfigUiHints;

type AgentEntry = { id?: string; mark?: unknown; label?: string };

function agentsConfig(list: AgentEntry[]): { agents: { list: AgentEntry[] } } {
  return { agents: { list } };
}

/** Builds the edited snapshot a client returns: the sensitive `mark` shown as the sentinel. */
function redactMarks(list: AgentEntry[]): AgentEntry[] {
  return list.map((entry) =>
    "mark" in entry ? { ...entry, mark: REDACTED_SENTINEL } : { ...entry },
  );
}

function restoreAgents(
  incoming: unknown,
  original: unknown,
  hints: ConfigUiHints = AGENT_MARK_HINTS,
) {
  return restoreRedactedValues(incoming, original, hints);
}

// Mirrors production: the original item's id as the client receives it.
const RAW_ID = (item: unknown): string | undefined => {
  const id = (item as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};
const resolverFor = (
  original: unknown[],
  incoming: unknown[],
  visibleIdOf: (item: unknown) => string | undefined = RAW_ID,
) => createRedactedArrayOriginalResolver(original, incoming, visibleIdOf);

describe("createRedactedArrayOriginalResolver", () => {
  it("is identity-keyed when every original item has a unique string id", () => {
    expect(resolverFor([{ id: "a" }, { id: "b" }], [{ id: "b" }]).identityKeyed).toBe(true);
  });

  it("is not identity-keyed when an item is missing an id", () => {
    expect(resolverFor([{ id: "a" }, { label: "x" }], []).identityKeyed).toBe(false);
  });

  it("is not identity-keyed when original ids are duplicated", () => {
    expect(resolverFor([{ id: "a" }, { id: "a" }], []).identityKeyed).toBe(false);
  });

  it("is not identity-keyed for empty, bare-string, or empty-id arrays", () => {
    expect(resolverFor([], []).identityKeyed).toBe(false);
    expect(resolverFor(["x", "y"], []).identityKeyed).toBe(false);
    expect(resolverFor([{ id: "" }], []).identityKeyed).toBe(false);
  });

  it("resolves a retained row to its own original after a delete, not by position", () => {
    const original = [{ id: "a" }, { id: "b" }];
    expect(resolverFor(original, [{ id: "b" }]).resolve({ id: "b" }, 0)).toBe(original[1]);
  });

  it("restores bare (whole-item redacted) rows positionally, not by identity", () => {
    // Items themselves sensitive -> incoming rows are bare sentinels with no id;
    // keep the pre-existing positional original so unchanged saves are not lost.
    const original = [{ id: "a" }, { id: "b" }];
    const resolver = resolverFor(original, [REDACTED_SENTINEL, REDACTED_SENTINEL]);
    expect(resolver.resolve(REDACTED_SENTINEL, 1)).toBe(original[1]);
  });

  it("stays positional when the id is redacted away", () => {
    // Id not client-visible -> identity cannot apply, so the array round-trips
    // positionally (unchanged saves are not rejected).
    const original = [{ id: "a" }, { id: "b" }];
    const resolver = resolverFor(
      original,
      [{ id: REDACTED_SENTINEL }, { id: REDACTED_SENTINEL }],
      () => REDACTED_SENTINEL,
    );
    expect(resolver.identityKeyed).toBe(false);
    expect(resolver.resolve({ id: REDACTED_SENTINEL }, 1)).toBe(original[1]);
  });

  it("keys on whatever visible id the redactor reports, not the stored id", () => {
    // Identity applies to the id the client actually receives; production
    // supplies that via the redactor (see the redact -> restore cases below).
    const original = [{ id: "a" }, { id: "b" }];
    const resolver = resolverFor(original, [{ id: "shown-b" }], (item) => `shown-${RAW_ID(item)}`);
    expect(resolver.identityKeyed).toBe(true);
    expect(resolver.resolve({ id: "shown-b" }, 0)).toBe(original[1]);
  });

  it("follows identity through a reorder", () => {
    const original = [{ id: "a" }, { id: "b" }];
    const resolver = resolverFor(original, [{ id: "b" }, { id: "a" }]);
    expect(resolver.resolve({ id: "b" }, 0)).toBe(original[1]);
    expect(resolver.resolve({ id: "a" }, 1)).toBe(original[0]);
  });

  it("resolves inserted, renamed, and duplicated ids to no original", () => {
    const original = [{ id: "a" }, { id: "b" }];
    const inserted = resolverFor(original, [{ id: "a" }, { id: "c" }, { id: "b" }]);
    expect(inserted.resolve({ id: "c" }, 1)).toBeUndefined();
    const renamed = resolverFor(original, [{ id: "a2" }, { id: "b" }]);
    expect(renamed.resolve({ id: "a2" }, 0)).toBeUndefined();
    const dup = resolverFor(original, [{ id: "a" }, { id: "a" }]);
    expect(dup.resolve({ id: "a" }, 0)).toBeUndefined();
  });

  it("falls back to positional resolution for non-identity arrays", () => {
    const original = ["x", "y"];
    expect(resolverFor(original, [REDACTED_SENTINEL]).resolve(REDACTED_SENTINEL, 0)).toBe("x");
  });
});

describe("restoreRedactedValues — identity-keyed object arrays", () => {
  const original = agentsConfig([
    { id: "alpha", mark: "mark-alpha" },
    { id: "bravo", mark: "mark-bravo" },
    { id: "charlie", mark: "mark-charlie" },
  ]);

  it("keeps each retained row's own value when the first row is deleted", () => {
    const incoming = agentsConfig(
      redactMarks([
        { id: "bravo", mark: undefined },
        { id: "charlie", mark: undefined },
      ]),
    );
    const res = restoreAgents(incoming, original);
    expect(res.ok).toBe(true);
    const list = (res.result as typeof original).agents.list;
    expect(list.map((a) => [a.id, a.mark])).toEqual([
      ["bravo", "mark-bravo"],
      ["charlie", "mark-charlie"],
    ]);
    // The deleted row's value must not survive on any retained row.
    expect(JSON.stringify(list)).not.toContain("mark-alpha");
  });

  it("keeps own values when a middle row is deleted", () => {
    const incoming = agentsConfig(
      redactMarks([
        { id: "alpha", mark: undefined },
        { id: "charlie", mark: undefined },
      ]),
    );
    const list = (restoreAgents(incoming, original).result as typeof original).agents.list;
    expect(list.map((a) => a.mark)).toEqual(["mark-alpha", "mark-charlie"]);
  });

  it("keeps own values when the last row is deleted", () => {
    const incoming = agentsConfig(
      redactMarks([
        { id: "alpha", mark: undefined },
        { id: "bravo", mark: undefined },
      ]),
    );
    const list = (restoreAgents(incoming, original).result as typeof original).agents.list;
    expect(list.map((a) => a.mark)).toEqual(["mark-alpha", "mark-bravo"]);
  });

  it("follows identity through a reorder", () => {
    const incoming = agentsConfig(
      redactMarks([
        { id: "charlie", mark: undefined },
        { id: "alpha", mark: undefined },
        { id: "bravo", mark: undefined },
      ]),
    );
    const list = (restoreAgents(incoming, original).result as typeof original).agents.list;
    expect(list.map((a) => [a.id, a.mark])).toEqual([
      ["charlie", "mark-charlie"],
      ["alpha", "mark-alpha"],
      ["bravo", "mark-bravo"],
    ]);
  });

  it("preserves an explicitly entered replacement value", () => {
    const incoming = agentsConfig([
      { id: "alpha", mark: "mark-rotated" },
      { id: "bravo", mark: REDACTED_SENTINEL },
      { id: "charlie", mark: REDACTED_SENTINEL },
    ]);
    const list = (restoreAgents(incoming, original).result as typeof original).agents.list;
    expect(list.map((a) => a.mark)).toEqual(["mark-rotated", "mark-bravo", "mark-charlie"]);
  });

  it("restores an inserted row's real value and leaves existing rows intact", () => {
    const incoming = agentsConfig([
      { id: "alpha", mark: REDACTED_SENTINEL },
      { id: "delta", mark: "mark-delta" },
      { id: "bravo", mark: REDACTED_SENTINEL },
      { id: "charlie", mark: REDACTED_SENTINEL },
    ]);
    const list = (restoreAgents(incoming, original).result as typeof original).agents.list;
    expect(list.map((a) => [a.id, a.mark])).toEqual([
      ["alpha", "mark-alpha"],
      ["delta", "mark-delta"],
      ["bravo", "mark-bravo"],
      ["charlie", "mark-charlie"],
    ]);
  });

  it("restores multiple redacted fields on the same identity", () => {
    const multiOriginal = {
      agents: {
        list: [
          { id: "alpha", mark: "mark-alpha", note: "note-alpha" },
          { id: "bravo", mark: "mark-bravo", note: "note-bravo" },
        ],
      },
    };
    const hints = {
      "agents.list[].mark": { sensitive: true },
      "agents.list[].note": { sensitive: true },
    } as unknown as ConfigUiHints;
    const incoming = {
      agents: { list: [{ id: "bravo", mark: REDACTED_SENTINEL, note: REDACTED_SENTINEL }] },
    };
    const res = restoreRedactedValues(incoming, multiOriginal, hints);
    expect(res.ok).toBe(true);
    expect((res.result as typeof multiOriginal).agents.list[0]).toEqual({
      id: "bravo",
      mark: "mark-bravo",
      note: "note-bravo",
    });
  });

  it("restores a deeply nested sensitive field by identity after a delete", () => {
    // Mirrors the real production path agents.list[].memorySearch.remote.apiKey.
    const deepOriginal = {
      agents: {
        list: [
          { id: "alpha", telemetry: { remote: { mark: "deep-alpha" } } },
          { id: "bravo", telemetry: { remote: { mark: "deep-bravo" } } },
        ],
      },
    };
    const incoming = {
      agents: { list: [{ id: "bravo", telemetry: { remote: { mark: REDACTED_SENTINEL } } }] },
    };
    const res = restoreRedactedValues(incoming, deepOriginal, NESTED_MARK_HINTS);
    expect(res.ok).toBe(true);
    const list = (res.result as typeof deepOriginal).agents.list;
    expect(list[0]?.telemetry.remote.mark).toBe("deep-bravo");
    expect(JSON.stringify(list)).not.toContain("deep-alpha");
  });
});

describe("restoreRedactedValues — identity-keyed fail-closed edges", () => {
  const original = agentsConfig([
    { id: "alpha", mark: "mark-alpha" },
    { id: "bravo", mark: "mark-bravo" },
  ]);

  it("fails closed when a renamed row still shows a redacted value", () => {
    const incoming = agentsConfig([
      { id: "alpha-renamed", mark: REDACTED_SENTINEL },
      { id: "bravo", mark: REDACTED_SENTINEL },
    ]);
    const res = restoreAgents(incoming, original);
    expect(res.ok).toBe(false);
    // The failure surfaces no restored value material.
    expect(JSON.stringify(res)).not.toContain("mark-alpha");
    expect(JSON.stringify(res)).not.toContain("mark-bravo");
  });

  it("fails closed on a duplicated id in the edited array", () => {
    const incoming = agentsConfig([
      { id: "alpha", mark: REDACTED_SENTINEL },
      { id: "alpha", mark: REDACTED_SENTINEL },
    ]);
    expect(restoreAgents(incoming, original).ok).toBe(false);
  });

  it("does not migrate a deleted row's value onto a renamed row", () => {
    const incoming = agentsConfig([{ id: "renamed", mark: REDACTED_SENTINEL }]);
    const res = restoreAgents(incoming, original);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain("mark-alpha");
  });

  it("fails closed when a retained row drops its id but keeps a redacted value", () => {
    // A client that does not round-trip `id` cannot be identity-matched; the
    // save is rejected rather than guessing which original the row is.
    const incoming = agentsConfig([
      { mark: REDACTED_SENTINEL },
      { id: "bravo", mark: "mark-bravo" },
    ]);
    const res = restoreAgents(incoming, original);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain("mark-alpha");
  });
});

describe("restoreRedactedValues — non-regression", () => {
  it("leaves an unchanged two-item array identical", () => {
    const original = agentsConfig([
      { id: "alpha", mark: "mark-alpha" },
      { id: "bravo", mark: "mark-bravo" },
    ]);
    const incoming = agentsConfig(redactMarks(original.agents.list));
    const res = restoreAgents(incoming, original);
    expect(res.ok).toBe(true);
    expect(res.result).toEqual(original);
  });

  it("keeps positional behavior for object arrays without a stable id", () => {
    // No `id` field -> not identity-keyed -> legacy positional restore.
    const original = {
      agents: {
        list: [
          { name: "one", mark: "mark-one" },
          { name: "two", mark: "mark-two" },
        ],
      },
    };
    const incoming = { agents: { list: [{ name: "two", mark: REDACTED_SENTINEL }] } };
    const res = restoreRedactedValues(incoming, original, AGENT_MARK_HINTS);
    expect(res.ok).toBe(true);
    // Legacy positional restore pulls index 0 (documents unchanged behavior).
    expect((res.result as typeof original).agents.list[0]?.mark).toBe("mark-one");
  });

  it("preserves env-var placeholders through restore unchanged", () => {
    const original = agentsConfig([
      { id: "alpha", mark: "${ALPHA_MARK}" },
      { id: "bravo", mark: "mark-bravo" },
    ]);
    // Env placeholders are never redacted, so the client returns them verbatim.
    const incoming = agentsConfig([
      { id: "bravo", mark: REDACTED_SENTINEL },
      { id: "alpha", mark: "${ALPHA_MARK}" },
    ]);
    const list = (restoreAgents(incoming, original).result as typeof original).agents.list;
    expect(list.map((a) => [a.id, a.mark])).toEqual([
      ["bravo", "mark-bravo"],
      ["alpha", "${ALPHA_MARK}"],
    ]);
  });

  it("round-trips an unchanged array whose id field is itself redaction-backed", () => {
    // Both `id` and `mark` sensitive: the edited snapshot masks each id, so
    // identity cannot apply; positional restore keeps the unchanged save working.
    const idAndMarkHints = {
      "agents.list[].id": { sensitive: true },
      "agents.list[].mark": { sensitive: true },
    } as unknown as ConfigUiHints;
    const original = agentsConfig([
      { id: "alpha", mark: "mark-alpha" },
      { id: "bravo", mark: "mark-bravo" },
    ]);
    const incoming = agentsConfig([
      { id: REDACTED_SENTINEL, mark: REDACTED_SENTINEL },
      { id: REDACTED_SENTINEL, mark: REDACTED_SENTINEL },
    ]);
    const res = restoreRedactedValues(incoming, original, idAndMarkHints);
    expect(res.ok).toBe(true);
    expect(res.result).toEqual(original);
  });

  // Restore must agree with what the real redactor actually emits, not with an
  // assumption about it. These drive redactConfigObject directly. In both hint
  // shapes the ids themselves redact away, so they prove unchanged saves keep
  // working via positional restore (identity coverage is the production-hints
  // case above, where ids stay visible).
  describe.each([
    ["explicit id hint", { "rows[].id": { sensitive: true }, "rows[].mark": { sensitive: true } }],
    ["wildcard hint", { "rows[].*": { sensitive: true } }],
  ])("redact -> restore agreement, ids redact away (%s)", (_label, hintSpec) => {
    it("round-trips an unchanged array", () => {
      const hints = hintSpec as unknown as ConfigUiHints;
      const original = {
        rows: [
          { id: "row-alpha", mark: "mark-alpha" },
          { id: "row-bravo", mark: "mark-bravo" },
        ],
      };
      const redacted = redactConfigObject(original, hints);
      const res = restoreRedactedValues(redacted, original, hints);
      expect(res.ok).toBe(true);
      expect(res.result).toEqual(original);
    });
  });

  it("keeps each agent's own secret on the real production schema hints", () => {
    // Highest-value symmetry case: real uiHints + real redactor, on the shipped
    // agents.list surface. Values are built indirectly so the fixture carries no
    // literal secret-shaped assignment.
    const hints = buildConfigSchema().uiHints;
    const secretFor = (id: string) => `value-for-${id}`;
    const original = {
      agents: {
        list: ["alpha", "bravo"].map((id) => ({
          id,
          memorySearch: { remote: { apiKey: secretFor(id) } },
        })),
      },
    };
    const redacted = redactConfigObject(original, hints) as typeof original;
    // Every entry must actually be redacted: the client never receives real
    // values, and the delete case below only proves identity restoration if the
    // retained entry was redacted too.
    expect(redacted.agents.list.map((a) => a.memorySearch.remote.apiKey)).toEqual([
      REDACTED_SENTINEL,
      REDACTED_SENTINEL,
    ]);
    // Unchanged round-trip is accepted and lossless.
    const unchanged = restoreRedactedValues(redacted, original, hints);
    expect(unchanged.ok).toBe(true);
    expect(unchanged.result).toEqual(original);
    // Deleting the first row must not move its value onto the retained row.
    const afterDelete = restoreRedactedValues(
      { agents: { list: [redacted.agents.list[1]] } },
      original,
      hints,
    );
    expect(afterDelete.ok).toBe(true);
    const list = (afterDelete.result as typeof original).agents.list;
    expect(list.map((a) => [a.id, a.memorySearch.remote.apiKey])).toEqual([
      ["bravo", secretFor("bravo")],
    ]);
    expect(JSON.stringify(list)).not.toContain(secretFor("alpha"));
  });

  it("degrades to positional when an explicitly-sensitive id is redacted, env placeholder included", () => {
    // A hinted-sensitive id is replaced even when it is an env placeholder (the
    // placeholder escape only covers the plain-string branch), so the ids are
    // not client-visible and the array must fall back to positional restore.
    const hints = {
      "rows[].id": { sensitive: true },
      "rows[].mark": { sensitive: true },
    } as unknown as ConfigUiHints;
    const original = {
      rows: [
        { id: "${ALPHA_ID}", mark: "mark-alpha" },
        { id: "${BRAVO_ID}", mark: "mark-bravo" },
      ],
    };
    const redacted = redactConfigObject(original, hints) as typeof original;
    expect(redacted.rows.map((r) => r.id)).toEqual([REDACTED_SENTINEL, REDACTED_SENTINEL]);
    // Unchanged round-trip still succeeds losslessly via positional restore.
    const res = restoreRedactedValues(redacted, original, hints);
    expect(res.ok).toBe(true);
    expect(res.result).toEqual(original);
  });

  it("keeps each hook mapping's own value on the real production schema hints", () => {
    // Second real trigger path for the resolver (hooks.mappings[] carries an id
    // and a redaction-backed descendant), locking that it gains no new semantics.
    const hints = buildConfigSchema().uiHints;
    const valueFor = (id: string) => `value-for-${id}`;
    const original = {
      hooks: { mappings: ["first", "second"].map((id) => ({ id, sessionKey: valueFor(id) })) },
    };
    const redacted = redactConfigObject(original, hints) as typeof original;
    // Every entry must actually be redacted, otherwise the delete case below
    // could pass without exercising identity-based restoration at all.
    expect(redacted.hooks.mappings.map((m) => m.sessionKey)).toEqual([
      REDACTED_SENTINEL,
      REDACTED_SENTINEL,
    ]);
    const unchanged = restoreRedactedValues(redacted, original, hints);
    expect(unchanged.ok).toBe(true);
    expect(unchanged.result).toEqual(original);
    // Removing the first entry leaves the retained entry with its own value.
    const afterDelete = restoreRedactedValues(
      { hooks: { mappings: [redacted.hooks.mappings[1]] } },
      original,
      hints,
    );
    expect(afterDelete.ok).toBe(true);
    const mappings = (afterDelete.result as typeof original).hooks.mappings;
    expect(mappings.map((m) => [m.id, m.sessionKey])).toEqual([["second", valueFor("second")]]);
    expect(JSON.stringify(mappings)).not.toContain(valueFor("first"));
  });

  it("keeps hook mappings positional when only some entries carry an id", () => {
    // hooks.mappings[].id is optional, so a real config can mix entries with and
    // without ids. That array is not identity-keyed and must keep the existing
    // positional behavior rather than matching partially.
    const hints = buildConfigSchema().uiHints;
    const valueFor = (id: string) => `value-for-${id}`;
    const original = {
      hooks: {
        mappings: [
          { id: "first", sessionKey: valueFor("first") },
          { sessionKey: valueFor("second") },
        ],
      },
    };
    const redacted = redactConfigObject(original, hints) as typeof original;
    expect(redacted.hooks.mappings.map((m) => m.sessionKey)).toEqual([
      REDACTED_SENTINEL,
      REDACTED_SENTINEL,
    ]);
    const res = restoreRedactedValues(redacted, original, hints);
    expect(res.ok).toBe(true);
    expect(res.result).toEqual(original);
  });

  it("round-trips an array whose name makes its id pattern-sensitive (ids redact away)", () => {
    // `secretStores[].id` matches SENSITIVE_PATTERNS via the path, so the
    // redactor hides the id even without an explicit hint; restore must agree.
    const hints = { "secretStores[].mark": { sensitive: true } } as unknown as ConfigUiHints;
    const original = {
      secretStores: [
        { id: "store-alpha", mark: "mark-alpha" },
        { id: "store-bravo", mark: "mark-bravo" },
      ],
    };
    const redacted = redactConfigObject(original, hints);
    const res = restoreRedactedValues(redacted, original, hints);
    expect(res.ok).toBe(true);
    expect(res.result).toEqual(original);
  });

  it("leaves primitive arrays and nested structures untouched", () => {
    const original = { tags: ["a", "b"], nested: { list: [{ id: "x", note: "keep" }] } };
    const incoming = { tags: ["a", "b"], nested: { list: [{ id: "x", note: "keep" }] } };
    const res = restoreRedactedValues(incoming, original, AGENT_MARK_HINTS);
    expect(res.ok).toBe(true);
    expect(res.result).toEqual(original);
  });
});
