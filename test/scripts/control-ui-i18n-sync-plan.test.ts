import { expect, it } from "vitest";
import * as values from "../../scripts/lib/control-ui-i18n-catalog-values.ts";
import * as sync from "../../scripts/lib/control-ui-i18n-sync-plan.ts";

const date = "2026-01-01T00:00:00.000Z";
const hashText = values.hashControlUiTranslationText;
const cacheKeyFor = (key: string, hash: string) => `${key}:${hash}`;
const strings = (entries: Record<string, string>) => new Map(Object.entries(entries));
function entry(
  segment_id: string,
  text: string,
  translated: string,
  extra: Partial<sync.TranslationMemoryEntry> = {},
): sync.TranslationMemoryEntry {
  return {
    cache_key: cacheKeyFor(segment_id, hashText(text)),
    segment_id,
    text,
    translated,
    text_hash: hashText(text),
    source_path: "fr.ts",
    src_lang: "en",
    tgt_lang: "fr",
    updated_at: date,
    ...extra,
  };
}
const memory = (...entries: sync.TranslationMemoryEntry[]) =>
  new Map(entries.map((row) => [row.cache_key, row]));
const meta = (extra: Partial<sync.LocaleMeta> = {}): sync.LocaleMeta => ({
  fallbackKeys: [],
  generatedAt: date,
  locale: "fr",
  sourceHash: "old",
  totalKeys: 0,
  translatedKeys: 0,
  workflow: 1,
  ...extra,
});
function plan(
  source: Record<string, string>,
  extra: Partial<Parameters<typeof sync.createControlUiLocaleSyncPlan>[0]> = {},
) {
  return sync.createControlUiLocaleSyncPlan({
    sourcePath: "fr.ts",
    allowTranslate: false,
    cacheKeyFor,
    hashText,
    entry: { exportName: "fr", fileName: "fr.ts", languageKey: "fr", locale: "fr" },
    existingFlat: new Map(),
    force: false,
    previousMeta: meta(),
    sourceFlat: strings(source),
    sourceHash: "next",
    translationMemory: new Map(),
    ...extra,
  });
}
const render = (p: ReturnType<typeof plan>) =>
  p.render({ defaultGlossary: [], glossary: [], generatedAt: "new-date", workflow: 1 });
const records = (text: string): sync.TranslationMemoryEntry[] =>
  text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
function translate(p: ReturnType<typeof plan>, translated: Record<string, string>) {
  p.recordTranslations(p.pending, strings(translated), {
    sourceLocale: "en",
    updatedAt: () => date,
  });
  return render(p);
}

it("preserves authored plugin copy under force without inventing provenance", () => {
  const p = plan(
    { authored: "Same", verified: "Same", new: "New {count}" },
    {
      allowTranslate: true,
      force: true,
      refreshKeys: new Set(["authored"]),
      previousMeta: null,
      authoredFlat: strings({ authored: "Identique", verified: "Identique" }),
      sourcePath: "extensions/example/browser/i18n/locales/en.ts",
      translationMemory: memory(entry("verified", "Same", "Identique")),
    },
  );
  expect(p.pending.map(({ key }) => key)).toEqual(["new"]);
  const result = translate(p, { new: "Nouveau {count}" });
  expect(result.nextFlat.get("authored")).toBe("Identique");
  const rows = records(result.translationMemory);
  expect(rows.flatMap((row) => [row.segment_id, ...(row.segment_ids ?? [])]).toSorted()).toEqual([
    "new",
    "verified",
  ]);
  expect(rows.find((row) => row.segment_id === "new")).toMatchObject({
    source_path: "extensions/example/browser/i18n/locales/en.ts",
    text_hash: hashText("New {count}"),
    translated: "Nouveau {count}",
  });
  expect(result.fallbackCount).toBe(0);
});

it("refreshes selected keys without replaying aliases or dropping pending work", () => {
  const source = {
    refresh: "Shared",
    alias: "Shared",
    missing: "New",
    changed: "Changed",
    group: "Shared",
    other: "Shared",
  };
  const existing = {
    refresh: "Partage",
    alias: "Partage",
    group: "Autre",
    other: "Autre",
  };
  const replacements = { refresh: "Corrigé", missing: "Nouveau", changed: "Modifié" };
  const p = plan(source, {
    allowTranslate: true,
    existingFlat: strings(existing),
    refreshKeys: new Set(["refresh"]),
    translationMemory: memory(
      entry("refresh", "Shared", "Partage", { segment_ids: ["alias"] }),
      entry("group", "Shared", "Autre", { segment_ids: ["other"] }),
      entry("changed", "Old", "Old"),
    ),
  });
  expect(p.pending.map(({ key }) => key)).toEqual(["refresh", "missing", "changed"]);
  const result = translate(p, replacements);
  expect(Object.fromEntries(result.nextFlat)).toEqual({ ...existing, ...replacements });
  expect(result.fallbackCount).toBe(0);
  expect(
    values.materializeControlUiLocaleCatalog(
      strings(source),
      memory(...records(result.translationMemory)),
    ),
  ).toEqual(Object.fromEntries(result.nextFlat));
});

