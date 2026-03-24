import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearResolvedConfigSourceStatFingerprintSyncCacheForTest,
  collectResolvedConfigSourceStatFingerprintSync,
} from "../config/config.js";
import { isSessionsListResultCacheEligible } from "./sessions-list-result-cache.js";

afterEach(() => {
  clearResolvedConfigSourceStatFingerprintSyncCacheForTest();
});

describe("isSessionsListResultCacheEligible", () => {
  it("opts out when includeDerivedTitles is true", () => {
    expect(isSessionsListResultCacheEligible({ includeDerivedTitles: true })).toBe(false);
  });

  it("opts out when includeLastMessage is true", () => {
    expect(isSessionsListResultCacheEligible({ includeLastMessage: true })).toBe(false);
  });

  it("opts out when activeMinutes is set", () => {
    expect(isSessionsListResultCacheEligible({ activeMinutes: 30 })).toBe(false);
  });
});

describe("collectResolvedConfigSourceStatFingerprintSync", () => {
  it("changes when only an included file is modified", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-cache-cfg-"));
    const rootPath = path.join(dir, "root.json5");
    const includePath = path.join(dir, "inc.json5");

    fs.writeFileSync(rootPath, '{ "$include": "./inc.json5" }\n', "utf-8");
    fs.writeFileSync(includePath, '{ "gateway": { "port": 1 } }\n', "utf-8");

    const fp1 = collectResolvedConfigSourceStatFingerprintSync({
      configPath: rootPath,
      homedir: () => os.homedir(),
    });

    fs.writeFileSync(includePath, '{ "gateway": { "port": 2 } }\n', "utf-8");

    const fp2 = collectResolvedConfigSourceStatFingerprintSync({
      configPath: rootPath,
      homedir: () => os.homedir(),
    });

    expect(fp2).not.toBe(fp1);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
