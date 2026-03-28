import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearConfigCache,
  clearResolvedConfigSourceStatFingerprintSyncCacheForTest,
  collectResolvedConfigSourceStatFingerprintSync,
  loadConfig,
  resetConfigStatFingerprintAtLastLoadForTest,
} from "../config/config.js";
import { buildSessionsListParamsKey } from "../shared/session-types.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { SessionsListResult } from "./session-utils.types.js";
import {
  clearSessionsListResultCacheForTest,
  isSessionsListResultCacheEligible,
  tryReadSessionsListResultCache,
  writeSessionsListResultCache,
} from "./sessions-list-result-cache.js";

afterEach(() => {
  clearConfigCache();
  clearResolvedConfigSourceStatFingerprintSyncCacheForTest();
  clearSessionsListResultCacheForTest();
  resetConfigStatFingerprintAtLastLoadForTest();
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

describe("sessions list result cache immutability", () => {
  it("does not expose cached references that can be mutated by callers", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-list-result-cache-"));
    const sessionsPath = path.join(tmpDir, "sessions.json");

    try {
      await withEnvAsync(
        {
          OPENCLAW_SESSIONS_LIST_RESULT_CACHE_TTL_MS: "1000",
        },
        async () => {
          const listParams = { includeGlobal: true, includeUnknown: true };
          const cfg = loadConfig();
          const originalSessions = [
            { sessionId: "sess-1", path: sessionsPath },
          ] as unknown as SessionsListResult["sessions"];

          writeSessionsListResultCache({
            cfg,
            listParams,
            hash: "hash-1",
            result: {
              ts: 1_690_000_000_000,
              path: sessionsPath,
              count: 1,
              defaults: {
                modelProvider: null,
                model: null,
                contextTokens: 1234,
              },
              sessions: originalSessions,
            },
          });

          const first = tryReadSessionsListResultCache({ cfg, listParams });
          expect(first).not.toBeNull();
          if (!first) {
            return;
          }

          first.defaults.model = "mutated-model";
          const firstSessions = first.sessions as Array<{ [k: string]: unknown }>;
          firstSessions[0].title = "mutated-session";
          firstSessions.push({ sessionId: "sess-2", title: "poisoned" });

          const second = tryReadSessionsListResultCache({ cfg, listParams });
          expect(second).not.toBeNull();
          expect(second).toMatchObject({
            hash: "hash-1",
            path: sessionsPath,
            count: 1,
            defaults: {
              modelProvider: null,
              model: null,
              contextTokens: 1234,
            },
          });

          const secondSessions = second!.sessions as Array<{ [k: string]: unknown }>;
          expect(secondSessions).toHaveLength(1);
          expect(secondSessions[0]).toMatchObject({ sessionId: "sess-1" });
          expect(secondSessions[0]).not.toHaveProperty("title");
        },
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

  it("recomputes include fingerprint after parse failure and root-stat reuse", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-cache-cfg-retry-"));
    const rootPath = path.join(dir, "root.json5");
    const includePath = path.join(dir, "b.json5");
    const invalidRoot = `{"$include":"a.json5"}x`;
    const validRoot = `{"$include":"b.json5"} `;

    fs.writeFileSync(rootPath, invalidRoot, "utf-8");
    fs.writeFileSync(includePath, '{ "gateway": { "port": 1 } }', "utf-8");

    const initialStat = fs.statSync(rootPath);
    const failedFp = collectResolvedConfigSourceStatFingerprintSync({
      configPath: rootPath,
      homedir: () => os.homedir(),
    });

    fs.writeFileSync(rootPath, validRoot, "utf-8");
    fs.utimesSync(rootPath, initialStat.atime, initialStat.mtime);
    const recoveredFp = collectResolvedConfigSourceStatFingerprintSync({
      configPath: rootPath,
      homedir: () => os.homedir(),
    });

    expect(recoveredFp).not.toBe(failedFp);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("recomputes include fingerprint after include-resolution failure and root-stat reuse", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-cache-cfg-include-fail-"));
    const rootPath = path.join(dir, "root.json5");
    const includePath = path.join(dir, "a.json5");

    fs.writeFileSync(rootPath, '{ "$include": "./a.json5" }', "utf-8");

    const failedFp = collectResolvedConfigSourceStatFingerprintSync({
      configPath: rootPath,
      homedir: () => os.homedir(),
    });

    fs.writeFileSync(includePath, '{ "gateway": { "port": 1 } }', "utf-8");

    const recoveredFp = collectResolvedConfigSourceStatFingerprintSync({
      configPath: rootPath,
      homedir: () => os.homedir(),
    });

    expect(recoveredFp).not.toBe(failedFp);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not serve stale cached rows after config file changes and loadConfig catches up", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-cache-toctou-"));
    const configPath = path.join(dir, "openclaw.json");
    const stateDir = path.join(dir, "state");
    const sessionsPath = path.join(stateDir, "sessions.json");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, "{}\n", "utf-8");

    try {
      await withEnvAsync(
        {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
          // Long config cache so loadConfig returns stale cfg after file edit.
          OPENCLAW_CONFIG_CACHE_MS: "5000",
          OPENCLAW_SESSIONS_LIST_RESULT_CACHE_TTL_MS: "10000",
          OPENCLAW_DISABLE_CONFIG_CACHE: undefined,
        },
        async () => {
          const listParams = { includeGlobal: true, includeUnknown: true };

          // Load config — sets cfgFpAtLastLoad to the current stat fingerprint.
          const cfg1 = loadConfig();

          // Edit the config file — stat fingerprint advances on disk.
          fs.writeFileSync(configPath, '{ "gateway": { "port": 9999 } }\n', "utf-8");
          clearResolvedConfigSourceStatFingerprintSyncCacheForTest();

          // Write a cache entry while loadConfig still returns the OLD cfg1.
          // The cache key includes cfgAligned="n" because cfgFp advanced past cfgFpAtLastLoad.
          writeSessionsListResultCache({
            cfg: cfg1,
            listParams,
            hash: "hash-stale",
            result: {
              ts: Date.now(),
              path: sessionsPath,
              count: 1,
              defaults: { modelProvider: null, model: null, contextTokens: 1234 },
              sessions: [],
            },
          });

          // Force config reload (simulates cache expiry) — cfgFpAtLastLoad catches up.
          clearConfigCache();
          const cfg2 = loadConfig();

          // The stale entry was written under cfgAligned="n"; now cfgAligned="y" — cache miss.
          const cached = tryReadSessionsListResultCache({ cfg: cfg2, listParams });
          expect(cached).toBeNull();
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses the sessions.list result cache after the config cache expires when config sources are unchanged", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-cache-hit-"));
    const configPath = path.join(dir, "openclaw.json");
    const stateDir = path.join(dir, "state");
    const sessionsPath = path.join(stateDir, "sessions.json");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, "{}\n", "utf-8");

    try {
      await withEnvAsync(
        {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_CACHE_MS: "25",
          OPENCLAW_SESSIONS_LIST_RESULT_CACHE_TTL_MS: "1000",
          OPENCLAW_DISABLE_CONFIG_CACHE: undefined,
        },
        async () => {
          const listParams = { includeGlobal: true, includeUnknown: true };
          const cfg1 = loadConfig();
          writeSessionsListResultCache({
            cfg: cfg1,
            listParams,
            hash: "hash-1",
            result: {
              ts: Date.now(),
              path: sessionsPath,
              count: 1,
              defaults: {
                modelProvider: null,
                model: null,
                contextTokens: 1234,
              },
              sessions: [],
            },
          });

          await sleep(60);

          const cfg2 = loadConfig();
          expect(cfg2).not.toBe(cfg1);

          const cached = tryReadSessionsListResultCache({ cfg: cfg2, listParams });
          expect(cached).toMatchObject({
            hash: "hash-1",
            path: sessionsPath,
            count: 1,
            defaults: {
              modelProvider: null,
              model: null,
              contextTokens: 1234,
            },
            sessions: [],
          });
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildSessionsListParamsKey", () => {
  it("normalizes overlapping query fields in a stable way", () => {
    const raw = buildSessionsListParamsKey({
      includeGlobal: true,
      includeUnknown: false,
      limit: 7.9,
      label: "  Foo ",
      spawnedBy: "",
      agentId: "AGENT-1",
      search: "  Mixed CASE  ",
    });
    const parsed = JSON.parse(raw);

    expect(parsed).toMatchObject({
      includeGlobal: true,
      includeUnknown: false,
      limit: 7,
      label: "Foo",
      spawnedBy: "",
      agentId: "agent-1",
      search: "mixed case",
    });
    expect("activeMinutes" in parsed).toBe(false);
  });

  it("adds activeMinutes to the key only when requested", () => {
    const withActiveMinutes = JSON.parse(
      buildSessionsListParamsKey(
        { includeGlobal: true, activeMinutes: 42.8 },
        { includeActiveMinutes: true },
      ),
    );
    const withoutActiveMinutes = JSON.parse(
      buildSessionsListParamsKey({ includeGlobal: true, activeMinutes: 42.8 }),
    );

    expect(withActiveMinutes.activeMinutes).toBe(42);
    expect("activeMinutes" in withoutActiveMinutes).toBe(false);
  });
});
