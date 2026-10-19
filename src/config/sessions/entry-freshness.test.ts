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

const DAY_MS = 24 * 60 * 60 * 1000;

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

  it.each([resolveSessionEntryResetFreshness, resolveSessionEntryResetFreshnessAsync])(
    "returns missing state with a resolved reset policy for absent entries (%s)",
    async (resolveFreshness) => {
      const result = await resolveFreshness({
        sessionKey: "agent:main:missing:thread:100.000",
        storePath,
        sessionCfg: {},
        resetType: "thread",
        now: new Date("2026-01-02T12:00:00Z").getTime(),
      });

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
    const now = new Date("2026-01-02T12:00:00Z").getTime();
    await upsertSessionEntryCore(
      { agentId: "ops", defaultAgentId: "ops", sessionKey, storePath },
      {
        sessionId: "session-global-ops",
        updatedAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now,
      },
    );

    const result = resolveSessionEntryResetFreshness({
      defaultAgentId: "ops",
      sessionKey,
      storePath,
      sessionCfg: {},
      resetType: "direct",
      now,
    });

    expect(result.state).toBe("fresh");
    expect(result.entry?.sessionId).toBe("session-global-ops");
  });

  it("keeps provider-owned sessions fresh when reset policy is implicit", async () => {
    const sessionKey = "agent:main:main:thread:provider-owned";
    const now = new Date("2026-01-02T12:00:00Z").getTime();
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId: "session-provider-owned",
        updatedAt: now,
        sessionStartedAt: now - 2 * DAY_MS,
        lastInteractionAt: now - 2 * DAY_MS,
        providerOverride: "claude-cli",
        cliSessionBindings: {
          "claude-cli": { sessionId: "cli-session-provider-owned" },
        },
      },
    );

    const result = resolveSessionEntryResetFreshness({
      sessionKey,
      storePath,
      sessionCfg: {},
      resetType: "thread",
      now,
    });

    expect(result.state).toBe("fresh");
    expect(result.freshness).toMatchObject({ fresh: true });
  });

  it("resolves the store path from session config", async () => {
    const sessionKey = "agent:main:main:thread:configured-store";
    const now = new Date("2026-01-02T12:00:00Z").getTime();
    const configuredStorePath = path.join(tempDir, "configured-sessions.json");
    await upsertSessionEntryCore(
      { sessionKey, storePath: configuredStorePath },
      {
        sessionId: "session-configured-store",
        updatedAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now - 60 * 60 * 1000,
      },
    );

    const result = resolveSessionEntryResetFreshness({
      sessionKey,
      sessionCfg: { store: configuredStorePath, reset: { mode: "idle", idleMinutes: 30 } },
      resetType: "thread",
      now,
    });

    expect(result.state).toBe("stale");
    expect(result.entry?.sessionId).toBe("session-configured-store");
    expect(result.resetPolicy).toMatchObject({
      mode: "idle",
      idleMinutes: 30,
    });
    expect(result.freshness).toMatchObject({
      fresh: false,
      staleReason: "idle",
    });
  });

  it.each([resolveSessionEntryResetFreshness, resolveSessionEntryResetFreshnessAsync])(
    "uses the SQLite transcript header when lifecycle metadata is missing (%s)",
    async (resolveFreshness) => {
      const sessionKey = "agent:main:main:thread:header";
      const sessionId = "session-header-fallback";
      const now = new Date("2026-01-02T12:00:00Z").getTime();
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
        sessionKey,
        storePath,
        sessionCfg: { reset: { mode: "daily" } },
        resetType: "thread",
        now,
      });

      expect(result.state).toBe("stale");
      expect(result.lifecycleTimestamps.sessionStartedAt).toBe(Date.parse(headerTimestamp));
      expect(result.freshness).toMatchObject({ fresh: false, staleReason: "daily" });
    },
  );
});
