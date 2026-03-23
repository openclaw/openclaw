import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSessionStoreSummary } from "./store-summary.js";

describe("loadSessionStoreSummary", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-summary-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses a valid JSON object with session entries", () => {
    const storePath = path.join(tmpDir, "store.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "session-1": { lastChannel: "telegram", lastTo: "@alice", updatedAt: 1000 },
        "session-2": { lastChannel: "discord" },
      }),
    );
    const result = loadSessionStoreSummary(storePath);
    expect(result["session-1"]).toEqual({
      lastChannel: "telegram",
      lastTo: "@alice",
      updatedAt: 1000,
    });
    expect(result["session-2"]).toEqual({ lastChannel: "discord" });
  });

  it("returns empty object for non-existent file", () => {
    expect(loadSessionStoreSummary(path.join(tmpDir, "missing.json"))).toEqual({});
  });

  it("returns empty object for empty file", () => {
    const storePath = path.join(tmpDir, "empty.json");
    fs.writeFileSync(storePath, "");
    expect(loadSessionStoreSummary(storePath)).toEqual({});
  });

  it("returns empty object for invalid JSON", () => {
    const storePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(storePath, "not json {{{");
    expect(loadSessionStoreSummary(storePath)).toEqual({});
  });

  it("returns empty object when JSON is an array", () => {
    const storePath = path.join(tmpDir, "array.json");
    fs.writeFileSync(storePath, JSON.stringify([1, 2, 3]));
    expect(loadSessionStoreSummary(storePath)).toEqual({});
  });

  it("returns empty object when JSON is a primitive", () => {
    const storePath = path.join(tmpDir, "string.json");
    fs.writeFileSync(storePath, JSON.stringify("hello"));
    expect(loadSessionStoreSummary(storePath)).toEqual({});
  });

  it("returns empty object when JSON is null", () => {
    const storePath = path.join(tmpDir, "null.json");
    fs.writeFileSync(storePath, "null");
    expect(loadSessionStoreSummary(storePath)).toEqual({});
  });
});
