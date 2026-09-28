import { describe, expect, it } from "vitest";
import {
  hashControlUiTranslationText,
  materializeControlUiLocaleCatalog,
  materializePreparedControlUiLocaleCatalog,
  mergeControlUiTranslationMaps,
  prepareControlUiCatalogSource,
} from "../../scripts/lib/control-ui-i18n-catalog-values.ts";
import {
  createControlUiLocaleSyncPlan,
  flattenTranslations,
  type LocaleEntry,
  type LocaleMeta,
  type TranslationMemoryEntry,
} from "../../scripts/lib/control-ui-i18n-sync-plan.ts";

const entry: LocaleEntry = {
  exportName: "fr",
  fileName: "fr.ts",
  languageKey: "fr",
  locale: "fr",
};

const hashText = (text: string) => `hash:${text}`;
const cacheKeyFor = (key: string, textHash: string) => `cache:${key}:${textHash}`;

function memoryEntry(overrides: Partial<TranslationMemoryEntry> = {}): TranslationMemoryEntry {
  return {
    cache_key: "legacy-cache",
    segment_id: "legacy.segment",
    source_path: "ui/src/i18n/locales/fr.ts",
    src_lang: "en",
    text: "Shared",
    text_hash: hashText("Shared"),
    tgt_lang: "fr",
    translated: "Partage",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function localeMeta(overrides: Partial<LocaleMeta> = {}): LocaleMeta {
  return {
    fallbackKeys: [],
    generatedAt: "2026-01-01T00:00:00.000Z",
    locale: "fr",
    sourceHash: "old-source",
    totalKeys: 0,
    translatedKeys: 0,
    workflow: 1,
    ...overrides,
  };
}

describe("createControlUiLocaleSyncPlan", () => {
  it("refreshes selected keys without replaying cached aliases or dropping normal pending work", () => {
    const catalogHashText = hashControlUiTranslationText;
    const sourceFlat = new Map([
      ["refresh", "Shared"],
      ["alias", "Shared"],
      ["keep", "Keep"],
      ["missing", "New"],
      ["changed", "Changed {new}"],
      ["otherGroup", "Shared"],
      ["otherAlias", "Shared"],
    ]);
    const cached = memoryEntry({
      cache_key: cacheKeyFor("refresh", catalogHashText("Shared")),
      segment_id: "refresh",
      segment_ids: ["alias"],
      text_hash: catalogHashText("Shared"),
    });
    const kept = memoryEntry({
      cache_key: cacheKeyFor("keep", catalogHashText("Keep")),
      segment_id: "keep",
      text: "Keep",
      text_hash: catalogHashText("Keep"),
      translated: "Conserver",
    });
    const independent = memoryEntry({
      cache_key: cacheKeyFor("otherGroup", catalogHashText("Shared")),
      segment_id: "otherGroup",
      segment_ids: ["otherAlias"],
      text_hash: catalogHashText("Shared"),
      translated: "Autre",
    });
    const plan = createControlUiLocaleSyncPlan({
      allowTranslate: true,
      cacheKeyFor,
      entry,
      existingFlat: new Map([
        ["refresh", "Partage"],
        ["alias", "Partage"],
        ["keep", "Conserver"],
        ["otherGroup", "Autre"],
        ["otherAlias", "Autre"],
      ]),
      force: false,
      refreshKeys: new Set(["refresh"]),
      hashText: catalogHashText,
      previousMeta: localeMeta(),
      sourceFlat,
      sourceHash: "source",
      translationMemory: new Map([
        [cached.cache_key, cached],
        [kept.cache_key, kept],
        [independent.cache_key, independent],
        [
          "old",
          memoryEntry({
            cache_key: "old",
            segment_id: "changed",
            text: "Changed {old}",
            text_hash: catalogHashText("Changed {old}"),
          }),
        ],
      ]),
    });
    expect(plan.pending.map((item) => item.key)).toEqual(["refresh", "missing", "changed"]);
    plan.recordTranslations(
      plan.pending,
      new Map([
        ["refresh", "Corrigé"],
        ["missing", "Nouveau"],
        ["changed", "Modifié {new}"],
      ]),
      { sourceLocale: "en", updatedAt: () => "2026-09-06T00:00:00.000Z" },
    );
    const rendered = plan.render({
      defaultGlossary: [],
      glossary: [],
      generatedAt: "2026-09-06T00:00:00.000Z",
      workflow: 1,
    });
    expect(Object.fromEntries(rendered.nextFlat)).toEqual({
      refresh: "Corrigé",
      alias: "Partage",
      keep: "Conserver",
      missing: "Nouveau",
      changed: "Modifié {new}",
      otherGroup: "Autre",
      otherAlias: "Autre",
    });
    expect(rendered.fallbackCount).toBe(0);
    const writtenMemory = new Map(
      rendered.translationMemory
        .trim()
        .split("\n")
        .map((line) => {
          const item = JSON.parse(line) as TranslationMemoryEntry;
          return [item.cache_key, item];
        }),
    );
    expect(materializeControlUiLocaleCatalog(sourceFlat, writtenMemory)).toEqual(
      Object.fromEntries(rendered.nextFlat),
    );
  });

  it("retranslates cached and existing strings on a full refresh", () => {
    const cached = memoryEntry({ segment_id: "cached" });
    const plan = createControlUiLocaleSyncPlan({
      allowTranslate: true,
      cacheKeyFor,
      entry,
      existingFlat: new Map([
        ["cached", "Partage"],
        ["existing", "Existant"],
      ]),
      force: true,
      hashText,
      previousMeta: localeMeta(),
      sourceFlat: new Map([
        ["cached", "Shared"],
        ["alias", "Shared"],
        ["existing", "Existing"],
      ]),
      sourceHash: "source",
      translationMemory: new Map([[cached.cache_key, cached]]),
    });
    expect(plan.pending.map((item) => item.key)).toEqual(["cached", "alias", "existing"]);
  });

  it("fills lazy anchors in source order without mutating source or losing siblings", () => {
    const startup = {
      updates: { before: "Before", page: {}, after: "After" },
      settings: {},
      common: { ok: "OK" },
    };
    const fragment = {
      settings: { title: "Settings" },
      updates: { page: { title: "Updates" } },
    };
    const merged = mergeControlUiTranslationMaps(startup, fragment);

    expect([...flattenTranslations(merged)]).toEqual([
      ["updates.before", "Before"],
      ["updates.page.title", "Updates"],
      ["updates.after", "After"],
      ["settings.title", "Settings"],
      ["common.ok", "OK"],
    ]);
    expect(startup.settings).toEqual({});
    expect(startup.updates.page).toEqual({});
    expect(merged.updates).not.toBe(startup.updates);
    expect(merged.settings).not.toBe(fragment.settings);
  });

  it("plans reuse and renders deterministic locale artifacts", () => {
    const sourceFlat = flattenTranslations({
      group: {
        cached: "Cached source",
        existing: "Existing source",
        pending: "Pending source",
        reused: "Shared",
      },
    });
    const exactCacheKey = cacheKeyFor("group.cached", hashText("Cached source"));
    const exactCache = memoryEntry({
      cache_key: exactCacheKey,
      segment_id: "group.cached",
      text: "Cached source",
      text_hash: hashText("Cached source"),
      translated: "En cache",
    });
    const sharedCache = Object.assign(memoryEntry(), {
      model: "private-model-fixture",
      provider: "private-provider-fixture",
    });
    const plan = createControlUiLocaleSyncPlan({
      allowTranslate: false,
      cacheKeyFor,
      entry,
      existingFlat: new Map([
        ["group.cached", "Ancien cache"],
        ["group.existing", "Existant"],
      ]),
      force: false,
      hashText,
      previousMeta: localeMeta({ fallbackKeys: ["group.cached"] }),
      sourceFlat,
      sourceHash: "next-source",
      translationMemory: new Map([
        [sharedCache.cache_key, sharedCache],
        [exactCache.cache_key, exactCache],
      ]),
    });

    expect(plan.pending.map((item) => item.key)).toEqual(["group.pending"]);
    expect(plan.newFallbackCount).toBe(1);

    const artifacts = plan.render({
      defaultGlossary: [{ source: "OpenClaw", target: "OpenClaw" }],
      generatedAt: "2026-02-02T00:00:00.000Z",
      glossary: [],
      workflow: 1,
    });

    expect(artifacts.meta).toBe(
      `${JSON.stringify(
        {
          fallbackKeys: ["group.cached", "group.pending"],
          generatedAt: "2026-02-02T00:00:00.000Z",
          locale: "fr",
          sourceHash: "next-source",
          totalKeys: 4,
          translatedKeys: 2,
          workflow: 1,
        },
        null,
        2,
      )}\n`,
    );
    expect(artifacts.glossary).toBe(
      `${JSON.stringify([{ source: "OpenClaw", target: "OpenClaw" }], null, 2)}\n`,
    );
    const reusedCache = {
      ...memoryEntry(),
      cache_key: cacheKeyFor("group.reused", hashText("Shared")),
      segment_id: "group.reused",
    };
    expect(artifacts.translationMemory).toBe(
      `${[reusedCache, exactCache]
        .toSorted((left, right) => left.cache_key.localeCompare(right.cache_key))
        .map((value) => JSON.stringify(value))
        .join("\n")}\n`,
    );
    expect(artifacts.translationMemory + artifacts.meta).not.toContain("private-");
  });

  it("reuses grouped segment aliases only while their source text still matches", () => {
    const sourceFlat = flattenTranslations({ group: { alias: "Shared" } });
    const grouped = memoryEntry({ segment_ids: ["group.alias"] });
    const createPlan = (source: ReadonlyMap<string, string>) =>
      createControlUiLocaleSyncPlan({
        allowTranslate: false,
        cacheKeyFor,
        entry,
        existingFlat: new Map(),
        force: false,
        hashText,
        previousMeta: localeMeta(),
        sourceFlat: source,
        sourceHash: "source",
        translationMemory: new Map([[grouped.cache_key, grouped]]),
      });

    expect(createPlan(sourceFlat).pending).toEqual([]);
    expect(createPlan(new Map([["group.alias", "Changed"]])).pending).toHaveLength(1);
  });

  describe.each([
    { name: "raw", materialize: materializeControlUiLocaleCatalog },
    {
      name: "prepared",
      materialize: (
        source: ReadonlyMap<string, string>,
        memory: ReadonlyMap<string, TranslationMemoryEntry>,
      ) => materializePreparedControlUiLocaleCatalog(prepareControlUiCatalogSource(source), memory),
    },
  ])("$name materialization", ({ materialize }) => {
    it("keeps aliases independent, source order, and the last valid write", () => {
      const abcHash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
      const grouped = memoryEntry({
        segment_id: "group.second",
        segment_ids: ["group.first", "removed", "changed"],
        text: "Stored text is not the freshness authority",
        text_hash: abcHash,
        translated: "Partagé",
      });
      const replacement = memoryEntry({
        cache_key: "replacement",
        segment_id: "group.first",
        text_hash: abcHash,
        translated: "Dernier",
      });
      const stale = memoryEntry({
        cache_key: "stale",
        segment_id: "group.first",
        text_hash: "stale",
        translated: "Obsolète",
      });
      const memory = new Map([
        [grouped.cache_key, grouped],
        [replacement.cache_key, replacement],
        [stale.cache_key, stale],
      ]);
      const source = flattenTranslations({
        group: { first: "abc", second: "abc" },
        changed: "Changed",
        unused: "abc",
      });
      const catalog = materialize(source, memory);
      expect(catalog).toEqual({ group: { first: "Dernier", second: "Partagé" } });
      expect([...flattenTranslations(catalog)]).toEqual([
        ["group.first", "Dernier"],
        ["group.second", "Partagé"],
      ]);
      expect(materialize(new Map([["group.first", "abc"]]), new Map())).toEqual({});
      expect(materialize(new Map(), memory)).toEqual({});
      expect(materialize(new Map([["group.first", "Changed"]]), memory)).toEqual({});
      expect(
        materialize(new Map([["group.first", "abc"]]), new Map([[grouped.cache_key, grouped]])),
      ).toEqual({ group: { first: "Partagé" } });
    });
  });

  it("keeps independently prepared source snapshots after the raw map changes", () => {
    const source = new Map([["title", "abc"]]);
    const first = prepareControlUiCatalogSource(source);
    source.set("title", "");
    source.set("alias", "abc");
    const second = prepareControlUiCatalogSource(source);
    const original = memoryEntry({
      cache_key: "original",
      segment_id: "title",
      segment_ids: ["alias"],
      text_hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      translated: "Original",
    });
    const changed = memoryEntry({
      cache_key: "changed",
      segment_id: "title",
      text_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      translated: "Changed",
    });
    const memory = new Map([
      [original.cache_key, original],
      [changed.cache_key, changed],
    ]);
    expect(materializePreparedControlUiLocaleCatalog(first, memory)).toEqual({ title: "Original" });
    const next = materializePreparedControlUiLocaleCatalog(second, memory);
    expect(next).toEqual({ title: "Changed", alias: "Original" });
    expect(Object.keys(next)).toEqual(["title", "alias"]);
  });

  it("refreshes recorded fallbacks and records translated replacements", () => {
    const sourceFlat = flattenTranslations({ title: "New English" });
    const previousMeta = localeMeta({
      fallbackKeys: ["title"],
      sourceHash: "previous-source",
      totalKeys: 1,
      translatedKeys: 0,
    });
    const plan = createControlUiLocaleSyncPlan({
      allowTranslate: true,
      cacheKeyFor,
      entry,
      existingFlat: new Map([["title", "Old English"]]),
      force: true,
      hashText,
      previousMeta,
      sourceFlat,
      sourceHash: "next-source",
      translationMemory: new Map(),
    });

    expect(plan.newFallbackCount).toBe(0);
    plan.recordTranslations(plan.pending, new Map([["title", "Nouveau"]]), {
      sourceLocale: "en",
      updatedAt: () => "2026-02-02T00:00:00.000Z",
    });

    const artifacts = plan.render({
      defaultGlossary: [],
      generatedAt: "2026-03-03T00:00:00.000Z",
      glossary: [],
      workflow: 1,
    });

    expect(artifacts.fallbackCount).toBe(0);
    expect(artifacts.nextFlat.get("title")).toBe("Nouveau");
    expect(JSON.parse(artifacts.meta)).toMatchObject({
      fallbackKeys: [],
      generatedAt: "2026-03-03T00:00:00.000Z",
      translatedKeys: 1,
    });
    expect(artifacts.translationMemory).toBe(
      `${JSON.stringify(
        memoryEntry({
          cache_key: cacheKeyFor("title", hashText("New English")),
          segment_id: "title",
          text: "New English",
          text_hash: hashText("New English"),
          translated: "Nouveau",
          updated_at: "2026-02-02T00:00:00.000Z",
        }),
      )}\n`,
    );
  });

  it("refreshes recorded fallback copy when forced without a provider", () => {
    const plan = createControlUiLocaleSyncPlan({
      allowTranslate: false,
      cacheKeyFor,
      entry,
      existingFlat: new Map([["title", "Old English"]]),
      force: true,
      hashText,
      previousMeta: localeMeta({ fallbackKeys: ["title"] }),
      sourceFlat: new Map([["title", "New English"]]),
      sourceHash: "next-source",
      translationMemory: new Map(),
    });

    expect(plan.newFallbackCount).toBe(0);
    const artifacts = plan.render({
      defaultGlossary: [],
      generatedAt: "2026-03-03T00:00:00.000Z",
      glossary: [],
      workflow: 1,
    });
    expect(artifacts.nextFlat.get("title")).toBe("New English");
    expect(JSON.parse(artifacts.meta).fallbackKeys).toEqual(["title"]);
  });

  it("preserves generatedAt when semantic metadata is unchanged", () => {
    const sourceFlat = flattenTranslations({ title: "Titre" });
    const previousMeta = localeMeta({
      sourceHash: "same-source",
      totalKeys: 1,
      translatedKeys: 1,
    });
    const plan = createControlUiLocaleSyncPlan({
      allowTranslate: false,
      cacheKeyFor,
      entry,
      existingFlat: new Map([["title", "Titre"]]),
      force: false,
      hashText,
      previousMeta,
      sourceFlat,
      sourceHash: "same-source",
      translationMemory: new Map(),
    });

    const artifacts = plan.render({
      defaultGlossary: [],
      generatedAt: "2026-03-03T00:00:00.000Z",
      glossary: [],
      workflow: 1,
    });

    expect(JSON.parse(artifacts.meta)).toMatchObject({
      generatedAt: previousMeta.generatedAt,
    });
  });
});