it("retranslates cached and existing strings on a full refresh", () => {
  const p = plan(
    { cached: "Shared" },
    {
      allowTranslate: true,
      force: true,
      existingFlat: strings({ cached: "Partage" }),
      translationMemory: memory(entry("cached", "Shared", "Partage")),
    },
  );
  expect(p.pending.map(({ key }) => key)).toEqual(["cached"]);
});

it("fills lazy anchors in source order without mutation or lost siblings", () => {
  const startup = {
    updates: { before: "Before", page: {}, after: "After" },
    settings: {},
  };
  const fragment = { settings: { title: "Settings" }, updates: { page: { title: "Updates" } } };
  const merged = values.mergeControlUiTranslationMaps(startup, fragment);
  expect([...sync.flattenTranslations(merged)]).toEqual([
    ["updates.before", "Before"],
    ["updates.page.title", "Updates"],
    ["updates.after", "After"],
    ["settings.title", "Settings"],
  ]);
  expect([startup.settings, startup.updates.page]).toEqual([{}, {}]);
});

it("reuses cached copy and renders deterministic public artifacts", () => {
  const cached = entry("cached", "Cached", "En cache");
  const shared = entry("legacy", "Shared", "Partage", { cache_key: "legacy-cache" });
  const p = plan(
    { cached: "Cached", existing: "Existing", pending: "Pending", reused: "Shared" },
    {
      existingFlat: strings({ cached: "Ancien", existing: "Existant" }),
      previousMeta: meta({ fallbackKeys: ["cached"] }),
      translationMemory: memory(
        cached,
        Object.assign(shared, { model: "private-model", provider: "private-provider" }),
      ),
    },
  );
  expect(p).toMatchObject({ pending: [{ key: "pending" }], newFallbackCount: 1 });
  const glossary = [{ source: "OpenClaw", target: "OpenClaw" }];
  const result = p.render({
    defaultGlossary: glossary,
    glossary: [],
    generatedAt: "new-date",
    workflow: 1,
  });
  expect(JSON.parse(result.meta)).toEqual(
    meta({
      fallbackKeys: ["cached", "pending"],
      generatedAt: "new-date",
      sourceHash: "next",
      totalKeys: 4,
      translatedKeys: 2,
    }),
  );
  expect(JSON.parse(result.glossary)).toEqual(glossary);
  expect(records(result.translationMemory)).toEqual([cached, entry("reused", "Shared", "Partage")]);
  expect(result.translationMemory + result.meta).not.toContain("private-");
});

it("keeps aliases independent, source order, and the last valid write", () => {
  const abcHash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const grouped = entry("group.second", "Stored text is not the freshness authority", "Partagé", {
    segment_ids: ["group.first", "removed", "changed"],
    text_hash: abcHash,
  });
  const rows = memory(
    grouped,
    entry("group.first", "abc", "Dernier", { text_hash: abcHash }),
    entry("group.first", "old", "Obsolète"),
  );
  const materialize = (source: Record<string, string>, entries = rows) =>
    values.materializePreparedControlUiLocaleCatalog(
      values.prepareControlUiCatalogSource(strings(source)),
      entries,
    );
  const catalog = materialize({
    "group.first": "abc",
    "group.second": "abc",
    changed: "Changed",
    unused: "abc",
  });
  expect(catalog).toEqual({ group: { first: "Dernier", second: "Partagé" } });
  expect([...sync.flattenTranslations(catalog)]).toEqual([
    ["group.first", "Dernier"],
    ["group.second", "Partagé"],
  ]);
  expect(materialize({ "group.first": "abc" }, new Map())).toEqual({});
  expect(materialize({ "group.first": "abc" }, memory(grouped))).toEqual({
    group: { first: "Partagé" },
  });
});

it("refreshes recorded fallback copy when forced without a provider", () => {
  const p = plan(
    { title: "New English" },
    {
      existingFlat: strings({ title: "Old English" }),
      force: true,
      previousMeta: meta({ fallbackKeys: ["title"] }),
    },
  );
  expect(p.newFallbackCount).toBe(0);
  const result = render(p);
  expect(result.nextFlat.get("title")).toBe("New English");
  expect(JSON.parse(result.meta).fallbackKeys).toEqual(["title"]);
});

it("preserves generatedAt when semantic metadata is unchanged", () => {
  const p = plan(
    { title: "Titre" },
    {
      existingFlat: strings({ title: "Titre" }),
      sourceHash: "same",
      previousMeta: meta({ sourceHash: "same", totalKeys: 1, translatedKeys: 1 }),
    },
  );
  expect(JSON.parse(render(p).meta).generatedAt).toBe(date);
});
