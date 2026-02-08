import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  approvePlugin,
  createPinStore,
  getPin,
  pinPlugin,
  savePinStore,
  unpinPlugin,
  verifyPlugin,
  type ManifestSnapshot,
  type PinStore,
} from "./integrity.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MANIFEST: ManifestSnapshot = {
  id: "test-plugin",
  version: "1.0.0",
  tools: [
    { name: "greet", description: "Say hello", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
    { name: "farewell", description: "Say goodbye", inputSchema: { type: "object" } },
  ],
};

let tmpDir: string;
let store: PinStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tofu-test-"));
  store = createPinStore(path.join(tmpDir, "pins.json"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verifyPlugin", () => {
  it("auto-pins and trusts on first use", () => {
    const report = verifyPlugin(store, MANIFEST);
    expect(report.trusted).toBe(true);
    expect(report.firstUse).toBe(true);
    expect(report.changes).toHaveLength(0);
    expect(store.pins.size).toBe(1);
  });

  it("trusts unchanged manifest", () => {
    pinPlugin(store, MANIFEST);
    const report = verifyPlugin(store, MANIFEST);
    expect(report.trusted).toBe(true);
    expect(report.firstUse).toBe(false);
    expect(report.changes).toHaveLength(0);
  });

  it("detects modified tool description", () => {
    pinPlugin(store, MANIFEST);
    const modified: ManifestSnapshot = {
      ...MANIFEST,
      tools: [
        { name: "greet", description: "CHANGED", inputSchema: MANIFEST.tools[0].inputSchema },
        MANIFEST.tools[1],
      ],
    };
    const report = verifyPlugin(store, modified);
    expect(report.trusted).toBe(false);
    expect(report.changes).toContainEqual({ type: "tool_modified", toolName: "greet" });
  });

  it("detects added tool", () => {
    pinPlugin(store, MANIFEST);
    const extended: ManifestSnapshot = {
      ...MANIFEST,
      tools: [...MANIFEST.tools, { name: "spy", description: "Secret" }],
    };
    const report = verifyPlugin(store, extended);
    expect(report.trusted).toBe(false);
    expect(report.changes).toContainEqual({ type: "tool_added", toolName: "spy" });
  });

  it("detects removed tool", () => {
    pinPlugin(store, MANIFEST);
    const reduced: ManifestSnapshot = {
      ...MANIFEST,
      tools: [MANIFEST.tools[0]],
    };
    const report = verifyPlugin(store, reduced);
    expect(report.trusted).toBe(false);
    expect(report.changes).toContainEqual({ type: "tool_removed", toolName: "farewell" });
  });

  it("detects version change", () => {
    pinPlugin(store, MANIFEST);
    const bumped: ManifestSnapshot = { ...MANIFEST, version: "2.0.0" };
    const report = verifyPlugin(store, bumped);
    expect(report.trusted).toBe(false);
    expect(report.changes).toContainEqual({
      type: "version_changed",
      from: "1.0.0",
      to: "2.0.0",
    });
  });

  it("detects multiple changes at once", () => {
    pinPlugin(store, MANIFEST);
    const changed: ManifestSnapshot = {
      id: "test-plugin",
      version: "2.0.0",
      tools: [
        { name: "greet", description: "CHANGED" },
        { name: "new-tool", description: "Added" },
      ],
    };
    const report = verifyPlugin(store, changed);
    expect(report.trusted).toBe(false);
    expect(report.changes.length).toBeGreaterThanOrEqual(3);
  });
});

describe("approvePlugin", () => {
  it("re-pins after approval", () => {
    pinPlugin(store, MANIFEST);
    const updated: ManifestSnapshot = { ...MANIFEST, version: "2.0.0" };
    const report1 = verifyPlugin(store, updated);
    expect(report1.trusted).toBe(false);

    approvePlugin(store, updated);
    const report2 = verifyPlugin(store, updated);
    expect(report2.trusted).toBe(true);
  });
});

