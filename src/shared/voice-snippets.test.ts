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
});
