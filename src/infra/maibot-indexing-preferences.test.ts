import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAIBOT_INDEXING_PREFS_SCHEMA_VERSION,
  readMaibotIndexingPreferencesFromWorkspace,
  toMaibotWorkspaceIndexingHelloSnapshot,
} from "./maibot-indexing-preferences.js";

describe("readMaibotIndexingPreferencesFromWorkspace", () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp) {
      fs.rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it("returns missing when file absent", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-maibot-idx-"));
    const res = readMaibotIndexingPreferencesFromWorkspace(tmp);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("missing");
    }
  });

  it("parses a valid Maibot-shaped payload", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-maibot-idx-"));
    const prefsPath = path.join(tmp, ".maibot", "indexing", "preferences.json");
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
    const body = {
      schemaVersion: MAIBOT_INDEXING_PREFS_SCHEMA_VERSION,
      updatedAt: "2026-04-18T12:00:00.000Z",
      preferences: {
        indexNewFolders: true,
        instantGrep: false,
        ignorePatternsRaw: "*.log",
        ignorePatternLines: ["*.log", "node_modules/"],
      },
      effectiveWorkspace: {
        primaryRoot: tmp,
        additionalRoots: [],
        source: "global",
      },
    };
    fs.writeFileSync(prefsPath, JSON.stringify(body), "utf8");

    const res = readMaibotIndexingPreferencesFromWorkspace(tmp);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.preferences.ignorePatternLines).toEqual(["*.log", "node_modules/"]);
      const hello = toMaibotWorkspaceIndexingHelloSnapshot(res.data);
      expect(hello.effectiveWorkspacePrimaryRoot).toBe(tmp);
      expect(hello.ignorePatternLines).toEqual(["*.log", "node_modules/"]);
    }
  });

  it("rejects wrong schemaVersion", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-maibot-idx-"));
    const prefsPath = path.join(tmp, ".maibot", "indexing", "preferences.json");
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
    fs.writeFileSync(
      prefsPath,
      JSON.stringify({
        schemaVersion: 99,
        updatedAt: "x",
        preferences: {
          indexNewFolders: true,
          instantGrep: false,
          ignorePatternsRaw: "",
          ignorePatternLines: [],
        },
        effectiveWorkspace: { primaryRoot: tmp, additionalRoots: [], source: "global" },
      }),
      "utf8",
    );
    const res = readMaibotIndexingPreferencesFromWorkspace(tmp);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("schema_mismatch");
    }
  });
});
