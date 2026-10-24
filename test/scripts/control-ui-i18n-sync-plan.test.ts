import { describe, expect, it } from "vitest";
import * as values from "../../scripts/lib/control-ui-i18n-catalog-values.ts";
import * as sync from "../../scripts/lib/control-ui-i18n-sync-plan.ts";

const hashText = (text: string) => `hash:${text}`;
const cacheKeyFor = (key: string, textHash: string) => `cache:${key}:${textHash}`;
const strings = (entries: Record<string, string>) => new Map(Object.entries(entries));
const memoryMap = (...rows: sync.TranslationMemoryEntry[]) =>
  new Map(rows.map((row) => [row.cache_key, row]));
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function memoryEntry(
  overrides: Partial<sync.TranslationMemoryEntry> = {},
  text = "Shared",
  translated = "Partage",
): sync.TranslationMemoryEntry {
  return {
    cache_key: "legacy-cache",
    segment_id: "legacy.segment",
    source_path: "ui/src/i18n/locales/fr.ts",
    src_lang: "en",
    text,
    text_hash: hashText(text),
    tgt_lang: "fr",
    translated,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function localeMeta(overrides: Partial<sync.LocaleMeta> = {}): sync.LocaleMeta {
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

function createPlan(overrides: Partial<Parameters<typeof sync.createControlUiLocaleSyncPlan>[0]>) {
  return sync.createControlUiLocaleSyncPlan({
    sourcePath: "ui/src/i18n/locales/fr.ts",
    allowTranslate: false,
    cacheKeyFor,
    entry: { exportName: "fr", fileName: "fr.ts", languageKey: "fr", locale: "fr" },
    existingFlat: new Map(),
    force: false,
    hashText,
    previousMeta: localeMeta(),
    sourceFlat: new Map(),
    sourceHash: "next-source",
    translationMemory: new Map(),
    ...overrides,
  });
}

function render(plan: ReturnType<typeof createPlan>, generatedAt: string) {
  return plan.render({ defaultGlossary: [], glossary: [], generatedAt, workflow: 1 });
}

function materialize(
  source: ReadonlyMap<string, string>,
  memory: ReadonlyMap<string, sync.TranslationMemoryEntry>,
) {
  return values.materializePreparedControlUiLocaleCatalog(
    values.prepareControlUiCatalogSource(source),
    memory,
  );
}

const readMemory = (value: string): sync.TranslationMemoryEntry[] =>
  value
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

describe("createControlUiLocaleSyncPlan", () => {
  it("preserves authored plugin values under force without inventing memory provenance", () => {
    const verified = memoryEntry({ segment_id: "example.verified" }, "Same", "Identique");
    const plan = createPlan({
      allowTranslate: true,
      authoredFlat: strings({ "example.authored": "Identique", "example.verified": "Identique" }),
      force: true,
      refreshKeys: new Set(["example.authored"]),
      previousMeta: null,
      sourceFlat: strings({
        "example.authored": "Same",
        "example.verified": "Same",
        "example.new": "New {count}",
      }),
      sourceHash: "plugin-source",
      sourcePath: "extensions/example/browser/i18n/locales/en.ts",
      translationMemory: memoryMap(verified),
    });
    expect(plan.pending.map(({ key }) => key)).toEqual(["example.new"]);
    plan.recordTranslations(plan.pending, strings({ "example.new": "Nouveau {count}" }), {
      sourceLocale: "en",
      updatedAt: () => "2026-01-02T00:00:00Z",
    });
    const result = render(plan, "2026-01-02T00:00:00Z");
    expect(result.nextFlat.get("example.authored")).toBe("Identique");
    const records = readMemory(result.translationMemory);
    expect(
      records
        .flatMap((record) => [record.segment_id, ...(record.segment_ids ?? [])])
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["example.new", "example.verified"]);
    expect(records.find((record) => record.segment_id === "example.new")).toMatchObject({
      source_path: "extensions/example/browser/i18n/locales/en.ts",
      text_hash: hashText("New {count}"),
      translated: "Nouveau {count}",
    });
    expect(result.fallbackCount).toBe(0);
  });

  it("refreshes selected keys without replaying cached aliases or dropping normal pending work", () => {
    const cachedEntry = (key: string, text: string, translated: string, aliases?: string[]) => {
      const text_hash = values.hashControlUiTranslationText(text);
      return memoryEntry(
        {
          cache_key: cacheKeyFor(key, text_hash),
          segment_id: key,
          segment_ids: aliases,
          text_hash,
        },
        text,
        translated,
      );
    };
    const sourceFlat = strings({
      refresh: "Shared",
      alias: "Shared",
      keep: "Keep",
      missing: "New",
      changed: "Changed {new}",
      otherGroup: "Shared",
      otherAlias: "Shared",
    });
    const existing = {
      refresh: "Partage",
      alias: "Partage",
      keep: "Conserver",
      otherGroup: "Autre",
      otherAlias: "Autre",
    };
    const replacements = { refresh: "Corrigé", missing: "Nouveau", changed: "Modifié {new}" };
    const plan = createPlan({
      allowTranslate: true,
      existingFlat: strings(existing),
      refreshKeys: new Set(["refresh"]),
      hashText: values.hashControlUiTranslationText,
      sourceFlat,
      sourceHash: "source",
      translationMemory: memoryMap(
        cachedEntry("refresh", "Shared", "Partage", ["alias"]),
        cachedEntry("keep", "Keep", "Conserver"),
        cachedEntry("otherGroup", "Shared", "Autre", ["otherAlias"]),
        memoryEntry({
          cache_key: "old",
          segment_id: "changed",
          text: "Changed {old}",
          text_hash: values.hashControlUiTranslationText("Changed {old}"),
        }),
      ),
    });
    expect(plan.pending.map((item) => item.key)).toEqual(["refresh", "missing", "changed"]);
    plan.recordTranslations(plan.pending, strings(replacements), {
      sourceLocale: "en",
      updatedAt: () => "2026-09-06T00:00:00.000Z",
    });
    const rendered = render(plan, "2026-09-06T00:00:00.000Z");
    expect(Object.fromEntries(rendered.nextFlat)).toEqual({ ...existing, ...replacements });
    expect(rendered.fallbackCount).toBe(0);
    const writtenMemory = memoryMap(...readMemory(rendered.translationMemory));
    expect(values.materializeControlUiLocaleCatalog(sourceFlat, writtenMemory)).toEqual(
      Object.fromEntries(rendered.nextFlat),
    );
  });

  it("retranslates cached and existing strings on a full refresh", () => {
    const cached = memoryEntry({ segment_id: "cached" });
    const plan = createPlan({
      allowTranslate: true,
      existingFlat: strings({ cached: "Partage", existing: "Existant" }),
      force: true,
      sourceFlat: strings({ cached: "Shared", alias: "Shared", existing: "Existing" }),
      sourceHash: "source",
      translationMemory: memoryMap(cached),
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
    const merged = values.mergeControlUiTranslationMaps(startup, fragment);

    expect([...sync.flattenTranslations(merged)]).toEqual([
      ["updates.before", "Before"],
      ["updates.page.title", "Updates"],
      ["updates.after", "After"],
      ["settings.title", "Settings"],
      ["common.ok", "OK"],
    ]);
    expect([startup.settings, startup.updates.page]).toEqual([{}, {}]);
    expect(merged.updates).not.toBe(startup.updates);
    expect(merged.settings).not.toBe(fragment.settings);
  });

  it("plans reuse and renders deterministic locale artifacts", () => {
    const sourceFlat = strings({
      "group.cached": "Cached source",
      "group.existing": "Existing source",
      "group.pending": "Pending source",
      "group.reused": "Shared",
    });
    const exactCacheKey = cacheKeyFor("group.cached", hashText("Cached source"));
    const exactCache = memoryEntry(
      { cache_key: exactCacheKey, segment_id: "group.cached" },
      "Cached source",
      "En cache",
    );
    const sharedCache = Object.assign(memoryEntry(), {
      model: "private-model-fixture",
      provider: "private-provider-fixture",
    });
    const plan = createPlan({
      existingFlat: strings({ "group.cached": "Ancien cache", "group.existing": "Existant" }),
      previousMeta: localeMeta({ fallbackKeys: ["group.cached"] }),
      sourceFlat,
      translationMemory: memoryMap(sharedCache, exactCache),
    });

    expect(plan).toMatchObject({ pending: [{ key: "group.pending" }], newFallbackCount: 1 });

    const artifacts = plan.render({
      defaultGlossary: [{ source: "OpenClaw", target: "OpenClaw" }],
      generatedAt: "2026-02-02T00:00:00.000Z",
      glossary: [],
      workflow: 1,
    });

    const expectedMeta = localeMeta({
      fallbackKeys: ["group.cached", "group.pending"],
      generatedAt: "2026-02-02T00:00:00.000Z",
      sourceHash: "next-source",
      totalKeys: 4,
      translatedKeys: 2,
    });
    expect(artifacts.meta).toBe(json(expectedMeta));
    expect(artifacts.glossary).toBe(json([{ source: "OpenClaw", target: "OpenClaw" }]));
    const reusedCache = memoryEntry({
      cache_key: cacheKeyFor("group.reused", hashText("Shared")),
      segment_id: "group.reused",
    });
    expect(artifacts.translationMemory).toBe(
      `${[reusedCache, exactCache]
        .toSorted((left, right) => left.cache_key.localeCompare(right.cache_key))
        .map((value) => JSON.stringify(value))
        .join("\n")}\n`,
    );
    expect(artifacts.translationMemory + artifacts.meta).not.toContain("private-");
  });

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
    const memory = memoryMap(grouped, replacement, stale);
    const source = sync.flattenTranslations({
      group: { first: "abc", second: "abc" },
      changed: "Changed",
      unused: "abc",
    });
    const catalog = materialize(source, memory);
    expect(catalog).toEqual({ group: { first: "Dernier", second: "Partagé" } });
    expect([...sync.flattenTranslations(catalog)]).toEqual([
      ["group.first", "Dernier"],
      ["group.second", "Partagé"],
    ]);
    expect(materialize(strings({ "group.first": "abc" }), new Map())).toEqual({});
    expect(materialize(new Map(), memory)).toEqual({});
    expect(materialize(strings({ "group.first": "Changed" }), memory)).toEqual({});
    expect(materialize(strings({ "group.first": "abc" }), memoryMap(grouped))).toEqual({
      group: { first: "Partagé" },
    });
  });
  it("refreshes recorded fallback copy when forced without a provider", () => {
    const plan = createPlan({
      existingFlat: strings({ title: "Old English" }),
      force: true,
      previousMeta: localeMeta({ fallbackKeys: ["title"] }),
      sourceFlat: strings({ title: "New English" }),
    });

    expect(plan.newFallbackCount).toBe(0);
    const artifacts = render(plan, "2026-03-03T00:00:00.000Z");
    expect(artifacts.nextFlat.get("title")).toBe("New English");
    expect(JSON.parse(artifacts.meta).fallbackKeys).toEqual(["title"]);
  });

  it("preserves generatedAt when semantic metadata is unchanged", () => {
    const sourceFlat = sync.flattenTranslations({ title: "Titre" });
    const previousMeta = localeMeta({ sourceHash: "same-source", totalKeys: 1, translatedKeys: 1 });
    const plan = createPlan({
      existingFlat: strings({ title: "Titre" }),
      previousMeta,
      sourceFlat,
      sourceHash: "same-source",
    });

    const artifacts = render(plan, "2026-03-03T00:00:00.000Z");

    expect(JSON.parse(artifacts.meta).generatedAt).toBe(previousMeta.generatedAt);
  });
});
