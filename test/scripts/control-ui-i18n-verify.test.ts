import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncControlUiCatalogFallbackBaseline } from "../../scripts/control-ui-i18n-verify.ts";
import type {
  LocaleEntry,
  TranslationMap,
  TranslationMemoryEntry,
} from "../../scripts/lib/control-ui-i18n-sync-plan.ts";

const fixture = vi.hoisted(() => {
  // Tooling shares a serial module cache; load this owner with this file's input mocks.
  vi.resetModules();
  const writes: { path: string; data: string }[] = [];
  return {
    files: new Map<string, string>(),
    paths: new Set<string>(),
    assetsDir: "",
    baselinePath: "",
    writes,
    loadSource: vi.fn<() => TranslationMap>(),
    readSource: vi.fn<() => Promise<string>>(),
  };
});

vi.mock("../../scripts/lib/control-ui-i18n-catalog.ts", () => ({
  loadControlUiSourceCatalog: fixture.loadSource,
  readControlUiSourceCatalog: fixture.readSource,
}));

vi.mock("../../scripts/lib/control-ui-i18n-config.ts", () => ({
  CONTROL_UI_LOCALE_ENTRIES: [
    { locale: "fr", fileName: "fr.ts", exportName: "fr", languageKey: "fr" },
    { locale: "de", fileName: "de.ts", exportName: "de", languageKey: "de" },
  ] satisfies LocaleEntry[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn<typeof actual.existsSync>((file) =>
      typeof file === "string" && fixture.paths.has(file)
        ? fixture.files.has(file)
        : actual.existsSync(file),
    ),
    readFileSync: (
      file: Parameters<typeof actual.readFileSync>[0],
      options?: Parameters<typeof actual.readFileSync>[1] | BufferEncoding | null,
    ) => {
      if (typeof file === "string" && fixture.paths.has(file) && options === "utf8") {
        const content = fixture.files.get(file);
        if (content === undefined) {
          throw new Error("Missing in-memory catalog fixture");
        }
        return content;
      }
      if (typeof options === "string") {
        return actual.readFileSync(file, options);
      }
      if (options === null || options === undefined) {
        return actual.readFileSync(file, options);
      }
      return actual.readFileSync(file, options);
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (
      file: Parameters<typeof actual.readFile>[0],
      options?: Parameters<typeof actual.readFile>[1],
    ) => {
      if (file === fixture.baselinePath && options === "utf8") {
        const content = fixture.files.get(fixture.baselinePath);
        if (content === undefined) {
          throw new Error("Missing in-memory baseline fixture");
        }
        return content;
      }
      if (options === undefined) {
        return actual.readFile(file);
      }
      return actual.readFile(file, options);
    },
    writeFile: vi.fn<typeof actual.writeFile>(async (file, data, options) => {
      if (file === fixture.baselinePath) {
        if (typeof data !== "string" || options !== "utf8") {
          throw new Error("Expected UTF-8 baseline text");
        }
        fixture.files.set(fixture.baselinePath, data);
        fixture.writes.push({ path: fixture.baselinePath, data });
        return;
      }
      return actual.writeFile(file, data, options);
    }),
    mkdir: async (...[dir, options]: Parameters<typeof actual.mkdir>) =>
      dir === fixture.assetsDir ? undefined : actual.mkdir(dir, options),
  };
});

const assetsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../ui/src/i18n/.i18n",
);
const baselinePath = path.join(assetsDir, "catalog-fallbacks.json");
const memoryPath = (locale: string) => path.join(assetsDir, `${locale}.tm.jsonl`);
const abcHash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const writeOptions = { checkOnly: false, write: true };

function row(overrides: Partial<TranslationMemoryEntry> = {}): TranslationMemoryEntry {
  return {
    cache_key: "shared",
    segment_id: "group.first",
    segment_ids: ["group.second", "retired"],
    source_path: "ui/src/i18n/locales/fr.ts",
    src_lang: "en",
    text: "abc",
    text_hash: abcHash,
    tgt_lang: "fr",
    translated: "Partage",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function setMemory(locale: string, rows: readonly TranslationMemoryEntry[]) {
  fixture.files.set(
    memoryPath(locale),
    `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
}

function baseline(fallbacks: Record<string, string[]>, sourceHash = abcHash) {
  return `${JSON.stringify({ fallbacks, sourceHash, version: 1 }, null, 2)}\n`;
}

beforeEach(() => {
  fixture.assetsDir = assetsDir;
  fixture.baselinePath = baselinePath;
  fixture.paths.clear();
  for (const file of [baselinePath, memoryPath("fr"), memoryPath("de")]) {
    fixture.paths.add(file);
  }
  fixture.files.clear();
  fixture.writes.length = 0;
  fixture.readSource.mockResolvedValue("abc");
  fixture.loadSource.mockReturnValue({ group: { first: "abc", second: "abc" }, missing: "abc" });
  setMemory("fr", [
    row(),
    row({ cache_key: "stale", segment_id: "missing", segment_ids: [], text_hash: emptyHash }),
  ]);
  setMemory("de", [row({ segment_ids: [], translated: "Geteilt" })]);
});

afterEach(() => {
  vi.restoreAllMocks();
  fixture.loadSource.mockReset();
  fixture.readSource.mockReset();
  fixture.files.clear();
  fixture.paths.clear();
  fixture.writes.length = 0;
});

describe("syncControlUiCatalogFallbackBaseline", () => {
  it("checks and writes ordered fallback bytes without rewriting a matching baseline", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const expected = baseline({ "group.second": ["de"], missing: ["de", "fr"] });

    await expect(
      syncControlUiCatalogFallbackBaseline({ checkOnly: true, write: true }),
    ).rejects.toThrow("control-ui catalog fallback baseline drift detected.");
    expect(fixture.writes).toEqual([]);
    await syncControlUiCatalogFallbackBaseline(writeOptions);
    expect(fixture.writes).toEqual([{ path: baselinePath, data: expected }]);
    expect(fixture.files.get(baselinePath)).toBe(expected);
    expect(stdout).toHaveBeenCalledWith(
      "control-ui-i18n: catalog: fallback_keys=2 fallback_pairs=3\n",
    );

    fixture.writes.length = 0;
    await syncControlUiCatalogFallbackBaseline(writeOptions);
    await syncControlUiCatalogFallbackBaseline({ checkOnly: true, write: false });
    expect(fixture.writes).toEqual([]);
  });

  it("uses a fresh English snapshot and hashes raw source bytes on every invocation", async () => {
    await syncControlUiCatalogFallbackBaseline(writeOptions);
    fixture.loadSource.mockReturnValue({ group: { first: "", second: "abc" }, missing: "abc" });
    fixture.readSource.mockResolvedValue("");
    await syncControlUiCatalogFallbackBaseline(writeOptions);
    expect(fixture.files.get(baselinePath)).toBe(
      baseline(
        { "group.first": ["de", "fr"], "group.second": ["de"], missing: ["de", "fr"] },
        emptyHash,
      ),
    );

    fixture.readSource.mockResolvedValue("abc\n");
    await syncControlUiCatalogFallbackBaseline(writeOptions);
    expect(fixture.files.get(baselinePath)).toBe(
      baseline(
        { "group.first": ["de", "fr"], "group.second": ["de"], missing: ["de", "fr"] },
        "edeaaff3f1774ad2888673770c6d64097e391bc362d7d6fb34982ddf0efd18cb",
      ),
    );
  });

  it("keeps an empty first memory as fallbacks and rejects missing hashes from parsed rows", async () => {
    fixture.files.set(memoryPath("fr"), "\n");
    fixture.files.set(
      memoryPath("de"),
      [
        JSON.stringify(row({ segment_ids: [], translated: "Geteilt" })),
        '{"cache_key":"no-hash","segment_id":"missing","segment_ids":["retired"],"translated":"Invalid"}',
        '{"cache_key":"retired-no-hash","segment_id":"retired","translated":"Invalid"}',
      ].join("\n"),
    );
    await syncControlUiCatalogFallbackBaseline(writeOptions);
    expect(fixture.files.get(baselinePath)).toBe(
      baseline({
        "group.first": ["fr"],
        "group.second": ["de", "fr"],
        missing: ["de", "fr"],
      }),
    );
  });

  it.each([false, true])(
    "preserves the first missing/malformed memory error (allowCatalogDrift=%s)",
    async (allowCatalogDrift) => {
      fixture.files.delete(memoryPath("fr"));
      fixture.files.set(memoryPath("de"), "{");
      await expect(
        syncControlUiCatalogFallbackBaseline({ ...writeOptions, allowCatalogDrift }),
      ).rejects.toThrow("ui/src/i18n/.i18n/fr.tm.jsonl does not contain fr translations");

      fixture.files.set(memoryPath("fr"), "{");
      fixture.files.delete(memoryPath("de"));
      await expect(
        syncControlUiCatalogFallbackBaseline({ ...writeOptions, allowCatalogDrift }),
      ).rejects.toBeInstanceOf(SyntaxError);
      expect(fixture.writes).toEqual([]);
    },
  );

  it("only tolerates analyzer drift during scoped sync", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    fixture.loadSource.mockReturnValue({ greeting: "Hello {count}" });
    setMemory("fr", [
      row({
        segment_id: "greeting",
        segment_ids: [],
        text_hash: createHash("sha256").update("Hello {count}", "utf8").digest("hex"),
        translated: "Bonjour",
      }),
    ]);
    setMemory("de", []);

    await expect(syncControlUiCatalogFallbackBaseline(writeOptions)).rejects.toThrow(
      "fr:greeting expected {count} got {}",
    );
    expect(fixture.writes).toEqual([]);
    await syncControlUiCatalogFallbackBaseline({ ...writeOptions, allowCatalogDrift: true });
    expect(fixture.files.get(baselinePath)).toBe(baseline({ greeting: ["de"] }));
    expect(stdout).toHaveBeenCalledWith(
      "control-ui-i18n: catalog: tolerated_errors=1 during scoped sync\n",
    );
  });

  it.each([false, true])(
    "rejects terminology errors before later locale errors (allowCatalogDrift=%s)",
    async (allowCatalogDrift) => {
      fixture.loadSource.mockReturnValue({ sessionsView: { subagentPrefix: "abc" } });
      setMemory("fr", [
        row({ segment_id: "sessionsView.subagentPrefix", segment_ids: [], translated: "Cron" }),
      ]);
      fixture.files.set(memoryPath("de"), "{");
      await expect(
        syncControlUiCatalogFallbackBaseline({ ...writeOptions, allowCatalogDrift }),
      ).rejects.toThrow("fr: sessionsView.subagentPrefix");
      expect(fixture.writes).toEqual([]);
    },
  );
});
