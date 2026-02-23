import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadJsonFile, saveJsonFile } from "./json-file.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function filePath(name: string): string {
  return path.join(tmpDir, name);
}

// ---------------------------------------------------------------------------
// loadJsonFile
// ---------------------------------------------------------------------------

describe("loadJsonFile", () => {
  it("returns undefined for a non-existent file", () => {
    expect(loadJsonFile(filePath("does-not-exist.json"))).toBeUndefined();
  });

  it("parses a valid JSON file", () => {
    const p = filePath("valid.json");
    fs.writeFileSync(p, JSON.stringify({ hello: "world" }));
    expect(loadJsonFile(p)).toEqual({ hello: "world" });
  });

  it("returns undefined for an empty file", () => {
    const p = filePath("empty.json");
    fs.writeFileSync(p, "");
    expect(loadJsonFile(p)).toBeUndefined();
  });

  it("returns undefined for a whitespace-only file", () => {
    const p = filePath("spaces.json");
    fs.writeFileSync(p, "   \n  ");
    expect(loadJsonFile(p)).toBeUndefined();
  });

  it("returns undefined for corrupt JSON", () => {
    const p = filePath("corrupt.json");
    fs.writeFileSync(p, '{"truncated":');
    expect(loadJsonFile(p)).toBeUndefined();
  });

  it("falls back to .bak when primary is corrupt", () => {
    const p = filePath("auth.json");
    const bak = `${p}.bak`;
    fs.writeFileSync(p, "CORRUPT");
    fs.writeFileSync(bak, JSON.stringify({ version: 1, profiles: { "ollama:local": {} } }));
    const result = loadJsonFile(p);
    expect(result).toEqual({ version: 1, profiles: { "ollama:local": {} } });
  });

  it("falls back to .bak when primary is empty (crash scenario)", () => {
    const p = filePath("auth.json");
    const bak = `${p}.bak`;
    fs.writeFileSync(p, "");
    fs.writeFileSync(bak, JSON.stringify({ version: 1, profiles: { "ollama:local": {} } }));
    const result = loadJsonFile(p);
    expect(result).toEqual({ version: 1, profiles: { "ollama:local": {} } });
  });

  it("does NOT write backup data back to the primary file (avoids lock bypass)", () => {
    const p = filePath("auth.json");
    const bak = `${p}.bak`;
    const data = { version: 1, profiles: { "test:default": {} } };
    fs.writeFileSync(p, "CORRUPT");
    fs.writeFileSync(bak, JSON.stringify(data));

    const result = loadJsonFile(p);
    expect(result).toEqual(data);

    // Primary must still contain the original corrupt content — loadJsonFile
    // intentionally does NOT restore the backup to the primary file because
    // callers use withFileLock; a bare writeFileSync here would race.
    expect(fs.readFileSync(p, "utf8")).toBe("CORRUPT");
  });

  it("returns undefined when both primary and backup are missing", () => {
    expect(loadJsonFile(filePath("neither.json"))).toBeUndefined();
  });

  it("returns undefined when both primary and backup are corrupt", () => {
    const p = filePath("both-bad.json");
    fs.writeFileSync(p, "BAD");
    fs.writeFileSync(`${p}.bak`, "ALSO BAD");
    expect(loadJsonFile(p)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// saveJsonFile
// ---------------------------------------------------------------------------

describe("saveJsonFile", () => {
  it("creates a new JSON file", () => {
    const p = filePath("new.json");
    saveJsonFile(p, { key: "value" });
    const raw = fs.readFileSync(p, "utf8");
    expect(JSON.parse(raw)).toEqual({ key: "value" });
  });

  it("creates parent directories if needed", () => {
    const p = path.join(tmpDir, "nested", "deep", "file.json");
    saveJsonFile(p, { nested: true });
    expect(JSON.parse(fs.readFileSync(p, "utf8"))).toEqual({ nested: true });
  });

  it("creates a .bak backup of the previous file", () => {
    const p = filePath("backup-test.json");
    saveJsonFile(p, { version: 1 });
    saveJsonFile(p, { version: 2 });
    const bak = JSON.parse(fs.readFileSync(`${p}.bak`, "utf8"));
    expect(bak).toEqual({ version: 1 });
    const current = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(current).toEqual({ version: 2 });
  });

  it("uses atomic rename (no .tmp file left behind)", () => {
    const p = filePath("atomic.json");
    saveJsonFile(p, { atomic: true });
    expect(fs.existsSync(`${p}.tmp`)).toBe(false);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("preserves data integrity across multiple rapid writes", () => {
    const p = filePath("rapid.json");
    for (let i = 0; i < 20; i++) {
      saveJsonFile(p, { iteration: i });
    }
    const final = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(final).toEqual({ iteration: 19 });
    // Backup should be the second-to-last write.
    const bak = JSON.parse(fs.readFileSync(`${p}.bak`, "utf8"));
    expect(bak).toEqual({ iteration: 18 });
  });
});

// ---------------------------------------------------------------------------
// Integration: save + load round-trip
// ---------------------------------------------------------------------------

describe("save + load round-trip", () => {
  it("round-trips complex auth-profile-like data", () => {
    const p = filePath("auth-profiles.json");
    const store = {
      version: 1,
      profiles: {
        "ollama:local": { type: "api_key", provider: "ollama", key: "" },
        "openrouter:default": { type: "api_key", provider: "openrouter", key: "sk-or-xxx" },
      },
      order: { ollama: ["ollama:local"] },
      lastGood: { ollama: "ollama:local" },
    };
    saveJsonFile(p, store);
    expect(loadJsonFile(p)).toEqual(store);
  });

  it("recovers after simulated crash (empty primary + valid backup)", () => {
    const p = filePath("crash-test.json");
    const goodData = {
      version: 1,
      profiles: { "ollama:local": { type: "api_key", provider: "ollama" } },
    };

    // Simulate: good save, then crash leaves file empty.
    saveJsonFile(p, goodData);
    fs.writeFileSync(p, ""); // Simulate truncation from crash.

    // loadJsonFile should recover from .bak.
    const recovered = loadJsonFile(p);
    expect(recovered).toEqual(goodData);
  });
});
