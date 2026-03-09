import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MANIFEST_KEY } from "../../compat/legacy-names.js";
import type { OpenClawPackageManifest } from "../../plugins/manifest.js";
import {
  buildChannelUiCatalog,
  getChannelPluginCatalogEntry,
  listChannelPluginCatalogEntries,
} from "./catalog.js";
import type { ChannelMeta } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCatalogEntry(overrides: {
  id: string;
  label?: string;
  npmSpec?: string;
  order?: number;
}): Record<string, unknown> {
  const channel: Record<string, unknown> = {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    selectionLabel: overrides.label ?? overrides.id,
    docsPath: `/channels/${overrides.id}`,
    blurb: "test",
  };
  if (overrides.order !== undefined) {
    channel.order = overrides.order;
  }
  return {
    name: `@test/${overrides.id}`,
    [MANIFEST_KEY]: {
      channel,
      install: { npmSpec: overrides.npmSpec ?? `@test/${overrides.id}` },
    } satisfies OpenClawPackageManifest,
  };
}

function writeCatalog(dir: string, filename: string, payload: unknown): string {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(payload));
  return filePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildChannelUiCatalog", () => {
  it("builds entries, order, labels, detailLabels, systemImages, and byId", () => {
    const plugins: Array<{ id: string; meta: ChannelMeta }> = [
      {
        id: "alpha",
        meta: {
          id: "alpha",
          label: "Alpha",
          selectionLabel: "Alpha",
          detailLabel: "Alpha Detail",
          docsPath: "/channels/alpha",
          blurb: "test",
          systemImage: "bubble.fill",
        },
      },
      {
        id: "beta",
        meta: {
          id: "beta",
          label: "Beta",
          selectionLabel: "Beta Sel",
          docsPath: "/channels/beta",
          blurb: "test",
        },
      },
    ];

    const catalog = buildChannelUiCatalog(plugins);

    expect(catalog.order).toEqual(["alpha", "beta"]);
    expect(catalog.labels).toEqual({ alpha: "Alpha", beta: "Beta" });
    expect(catalog.detailLabels).toEqual({ alpha: "Alpha Detail", beta: "Beta Sel" });
    expect(catalog.systemImages).toEqual({ alpha: "bubble.fill" });
    expect(catalog.byId.alpha?.label).toBe("Alpha");
    expect(catalog.byId.beta?.label).toBe("Beta");
    expect(catalog.entries).toHaveLength(2);
  });

  it("returns empty catalog for no plugins", () => {
    const catalog = buildChannelUiCatalog([]);
    expect(catalog.entries).toEqual([]);
    expect(catalog.order).toEqual([]);
  });
});

describe("external catalog loading", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses catalog with entries array", () => {
    const catalogPath = writeCatalog(tmpDir, "catalog.json", {
      entries: [makeCatalogEntry({ id: "ext-chan", order: 900 })],
    });

    const entries = listChannelPluginCatalogEntries({ catalogPaths: [catalogPath] });
    const found = entries.find((e) => e.id === "ext-chan");
    expect(found).toBeDefined();
    expect(found?.install.npmSpec).toBe("@test/ext-chan");
  });

  it("parses catalog with packages array", () => {
    const catalogPath = writeCatalog(tmpDir, "catalog.json", {
      packages: [makeCatalogEntry({ id: "pkg-chan", order: 901 })],
    });

    const entries = listChannelPluginCatalogEntries({ catalogPaths: [catalogPath] });
    expect(entries.find((e) => e.id === "pkg-chan")).toBeDefined();
  });

  it("parses catalog with plugins array", () => {
    const catalogPath = writeCatalog(tmpDir, "catalog.json", {
      plugins: [makeCatalogEntry({ id: "plg-chan", order: 902 })],
    });

    const entries = listChannelPluginCatalogEntries({ catalogPaths: [catalogPath] });
    expect(entries.find((e) => e.id === "plg-chan")).toBeDefined();
  });

  it("parses catalog as a top-level array", () => {
    const catalogPath = writeCatalog(tmpDir, "catalog.json", [
      makeCatalogEntry({ id: "arr-chan", order: 903 }),
    ]);

    const entries = listChannelPluginCatalogEntries({ catalogPaths: [catalogPath] });
    expect(entries.find((e) => e.id === "arr-chan")).toBeDefined();
  });

  it("ignores non-existent catalog paths", () => {
    const entries = listChannelPluginCatalogEntries({
      catalogPaths: [path.join(tmpDir, "does-not-exist.json")],
    });
    // Should not throw; may still have bundled entries but no crash.
    expect(Array.isArray(entries)).toBe(true);
  });

  it("skips entries missing channel manifest", () => {
    const catalogPath = writeCatalog(tmpDir, "catalog.json", {
      entries: [{ name: "@test/no-channel" }],
    });

    const entries = listChannelPluginCatalogEntries({ catalogPaths: [catalogPath] });
    expect(entries.find((e) => e.id === "no-channel")).toBeUndefined();
  });

  it("skips entries with empty channel id", () => {
    const entry = makeCatalogEntry({ id: "valid" });
    const manifest = entry[MANIFEST_KEY] as OpenClawPackageManifest;
    manifest.channel!.id = "  ";
    const catalogPath = writeCatalog(tmpDir, "catalog.json", { entries: [entry] });

    const entries = listChannelPluginCatalogEntries({ catalogPaths: [catalogPath] });
    expect(entries.find((e) => e.install.npmSpec === "@test/valid")).toBeUndefined();
  });

  it("skips entries with empty label", () => {
    const entry = makeCatalogEntry({ id: "no-label" });
    const manifest = entry[MANIFEST_KEY] as OpenClawPackageManifest;
    manifest.channel!.label = "  ";
    const catalogPath = writeCatalog(tmpDir, "catalog.json", { entries: [entry] });

    const entries = listChannelPluginCatalogEntries({ catalogPaths: [catalogPath] });
    expect(entries.find((e) => e.id === "no-label")).toBeUndefined();
  });

  it("handles malformed JSON catalog files without crashing", () => {
    const catalogPath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(catalogPath, "NOT VALID JSON {{{");

    const entries = listChannelPluginCatalogEntries({ catalogPaths: [catalogPath] });
    expect(entries.find((e) => e.id === "bad")).toBeUndefined();
  });

  it("handles multiple catalog paths", () => {
    const path1 = writeCatalog(tmpDir, "a.json", {
      entries: [makeCatalogEntry({ id: "chan-a", order: 910 })],
    });
    const path2 = writeCatalog(tmpDir, "b.json", {
      entries: [makeCatalogEntry({ id: "chan-b", order: 911 })],
    });

    const entries = listChannelPluginCatalogEntries({ catalogPaths: [path1, path2] });
    expect(entries.find((e) => e.id === "chan-a")).toBeDefined();
    expect(entries.find((e) => e.id === "chan-b")).toBeDefined();
  });

  it("ignores non-record entries in arrays", () => {
    const catalogPath = writeCatalog(tmpDir, "catalog.json", {
      entries: ["string-entry", 42, null, makeCatalogEntry({ id: "valid-mixed", order: 920 })],
    });

    const entries = listChannelPluginCatalogEntries({ catalogPaths: [catalogPath] });
    expect(entries.find((e) => e.id === "valid-mixed")).toBeDefined();
  });

  it("returns empty for non-record, non-array payload", () => {
    const catalogPath = writeCatalog(tmpDir, "catalog.json", "just a string");

    const entries = listChannelPluginCatalogEntries({ catalogPaths: [catalogPath] });
    // Should not crash; no external entries parsed.
    expect(Array.isArray(entries)).toBe(true);
  });
});

