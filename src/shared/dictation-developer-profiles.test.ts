import { describe, expect, it } from "vitest";
import {
  builtinDeveloperProfiles,
  DeveloperProfileRegistry,
  parseDeveloperProfile,
} from "./dictation-developer.ts";

const base = builtinDeveloperProfiles[0]!;
function encoded(fields: Record<string, unknown> = {}) {
  return JSON.stringify({ ...base, id: "authored-example", ...fields });
}

it.each(builtinDeveloperProfiles)("validates the advertised $id profile", (profile) => {
  const parsed = parseDeveloperProfile(JSON.stringify(profile));
  expect(parsed).toEqual({ ok: true, profile, migrated: false });
  if (parsed.ok) {
    expect(Object.isFrozen(parsed.profile)).toBe(true);
    expect(Object.isFrozen(parsed.profile.symbols[0])).toBe(true);
  }
});

describe("atomic data-only imports", () => {
  it.each([
    ["script", { script: "process.exit()" }],
    ["regular expression", { symbols: [{ spoken: "alpha", text: "a", pattern: "(a+)+$" }] }],
    ["future version", { schemaVersion: 2 }],
    ["old unknown version", { schemaVersion: -1 }],
    ["unsupported locale", { locale: "fr-FR" }],
    ["unknown language", { language: "arbitrary" }],
    ["invalid revision", { revision: 0 }],
    ["unknown grammar field", { grammar: { ...base.grammar, code: "eval" } }],
    ["duplicate command", { grammar: { ...base.grammar, codeStart: "spell" } }],
    ["prefix command", { symbols: [...base.symbols, { spoken: "open", text: "x" }] }],
    [
      "cycle",
      {
        symbols: [
          { spoken: "alpha", text: "beta" },
          { spoken: "beta", text: "alpha" },
        ],
      },
    ],
    ["self cycle", { symbols: [{ spoken: "alpha", text: "alpha" }] }],
    ["alias expression", { symbols: [{ spoken: "alpha", aliasOf: "beta" }] }],
    [
      "ambiguous duplicate",
      {
        symbols: [
          {
            spoken: "alpha",
            text: "x",
            alternatives: [
              { label: "x", text: "x" },
              { label: "same", text: "x" },
            ],
          },
        ],
      },
    ],
    ["invalid Unicode", { symbols: [{ spoken: "alpha", text: "\ud800" }] }],
    ["oversized replacement", { symbols: [{ spoken: "alpha", text: "x".repeat(129) }] }],
    ["empty digit lexicon", { spelling: { ...base.spelling, digits: [] } }],
    ["invalid whitespace", { whitespace: { ...base.whitespace, indentation: "run()" } }],
  ])("rejects %s without replacing the last valid authored profile", (_label, fields) => {
    const registry = new DeveloperProfileRegistry();
    expect(
      registry.import(encoded({ symbols: [{ spoken: "client acronym", text: "ACME_ID" }] })).ok,
    ).toBe(true);
    const before = registry.export("authored-example");
    expect(registry.import(encoded({ revision: 2, ...fields }), 1).ok).toBe(false);
    expect(registry.export("authored-example")).toBe(before);
    expect(registry.get("authored-example")?.symbols).toEqual([
      { spoken: "client acronym", text: "ACME_ID" },
    ]);
  });

  it("rejects malformed JSON, oversized imports and mapping overflow before replacement", () => {
    expect(parseDeveloperProfile("{")).toEqual({ ok: false, error: "Profile JSON is invalid." });
    expect(parseDeveloperProfile(" ".repeat(65_537)).ok).toBe(false);
    expect(
      parseDeveloperProfile(
        encoded({ symbols: Array.from({ length: 257 }, () => ({ spoken: "alpha", text: "x" })) }),
      ).ok,
    ).toBe(false);
  });

  it("retains authored strings through export and a fresh registry", () => {
    const registry = new DeveloperProfileRegistry();
    const imported = registry.import(
      encoded({ symbols: [{ spoken: "client path", text: String.raw`C:\ACME\v01\file.ts` }] }),
    );
    expect(imported.ok).toBe(true);
    const restored = new DeveloperProfileRegistry();
    expect(restored.import(registry.export("authored-example")).ok).toBe(true);
    expect(restored.get("authored-example")?.symbols[0]?.text).toBe(
      String.raw`C:\ACME\v01\file.ts`,
    );
  });

  it("round-trips a near-bound authored import without pretty-print expansion", () => {
    const symbols = Array.from({ length: 105 }, (_, index) => ({
      spoken: `custom ${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
      text: "x".repeat(128),
      alternatives: [
        { label: "Primary", text: "x".repeat(128) },
        { label: "Secondary", text: "y".repeat(128) },
      ],
    }));
    const registry = new DeveloperProfileRegistry();
    expect(registry.import(encoded({ symbols })).ok).toBe(true);
    const exported = registry.export("authored-example");
    expect(new TextEncoder().encode(exported).byteLength).toBeLessThanOrEqual(65_536);
    const restored = new DeveloperProfileRegistry();
    expect(restored.import(exported).ok).toBe(true);
    expect(restored.get("authored-example")?.symbols).toEqual(symbols);
  });

  it("requires the current revision and rejects upgrades racing a prior import", () => {
    const registry = new DeveloperProfileRegistry();
    expect(registry.import(encoded()).ok).toBe(true);
    expect(registry.import(encoded({ revision: 2, name: "New mapping" }), 1).ok).toBe(true);
    expect(registry.import(encoded({ revision: 3 }), 1).ok).toBe(false);
    expect(registry.import(encoded({ revision: 1 }), 2).ok).toBe(false);
    expect(registry.get("authored-example")?.name).toBe("New mapping");
  });

  it("migrates only the documented pre-release v0 shape without losing mappings", () => {
    const {
      revision: _revision,
      grammar: _grammar,
      spelling: _spelling,
      languageVersion: _languageVersion,
      ...legacy
    } = base;
    const parsed = parseDeveloperProfile(
      JSON.stringify({
        ...legacy,
        schemaVersion: 0,
        id: "legacy-profile",
        symbols: [{ spoken: "client code", text: "Ab_007" }],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.migrated).toBe(true);
      expect(parsed.profile).toMatchObject({
        schemaVersion: 1,
        revision: 1,
        id: "legacy-profile",
        languageVersion: "fragments-v1",
        symbols: [{ spoken: "client code", text: "Ab_007" }],
      });
    }
  });
});