describe("unpinPlugin", () => {
  it("removes pin", () => {
    pinPlugin(store, MANIFEST);
    expect(unpinPlugin(store, "test-plugin")).toBe(true);
    expect(store.pins.size).toBe(0);
  });

  it("returns false for unknown plugin", () => {
    expect(unpinPlugin(store, "unknown")).toBe(false);
  });
});

describe("getPin", () => {
  it("returns pin for known plugin", () => {
    pinPlugin(store, MANIFEST);
    const pin = getPin(store, "test-plugin");
    expect(pin).toBeDefined();
    expect(pin!.pluginId).toBe("test-plugin");
    expect(pin!.manifestHash).toBeTruthy();
  });

  it("returns undefined for unknown plugin", () => {
    expect(getPin(store, "unknown")).toBeUndefined();
  });
});

describe("persistence", () => {
  it("saves and loads pins from file", () => {
    pinPlugin(store, MANIFEST);
    savePinStore(store);

    const loaded = createPinStore(store.filePath);
    expect(loaded.pins.size).toBe(1);

    const report = verifyPlugin(loaded, MANIFEST);
    expect(report.trusted).toBe(true);
    expect(report.firstUse).toBe(false);
  });

  it("handles corrupted pin file gracefully", () => {
    const badPath = path.join(tmpDir, "bad-pins.json");
    fs.writeFileSync(badPath, "NOT JSON!!!");
    const loaded = createPinStore(badPath);
    expect(loaded.pins.size).toBe(0);
  });

  it("handles missing pin file gracefully", () => {
    const missingPath = path.join(tmpDir, "nope.json");
    const loaded = createPinStore(missingPath);
    expect(loaded.pins.size).toBe(0);
  });
});

describe("tool order independence", () => {
  it("same tools in different order produce same hash", () => {
    const reversed: ManifestSnapshot = {
      ...MANIFEST,
      tools: [...MANIFEST.tools].reverse(),
    };
    pinPlugin(store, MANIFEST);
    const report = verifyPlugin(store, reversed);
    expect(report.trusted).toBe(true);
  });
});

describe("canonical JSON hashing", () => {
  it("schemas with different key order produce same hash", () => {
    const manifest1: ManifestSnapshot = {
      id: "key-order-test",
      version: "1.0.0",
      tools: [{ name: "tool", description: "desc", inputSchema: { type: "object", minLength: 1, properties: { name: { type: "string" } } } }],
    };
    const manifest2: ManifestSnapshot = {
      id: "key-order-test",
      version: "1.0.0",
      tools: [{ name: "tool", description: "desc", inputSchema: { properties: { name: { type: "string" } }, minLength: 1, type: "object" } }],
    };
    pinPlugin(store, manifest1);
    const report = verifyPlugin(store, manifest2);
    expect(report.trusted).toBe(true);
  });

  it("deeply nested schemas with reordered keys produce same hash", () => {
    const schema1 = { a: { c: 3, b: 2 }, d: [1, 2, { f: 6, e: 5 }] };
    const schema2 = { d: [1, 2, { e: 5, f: 6 }], a: { b: 2, c: 3 } };
    const m1: ManifestSnapshot = { id: "deep", version: "1.0.0", tools: [{ name: "t", inputSchema: schema1 }] };
    const m2: ManifestSnapshot = { id: "deep", version: "1.0.0", tools: [{ name: "t", inputSchema: schema2 }] };
    pinPlugin(store, m1);
    expect(verifyPlugin(store, m2).trusted).toBe(true);
  });
});

describe("duplicate tool name validation", () => {
  it("throws on duplicate tool names in manifest", () => {
    const duped: ManifestSnapshot = {
      id: "dupe-test",
      version: "1.0.0",
      tools: [
        { name: "sameName", description: "first" },
        { name: "sameName", description: "second" },
      ],
    };
    expect(() => pinPlugin(store, duped)).toThrow(/duplicate tool name/i);
  });

  it("allows manifests with unique tool names", () => {
    const valid: ManifestSnapshot = {
      id: "unique-test",
      version: "1.0.0",
      tools: [
        { name: "alpha", description: "first" },
        { name: "beta", description: "second" },
      ],
    };
    expect(() => pinPlugin(store, valid)).not.toThrow();
  });
});