describe("getChannelPluginCatalogEntry", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-lookup-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("looks up entry by id", () => {
    const catalogPath = writeCatalog(tmpDir, "catalog.json", {
      entries: [makeCatalogEntry({ id: "lookup-test", order: 800 })],
    });

    const entry = getChannelPluginCatalogEntry("lookup-test", { catalogPaths: [catalogPath] });
    expect(entry?.id).toBe("lookup-test");
  });

  it("returns undefined for unknown id", () => {
    const catalogPath = writeCatalog(tmpDir, "catalog.json", { entries: [] });
    const entry = getChannelPluginCatalogEntry("nonexistent", { catalogPaths: [catalogPath] });
    expect(entry).toBeUndefined();
  });

  it("returns undefined for empty/whitespace id", () => {
    const entry = getChannelPluginCatalogEntry("  ");
    expect(entry).toBeUndefined();
  });

  it("trims the id before lookup", () => {
    const catalogPath = writeCatalog(tmpDir, "catalog.json", {
      entries: [makeCatalogEntry({ id: "trimmed", order: 801 })],
    });

    const entry = getChannelPluginCatalogEntry("  trimmed  ", { catalogPaths: [catalogPath] });
    expect(entry?.id).toBe("trimmed");
  });
});

describe("catalog sorting", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-sort-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sorts entries by order, then label", () => {
    const catalogPath = writeCatalog(tmpDir, "catalog.json", {
      entries: [
        makeCatalogEntry({ id: "z-last", label: "Zebra", order: 10 }),
        makeCatalogEntry({ id: "a-first", label: "Apple", order: 1 }),
        makeCatalogEntry({ id: "b-alpha", label: "Banana" }),
        makeCatalogEntry({ id: "a-alpha", label: "Avocado" }),
      ],
    });

    const entries = listChannelPluginCatalogEntries({ catalogPaths: [catalogPath] });
    const extIds = entries
      .filter((e) => ["z-last", "a-first", "b-alpha", "a-alpha"].includes(e.id))
      .map((e) => e.id);

    // order=1 first, order=10 second, then no-order sorted alphabetically
    expect(extIds).toEqual(["a-first", "z-last", "a-alpha", "b-alpha"]);
  });
});

describe("deduplication priority", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-dedup-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("external catalog entries do not override discovered entries with the same id", () => {
    // External catalog entries get priority 99; discovered entries with
    // origin "bundled" get priority 3, so the discovered one should win.
    const catalogPath = writeCatalog(tmpDir, "catalog.json", {
      entries: [
        makeCatalogEntry({
          id: "msteams",
          label: "External Teams",
          npmSpec: "@test/external-msteams",
        }),
      ],
    });

    const entry = getChannelPluginCatalogEntry("msteams", { catalogPaths: [catalogPath] });
    // The bundled/discovered msteams should win over the external one.
    expect(entry).toBeDefined();
    expect(entry?.install.npmSpec).not.toBe("@test/external-msteams");
  });
});
