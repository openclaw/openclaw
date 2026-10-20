import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  resolveSessionEntryResetFreshness,
  resolveSessionEntryResetFreshnessAsync,
} from "./entry-freshness.js";
import {
  appendTranscriptEvent,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-01-02T12:00:00Z");
const freshEntry = (sessionId: string, overrides: Partial<SessionEntry> = {}) => ({
  sessionId,
  updatedAt: now,
  sessionStartedAt: now,
  lastInteractionAt: now,
  ...overrides,
});

describe("resolveSessionEntryResetFreshness", () => {
  let tempDirs: string[] = [];
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDirs = [];
    tempDir = makeTempDir(tempDirs, "openclaw-session-entry-freshness-");
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeStateDatabaseForTest();
    cleanupTempDirs(tempDirs);
  });

  const params = (sessionKey: string) => ({
    sessionKey,
    storePath,
    sessionCfg: {},
    resetType: "thread" as const,
    now,
  });

  it.each([resolveSessionEntryResetFreshness, resolveSessionEntryResetFreshnessAsync])(
    "returns missing state with a resolved reset policy for absent entries (%s)",
    async (resolveFreshness) => {
      const result = await resolveFreshness(params("agent:main:missing:thread:100.000"));

      expect(result).toMatchObject({
        state: "missing",
        entry: undefined,
        freshness: undefined,
        resetType: "thread",
        resetPolicy: {
          mode: "none",
          atHour: 4,
        },
      });
    },
  );

  it("uses the configured default agent for an unqualified session key", async () => {
    const sessionKey = "global";
    await upsertSessionEntryCore(
      { agentId: "ops", defaultAgentId: "ops", sessionKey, storePath },
      freshEntry("session-global-ops"),
    );

    const result = resolveSessionEntryResetFreshness({
      ...params(sessionKey),
      defaultAgentId: "ops",
      resetType: "direct",
    });

    expect(result).toMatchObject({ state: "fresh", entry: { sessionId: "session-global-ops" } });
  });

  it("keeps provider-owned sessions fresh when reset policy is implicit", async () => {
    const sessionKey = "agent:main:main:thread:provider-owned";
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      freshEntry("session-provider-owned", {
        sessionStartedAt: now - 2 * DAY_MS,
        lastInteractionAt: now - 2 * DAY_MS,
        providerOverride: "claude-cli",
        cliSessionBindings: {
          "claude-cli": { sessionId: "cli-session-provider-owned" },
        },
      }),
    );

    const result = resolveSessionEntryResetFreshness(params(sessionKey));

    expect(result).toMatchObject({ state: "fresh", freshness: { fresh: true } });
  });

  it("resolves the store path from session config", async () => {
    const sessionKey = "agent:main:main:thread:configured-store";
    const configuredStorePath = path.join(tempDir, "configured-sessions.json");
    await upsertSessionEntryCore(
      { sessionKey, storePath: configuredStorePath },
      freshEntry("session-configured-store", { lastInteractionAt: now - 60 * 60 * 1000 }),
    );

    const result = resolveSessionEntryResetFreshness({
      sessionKey,
      sessionCfg: { store: configuredStorePath, reset: { mode: "idle", idleMinutes: 30 } },
      resetType: "thread",
      now,
    });

    expect(result).toMatchObject({
      state: "stale",
      entry: { sessionId: "session-configured-store" },
      resetPolicy: { mode: "idle", idleMinutes: 30 },
      freshness: { fresh: false, staleReason: "idle" },
    });
  });

  it.each([resolveSessionEntryResetFreshness, resolveSessionEntryResetFreshnessAsync])(
    "uses the SQLite transcript header when lifecycle metadata is missing (%s)",
    async (resolveFreshness) => {
      const sessionKey = "agent:main:main:thread:header";
      const sessionId = "session-header-fallback";
      const headerTimestamp = new Date(now - 2 * DAY_MS).toISOString();
      const target = { agentId: "main", sessionId, sessionKey, storePath };
      const entry = await replaceSessionEntry(target, { sessionId, updatedAt: now });
      expect(entry?.sessionStartedAt).toBeUndefined();
      await appendTranscriptEvent(target, {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: headerTimestamp,
        cwd: tempDir,
      });

      const result = await resolveFreshness({
        ...params(sessionKey),
        sessionCfg: { reset: { mode: "daily" } },
      });

      expect(result).toMatchObject({
        state: "stale",
        lifecycleTimestamps: { sessionStartedAt: Date.parse(headerTimestamp) },
        freshness: { fresh: false, staleReason: "daily" },
      });
    },
  );
});
