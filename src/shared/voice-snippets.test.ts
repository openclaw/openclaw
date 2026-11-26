import { describe, expect, it } from "vitest";
import {
  createVoiceSnippetCatalog,
  editVoiceSnippetCatalog,
  exportVoiceSnippetCatalog,
  normalizeVoiceSnippetTrigger,
  searchVoiceSnippets,
  validateVoiceSnippetCatalog,
  VOICE_SNIPPET_BODY_BYTES,
  VOICE_SNIPPET_CATALOG_BYTES,
  type VoiceSnippet,
} from "./voice-snippets.js";

const definition: Omit<VoiceSnippet, "schemaVersion" | "revision"> = {
  id: "support-signature",
  name: "Support signature",
  locale: "en-US",
  triggers: ["support signature"],
  body: "00042\n\n{{name}} <date> $HOME $(exit)\r\nÉ🙂\ninsert snippet other",
  enabled: true,
  sensitivity: "sensitive",
};
const populated = () =>
  editVoiceSnippetCatalog(createVoiceSnippetCatalog(), {
    type: "save",
    snippet: definition,
    expectedRevision: null,
  });

describe("static snippet catalog", () => {
  it("preserves authored bytes and record revisions through export, import, edits and disabling", () => {
    const initial = populated();
    const saved = editVoiceSnippetCatalog(initial, {
      type: "save",
      snippet: { ...definition, name: "Renamed" },
      expectedRevision: 1,
    });
    const imported = editVoiceSnippetCatalog(createVoiceSnippetCatalog(), {
      type: "import",
      data: exportVoiceSnippetCatalog(saved),
    });
    expect(imported.snippets).toEqual([
      { ...definition, schemaVersion: 1, revision: 2, name: "Renamed" },
    ]);
    expect(imported.enabled).toBe(false);
    const disabled = editVoiceSnippetCatalog(imported, { type: "enabled", enabled: false });
    expect(disabled.snippets[0]?.body).toBe(definition.body);
    expect(searchVoiceSnippets(disabled, "signature")).toHaveLength(1);
    expect(searchVoiceSnippets(disabled, "$HOME")).toHaveLength(0);
    expect(() =>
      editVoiceSnippetCatalog(disabled, { type: "delete", id: definition.id, expectedRevision: 1 }),
    ).toThrow("Refresh before saving");
    expect(
      editVoiceSnippetCatalog(disabled, { type: "delete", id: definition.id, expectedRevision: 2 })
        .snippets,
    ).toEqual([]);
  });

  it("normalizes case, whitespace and composed accents without discarding punctuation or accents", () => {
    expect(normalizeVoiceSnippetTrigger("  SUPPORT\tSignature ", "en-US")).toBe(
      "support signature",
    );
    expect(normalizeVoiceSnippetTrigger("İ", "tr")).toBe("i");
    expect(normalizeVoiceSnippetTrigger("cafe\u0301!", "fr")).toBe("café!");
    const initial = populated();
    expect(() =>
      editVoiceSnippetCatalog(initial, {
        type: "save",
        expectedRevision: null,
        snippet: { ...definition, id: "second", triggers: ["SUPPORT   signature"] },
      }),
    ).toThrow("share a trigger");
    expect(
      editVoiceSnippetCatalog(initial, {
        type: "save",
        expectedRevision: null,
        snippet: { ...definition, id: "second", triggers: ["support signature!"] },
      }).snippets,
    ).toHaveLength(2);
    expect(
      editVoiceSnippetCatalog(initial, {
        type: "save",
        expectedRevision: null,
        snippet: { ...definition, id: "disabled", enabled: false },
      }).snippets,
    ).toHaveLength(2);
  });

  it.each([
    "{",
    '{"schemaVersion":2,"snippets":[]}',
    '{"schemaVersion":1,"snippets":[],"requires":["dynamic"]}',
    JSON.stringify({
      schemaVersion: 1,
      snippets: [{ ...definition, schemaVersion: 1, revision: 1, variables: {} }],
    }),
    JSON.stringify({
      schemaVersion: 1,
      snippets: [
        {
          ...definition,
          schemaVersion: 1,
          revision: 1,
          body: "x".repeat(VOICE_SNIPPET_BODY_BYTES + 1),
        },
      ],
    }),
    JSON.stringify({
      schemaVersion: 1,
      snippets: [{ ...definition, schemaVersion: 1, revision: 1, body: "\ud800" }],
    }),
  ])("rejects an invalid import without changing existing definitions", (data) => {
    const initial = populated();
    expect(() => editVoiceSnippetCatalog(initial, { type: "import", data })).toThrow();
    expect(initial.snippets[0]?.body).toBe(definition.body);
    expect(initial.revision).toBe(1);
  });

  it("bounds successful catalogs, import bytes, record IDs and triggers", () => {
    const initial = populated();
    expect(() =>
      editVoiceSnippetCatalog(initial, {
        type: "import",
        data: " ".repeat(VOICE_SNIPPET_CATALOG_BYTES + 1),
      }),
    ).toThrow("9 MiB");
    expect(() =>
      validateVoiceSnippetCatalog({ ...initial, snippets: Array(501).fill(initial.snippets[0]) }),
    ).toThrow("500 snippets");
    expect(() =>
      validateVoiceSnippetCatalog({
        ...initial,
        snippets: [...initial.snippets, ...initial.snippets],
      }),
    ).toThrow("distinct stable ID");
    expect(() =>
      validateVoiceSnippetCatalog({
        ...initial,
        snippets: [{ ...initial.snippets[0], triggers: [] }],
      }),
    ).toThrow("one to eight");
    expect(() =>
      validateVoiceSnippetCatalog({
        ...initial,
        snippets: [{ ...initial.snippets[0], locale: "not_a_locale" }],
      }),
    ).toThrow("language tag");
  });

  it("keeps full catalogs disableable and exportable as catalog and record metadata grow", () => {
    const envelope = {
      ...createVoiceSnippetCatalog(),
      revision: Number.MAX_SAFE_INTEGER,
      snippets: Array.from({ length: 96 }, (_, index): VoiceSnippet => ({
        ...definition,
        schemaVersion: 1,
        id: `capacity-${index}`,
        name: `Capacity ${index}`,
        triggers: [`capacity ${index}`],
        revision: Number.MAX_SAFE_INTEGER,
        enabled: false,
        body: "x".repeat(VOICE_SNIPPET_BODY_BYTES),
      })),
    };
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    let remaining = VOICE_SNIPPET_CATALOG_BYTES - bytes(envelope);
    // A control character uses one body byte but six JSON bytes. Fill the real
    // maximum-width metadata envelope without exceeding any individual body limit.
    const remainder = remaining % 5;
    envelope.snippets[0]!.name += "x".repeat(remainder);
    remaining -= remainder;
    for (const snippet of envelope.snippets) {
      const escaped = Math.min(remaining / 5, VOICE_SNIPPET_BODY_BYTES);
      snippet.body = "\u0001".repeat(escaped) + "x".repeat(VOICE_SNIPPET_BODY_BYTES - escaped);
      remaining -= escaped * 5;
    }
    expect(bytes(envelope)).toBe(VOICE_SNIPPET_CATALOG_BYTES);
    const definitions = envelope.snippets.map((snippet) => ({
      ...snippet,
      revision: 9,
      enabled: true,
    }));
    let current = validateVoiceSnippetCatalog({
      ...envelope,
      revision: 9,
      enabled: true,
      snippets: definitions,
    });
    for (const enabled of [false, true]) {
      current = editVoiceSnippetCatalog(current, { type: "enabled", enabled });
      expect(current.enabled).toBe(enabled);
      expect(current.snippets).toEqual(definitions);
    }
    for (const enabled of [false, true]) {
      const snippet = current.snippets[0]!;
      current = editVoiceSnippetCatalog(current, {
        type: "save",
        snippet: { ...snippet, enabled },
        expectedRevision: snippet.revision,
      });
      expect(current.snippets[0]?.enabled).toBe(enabled);
    }
    const expectedDefinitions = [{ ...definitions[0], revision: 11 }, ...definitions.slice(1)];
    expect(current.snippets).toEqual(expectedDefinitions);
    const exported = exportVoiceSnippetCatalog(current);
    for (const target of [current, createVoiceSnippetCatalog()]) {
      const restored = editVoiceSnippetCatalog(target, { type: "import", data: exported });
      expect(restored.snippets).toEqual(expectedDefinitions);
      expect(restored.enabled).toBe(target.enabled);
    }
    const oversized = current.snippets.map((snippet, index) =>
      index === 0 ? { ...snippet, name: `${snippet.name}x` } : snippet,
    );
    expect(() =>
      editVoiceSnippetCatalog(current, {
        type: "import",
        data: JSON.stringify({ schemaVersion: 1, snippets: oversized }),
      }),
    ).toThrow("9 MiB");
    expect(exportVoiceSnippetCatalog(current)).toBe(exported);
  });
});
