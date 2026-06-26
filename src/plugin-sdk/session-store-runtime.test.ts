import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.js";
import * as jsonFiles from "../infra/json-files.js";
import {
  cleanupSessionLifecycleArtifacts,
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  readSessionUpdatedAt,
  resolveSessionEntryFreshness,
  saveSessionStore,
  updateSessionStore,
  updateSessionStoreEntry,
  upsertSessionEntry,
} from "./session-store-runtime.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("session-store-runtime compatibility surface", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-session-store-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps the public session read shape while using accessor-backed exports", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        model: "gpt-5.5",
        sessionId: "session-1",
        updatedAt: 10,
      },
    });

    expect(getSessionEntry({ sessionKey, storePath })).toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: 10,
    });
    expect(readSessionUpdatedAt({ sessionKey, storePath })).toEqual(expect.any(Number));
    expect(listSessionEntries({ storePath })).toEqual([
      {
        sessionKey,
        entry: expect.objectContaining({
          model: "gpt-5.5",
          sessionId: "session-1",
          updatedAt: 10,
        }),
      },
    ]);

    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-1",
        updatedAt: 20,
      },
    });
    expect(getSessionEntry({ sessionKey, storePath })?.model).toBeUndefined();
  });

  it("returns missing state with a resolved reset policy for absent entries", () => {
    const result = resolveSessionEntryFreshness({
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
        mode: "daily",
        atHour: 4,
      },
    });
  });

  it("resolves stale daily freshness from lifecycle timestamps instead of activity", async () => {
    const sessionKey = "agent:main:main:thread:100.000";
    const now = new Date("2026-01-02T12:00:00Z").getTime();
    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-stale-thread",
        updatedAt: now,
        sessionStartedAt: now - 2 * DAY_MS,
        lastInteractionAt: now - 2 * DAY_MS,
      },
    });

    const result = resolveSessionEntryFreshness({
      sessionKey,
      storePath,
      sessionCfg: {},
      resetType: "thread",
      now,
    });

    expect(result.state).toBe("stale");
    expect(result.entry?.sessionId).toBe("session-stale-thread");
    expect(result.resetType).toBe("thread");
    expect(result.freshness).toMatchObject({
      fresh: false,
      staleReason: "daily",
    });
  });

  it("keeps provider-owned sessions fresh when reset policy is implicit", async () => {
    const sessionKey = "agent:main:main:thread:provider-owned";
    const now = new Date("2026-01-02T12:00:00Z").getTime();
    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-provider-owned",
        updatedAt: now,
        sessionStartedAt: now - 2 * DAY_MS,
        lastInteractionAt: now - 2 * DAY_MS,
        providerOverride: "claude-cli",
        cliSessionBindings: {
          "claude-cli": { sessionId: "cli-session-provider-owned" },
        },
      },
    });

    const result = resolveSessionEntryFreshness({
      sessionKey,
      storePath,
      sessionCfg: {},
      resetType: "thread",
      now,
    });

    expect(result.state).toBe("fresh");
    expect(result.freshness).toMatchObject({ fresh: true });
  });

  it("applies configured reset policies to provider-owned sessions", async () => {
    const sessionKey = "agent:main:main:thread:provider-owned-configured";
    const now = new Date("2026-01-02T12:00:00Z").getTime();
    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-provider-owned-configured",
        updatedAt: now,
        sessionStartedAt: now - 2 * DAY_MS,
        lastInteractionAt: now - 2 * DAY_MS,
        providerOverride: "claude-cli",
        cliSessionBindings: {
          "claude-cli": { sessionId: "cli-session-provider-owned-configured" },
        },
      },
    });

    const result = resolveSessionEntryFreshness({
      sessionKey,
      storePath,
      sessionCfg: { reset: { mode: "daily" } },
      resetType: "thread",
      now,
    });

    expect(result.state).toBe("stale");
    expect(result.freshness).toMatchObject({
      fresh: false,
      staleReason: "daily",
    });
  });

  it("resolves fresh daily freshness for active lifecycle timestamps", async () => {
    const sessionKey = "agent:main:main";
    const now = new Date("2026-01-02T12:00:00Z").getTime();
    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-fresh",
        updatedAt: now,
        sessionStartedAt: now - 60_000,
        lastInteractionAt: now - 60_000,
      },
    });

    const result = resolveSessionEntryFreshness({
      sessionKey,
      storePath,
      sessionCfg: {},
      resetType: "direct",
      now,
    });

    expect(result.state).toBe("fresh");
    expect(result.entry?.sessionId).toBe("session-fresh");
    expect(result.resetType).toBe("direct");
    expect(result.freshness).toMatchObject({ fresh: true });
  });

  it("honors reset overrides when resolving entry freshness", async () => {
    const sessionKey = "agent:main:main:thread:idle";
    const now = new Date("2026-01-02T12:00:00Z").getTime();
    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-idle-stale",
        updatedAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now - 60 * 60 * 1000,
      },
    });

    const result = resolveSessionEntryFreshness({
      sessionKey,
      storePath,
      sessionCfg: { reset: { mode: "daily" } },
      resetOverride: { mode: "idle", idleMinutes: 30 },
      resetType: "thread",
      now,
    });

    expect(result.state).toBe("stale");
    expect(result.resetPolicy).toMatchObject({
      mode: "idle",
      idleMinutes: 30,
    });
    expect(result.freshness).toMatchObject({
      fresh: false,
      staleReason: "idle",
    });
  });

  it("uses runtime session config when store path and session config are omitted", async () => {
    const sessionKey = "agent:main:main:thread:runtime-config";
    const runtimeStorePath = path.join(tempDir, "runtime-sessions.json");
    const now = new Date("2026-01-02T12:00:00Z").getTime();
    setRuntimeConfigSnapshot({
      session: {
        store: runtimeStorePath,
        reset: { mode: "idle", idleMinutes: 30 },
      },
    } as OpenClawConfig);
    await upsertSessionEntry({
      sessionKey,
      storePath: runtimeStorePath,
      entry: {
        sessionId: "session-runtime-config",
        updatedAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now - 60 * 60 * 1000,
      },
    });

    const result = resolveSessionEntryFreshness({
      sessionKey,
      resetType: "thread",
      now,
    });

    expect(result.state).toBe("stale");
    expect(result.entry?.sessionId).toBe("session-runtime-config");
    expect(result.resetPolicy).toMatchObject({
      mode: "idle",
      idleMinutes: 30,
    });
    expect(result.freshness).toMatchObject({
      fresh: false,
      staleReason: "idle",
    });
  });

  it("uses transcript header startedAt when entry lifecycle metadata is missing", async () => {
    const sessionKey = "agent:main:main:thread:header";
    const now = new Date("2026-01-02T12:00:00Z").getTime();
    const headerTimestamp = new Date(now - 2 * DAY_MS).toISOString();
    const transcriptPath = path.join(tempDir, "session-header-fallback.jsonl");
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "session",
        id: "session-header-fallback",
        timestamp: headerTimestamp,
      })}\n`,
      "utf-8",
    );
    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionFile: transcriptPath,
        sessionId: "session-header-fallback",
        updatedAt: now,
      },
    });

    const result = resolveSessionEntryFreshness({
      sessionKey,
      storePath,
      sessionCfg: {},
      resetType: "thread",
      now,
    });

    expect(result.state).toBe("stale");
    expect(result.lifecycleTimestamps.sessionStartedAt).toBe(Date.parse(headerTimestamp));
    expect(result.freshness).toMatchObject({
      fresh: false,
      staleReason: "daily",
    });
  });

  it("keeps the public entry mutation signature while delegating to the seam", async () => {
    const sessionKey = "agent:main:main";

    await expect(
      updateSessionStoreEntry({
        sessionKey,
        storePath,
        update: () => ({ model: "gpt-5.5" }),
      }),
    ).resolves.toBeNull();

    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-1",
        updatedAt: 10,
      },
    });

    const beforePatch = getSessionEntry({ sessionKey, storePath });
    await expect(
      patchSessionEntry({
        sessionKey,
        storePath,
        preserveActivity: true,
        update: (_entry, context) => ({
          providerOverride: context.existingEntry ? "openai" : "missing",
          updatedAt: 20,
        }),
      }),
    ).resolves.toMatchObject({
      providerOverride: "openai",
      sessionId: "session-1",
      updatedAt: beforePatch?.updatedAt,
    });

    await expect(
      updateSessionStoreEntry({
        sessionKey,
        storePath,
        update: () => ({ model: "gpt-5.5" }),
      }),
    ).resolves.toMatchObject({
      model: "gpt-5.5",
      providerOverride: "openai",
      sessionId: "session-1",
    });
  });

  it("preserves resolved maintenance settings through entry patches", async () => {
    const staleSessionKey = "agent:main:stale";
    const activeSessionKey = "agent:main:active";
    await saveSessionStore(
      storePath,
      {
        [staleSessionKey]: {
          sessionId: "session-stale",
          updatedAt: 10,
        },
        [activeSessionKey]: {
          sessionId: "session-active",
          updatedAt: 20,
        },
      },
      { skipMaintenance: true },
    );

    await expect(
      patchSessionEntry({
        sessionKey: activeSessionKey,
        storePath,
        maintenanceConfig: {
          mode: "enforce",
          pruneAfterMs: 7 * DAY_MS,
          modelRunPruneAfterMs: DAY_MS,
          maxEntries: 1,
          resetArchiveRetentionMs: 7 * DAY_MS,
          maxDiskBytes: null,
          highWaterBytes: null,
        },
        update: () => ({ model: "gpt-5.5" }),
      }),
    ).resolves.toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-active",
    });

    expect(getSessionEntry({ sessionKey: activeSessionKey, storePath })).toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-active",
    });
    expect(getSessionEntry({ sessionKey: staleSessionKey, storePath })).toBeUndefined();
  });

  it("accepts pre-model-run maintenance configs through entry patches", async () => {
    const staleModelRunKey = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
    const activeSessionKey = "agent:main:active";
    const now = Date.now();
    await saveSessionStore(
      storePath,
      {
        [staleModelRunKey]: {
          sessionId: "session-probe",
          updatedAt: now - 2 * DAY_MS,
        },
        [activeSessionKey]: {
          sessionId: "session-active",
          updatedAt: now,
        },
      },
      { skipMaintenance: true },
    );

    const legacyMaintenanceConfig = {
      mode: "enforce" as const,
      pruneAfterMs: 7 * DAY_MS,
      maxEntries: 500,
      resetArchiveRetentionMs: 7 * DAY_MS,
      maxDiskBytes: null,
      highWaterBytes: null,
    };

    await expect(
      patchSessionEntry({
        sessionKey: activeSessionKey,
        storePath,
        maintenanceConfig: legacyMaintenanceConfig,
        update: () => ({ model: "gpt-5.5" }),
      }),
    ).resolves.toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-active",
    });

    expect(getSessionEntry({ sessionKey: staleModelRunKey, storePath })).toMatchObject({
      sessionId: "session-probe",
    });
  });

  it("keeps deprecated whole-store mutations grouped as one compatibility operation", async () => {
    const firstSessionKey = "agent:main:first";
    const secondSessionKey = "agent:main:second";
    const deletedSessionKey = "agent:main:deleted";
    await saveSessionStore(
      storePath,
      {
        [firstSessionKey]: {
          sessionId: "session-1",
          updatedAt: 10,
        },
        [secondSessionKey]: {
          sessionId: "session-2",
          updatedAt: 10,
        },
        [deletedSessionKey]: {
          sessionId: "session-3",
          updatedAt: 10,
        },
      },
      { skipMaintenance: true },
    );

    await expect(
      updateSessionStore(
        storePath,
        (store) => {
          const first = store[firstSessionKey];
          const second = store[secondSessionKey];
          if (!first || !second) {
            throw new Error("seed session entries missing");
          }
          store[firstSessionKey] = {
            ...first,
            model: "gpt-5.5",
            updatedAt: 20,
          };
          store[secondSessionKey] = {
            ...second,
            providerOverride: "openai",
            updatedAt: 30,
          };
          delete store[deletedSessionKey];
          return "whole-store-updated";
        },
        { skipMaintenance: true },
      ),
    ).resolves.toBe("whole-store-updated");

    expect(getSessionEntry({ sessionKey: firstSessionKey, storePath })).toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: 20,
    });
    expect(getSessionEntry({ sessionKey: secondSessionKey, storePath })).toMatchObject({
      providerOverride: "openai",
      sessionId: "session-2",
      updatedAt: 30,
    });
    expect(getSessionEntry({ sessionKey: deletedSessionKey, storePath })).toBeUndefined();
  });

  it("preserves requireWriteSuccess for critical session entry updates", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-1",
        updatedAt: 10,
      },
    });
    const writeError = Object.assign(new Error("write failed"), { code: "ENOENT" });
    const writeSpy = vi.spyOn(jsonFiles, "writeTextAtomic").mockRejectedValue(writeError);

    try {
      await expect(
        updateSessionStoreEntry({
          sessionKey,
          storePath,
          requireWriteSuccess: true,
          update: () => ({ model: "gpt-5.5" }),
        }),
      ).rejects.toBe(writeError);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("cleans lifecycle artifacts through the accessor-backed SDK wrapper", async () => {
    const sessionKey = "agent:main:lifecycle-owned-old";
    const transcriptPath = path.join(tempDir, "lifecycle-owned-old.jsonl");
    await saveSessionStore(
      storePath,
      {
        [sessionKey]: {
          sessionFile: transcriptPath,
          sessionId: "lifecycle-owned-old",
          updatedAt: 10,
        },
        "agent:main:regular": {
          sessionId: "regular",
          updatedAt: 20,
        },
      },
      { skipMaintenance: true },
    );
    fs.writeFileSync(transcriptPath, '{"runId":"lifecycle-owned-old"}\n', "utf-8");
    const oldDate = new Date(Date.now() - 600_000);
    fs.utimesSync(transcriptPath, oldDate, oldDate);

    await expect(
      cleanupSessionLifecycleArtifacts({
        storePath,
        sessionKeySegmentPrefix: "lifecycle-owned-",
        transcriptContentMarker: '"runId":"lifecycle-owned-',
        orphanTranscriptMinAgeMs: 300_000,
      }),
    ).resolves.toEqual({
      archivedTranscriptArtifacts: 1,
      removedEntries: 1,
    });

    expect(getSessionEntry({ sessionKey, storePath })).toBeUndefined();
    expect(getSessionEntry({ sessionKey: "agent:main:regular", storePath })).toMatchObject({
      sessionId: "regular",
    });
    expect(
      fs
        .readdirSync(tempDir)
        .filter((file) => file.startsWith("lifecycle-owned-old.jsonl.deleted.")),
    ).toHaveLength(1);
  });
});
