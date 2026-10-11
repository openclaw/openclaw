// Session config tests cover session creation, updates, and persistence.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizePersistedSessionEntryShape } from "../../commands/doctor/shared/session-entry-shape.js";
import { withTempDirSync } from "../../test-helpers/temp-dir.js";
import type { SessionConfig } from "../types.base.js";
import { resolveSessionWorkStartError } from "./lifecycle.js";
import {
  resolveSessionFilePathCore,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPathInDir,
  validateSessionId,
} from "./paths.js";
import { evaluateSessionFreshness, resolveSessionResetPolicy } from "./reset.js";
import { mergeRestartRecoveryTerminalRunIds } from "./restart-recovery-state.js";

it("merges bounded restart tombstones without evicting fresh-only ids", () => {
  const existing = Array.from({ length: 64 }, (_, index) => `run-${index}`);

  expect(mergeRestartRecoveryTerminalRunIds(existing, [...existing.slice(1), "run-new"])).toEqual([
    ...existing.slice(1),
    "run-new",
  ]);
  expect(mergeRestartRecoveryTerminalRunIds(existing, ["run-0"])).toEqual(existing);
});

type NormalizationCase = {
  name: string;
  input: Record<string, unknown>;
  expected?: Record<string, unknown>;
  absent?: string[];
  sessionKey?: string;
};

it.each<NormalizationCase>([
  {
    name: "rejects a noncanonical transcript ID",
    input: { sessionId: "legacy:session", pluginExtensions: { memory: { mode: "legacy" } } },
  },
  {
    name: "drops retired conversation links without losing session metadata",
    input: {
      sessionId: "existing-session",
      conversationLink: { url: "https://chat.example.test/thread/123", label: "Source Thread" },
      pluginExtensions: { wordboard: { draftId: "draft-1" } },
    },
    expected: {
      sessionId: "existing-session",
      updatedAt: 42,
      pluginExtensions: { wordboard: { draftId: "draft-1" } },
    },
    absent: ["conversationLink"],
  },
  {
    name: "retains recognized archive reasons",
    input: { archivedAt: 41, archiveReason: "active-session-cap" },
    expected: { archiveReason: "active-session-cap" },
  },
  {
    name: "drops orphan archive metadata",
    input: {
      archivedBy: { type: "human", id: "stale-actor" },
      archiveReason: "active-session-cap",
    },
    expected: { updatedAt: 42 },
    absent: ["archivedBy", "archiveReason"],
  },
  {
    name: "retains the actor when an archive reason is unknown",
    input: {
      archivedAt: 41,
      archivedBy: { type: "human", id: "operator-1" },
      archiveReason: "unknown",
    },
    expected: { archivedBy: { type: "human", id: "operator-1" } },
  },
  ...[undefined, Number.NaN, 0].map((snoozedUntil): NormalizationCase => ({
    name: `drops invalid snooze ${String(snoozedUntil)} and its timestamp`,
    input: { snoozedUntil, snoozedAt: 41 },
    expected: { updatedAt: 42 },
    absent: ["snoozedUntil", "snoozedAt"],
  })),
  {
    name: "drops archived snoozes so restore cannot hide a session",
    input: {
      archivedAt: 43,
      archiveReason: "active-session-cap",
      snoozedUntil: Number.MAX_SAFE_INTEGER,
      snoozedAt: 41,
    },
    expected: { archivedAt: 43, archiveReason: "active-session-cap" },
    absent: ["snoozedUntil", "snoozedAt"],
  },
  {
    name: "preserves shipped pending key-as-session-id rows",
    input: { sessionId: "agent:child:main" },
    sessionKey: "agent:child:main",
    expected: { initializationPending: true, updatedAt: 42 },
    absent: ["sessionId"],
  },
  {
    name: "rejects locked key-as-session-id rows",
    input: { sessionId: "agent:child:main", modelSelectionLocked: true },
    sessionKey: "agent:child:main",
  },
  {
    name: "migrates boolean pending delivery to transport-only",
    input: { pendingFinalDelivery: true },
    expected: { pendingFinalDelivery: { kind: "transport-only", createdAt: 42 } },
  },
  {
    name: "preserves exact pending-final delivery owners",
    input: {
      pendingFinalDelivery: {
        kind: "replayable",
        text: "durable reply",
        createdAt: 41,
        intentId: "intent-1",
        deliveries: [
          { id: "delivery-prepared", state: "prepared" },
          { id: "delivery-delivered", state: "delivered" },
          { id: "", state: "queued" },
          { id: "delivery-invalid", state: "invalid" },
        ],
      },
    },
    expected: {
      pendingFinalDelivery: {
        intentId: "intent-1",
        deliveries: [
          { id: "delivery-prepared", state: "prepared" },
          { id: "delivery-delivered", state: "delivered" },
        ],
      },
    },
  },
  {
    name: "preserves the assistant transcript repair backlog",
    input: {
      pendingTranscriptRepair: [
        {
          id: "repair-1",
          text: "recoverable assistant final",
          provider: "openai",
          model: "gpt-5.5",
          createdAt: 42,
        },
        { id: "repair-2", text: "second recoverable assistant final", createdAt: 43 },
      ],
    },
    expected: {
      pendingTranscriptRepair: [
        {
          id: "repair-1",
          text: "recoverable assistant final",
          provider: "openai",
          model: "gpt-5.5",
          createdAt: 42,
        },
        { id: "repair-2", text: "second recoverable assistant final", createdAt: 43 },
      ],
    },
  },
  ...[
    { id: "repair-1", text: "recoverable assistant final", createdAt: 42 },
    [{ kind: "transport-only" }],
  ].map((pendingTranscriptRepair): NormalizationCase => ({
    name: `drops invalid repair backlog ${JSON.stringify(pendingTranscriptRepair)}`,
    input: { pendingTranscriptRepair },
    expected: { updatedAt: 42 },
    absent: ["pendingTranscriptRepair"],
  })),
])("normalization $name", ({ input, expected, absent, sessionKey }) => {
  const entry = normalizePersistedSessionEntryShape(
    { sessionId: "session-1", updatedAt: 42, ...input },
    { sessionKey },
  );
  if (expected === undefined) {
    expect(entry).toBeUndefined();
  } else {
    expect(entry).toMatchObject(expected);
    for (const property of absent ?? []) {
      expect(entry).not.toHaveProperty(property);
    }
  }
});

it("retains valid snooze metadata without turning it into a work-admission barrier", () => {
  const entry = normalizePersistedSessionEntryShape({
    sessionId: "snoozed-session",
    updatedAt: 42,
    snoozedUntil: 100,
    snoozedAt: 41,
  });
  expect(entry).toMatchObject({ snoozedUntil: 100, snoozedAt: 41 });
  expect(resolveSessionWorkStartError("agent:main:snoozed", entry)).toBeUndefined();
});

describe("session path safety", () => {
  it("preserves path-safe Unicode session IDs", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    for (const sessionId of ["volume-main-会議-000000", "volume-main-हिन्दी-000001"]) {
      expect(validateSessionId(sessionId)).toBe(sessionId);
      expect(normalizePersistedSessionEntryShape({ sessionId, updatedAt: 42 })).toMatchObject({
        sessionId,
        updatedAt: 42,
      });
      expect(resolveSessionTranscriptPathInDir(sessionId, sessionsDir)).toBe(
        path.resolve(sessionsDir, `${sessionId}.jsonl`),
      );
    }
  });

  it("rejects unsafe and noncanonical session IDs", () => {
    for (const sessionId of [
      "session-Å",
      "session-A\u030A",
      "session-e\u0301",
      "../etc/passwd",
      "a/b",
      "a\\b",
      "/abs",
      "session:legacy",
      "session-🙂",
      "sess.checkpoint.11111111-1111-4111-8111-111111111111",
      `session-${"会".repeat(82)}`,
    ]) {
      expect(() => validateSessionId(sessionId), sessionId).toThrow(/Invalid session ID/);
      expect(normalizePersistedSessionEntryShape({ sessionId, updatedAt: 42 })).toBeUndefined();
    }
  });

  it("resolves transcript path inside an explicit sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";
    const resolved = resolveSessionTranscriptPathInDir("sess-1", sessionsDir, "topic/a+b");

    expect(resolved).toBe(path.resolve(sessionsDir, "sess-1-topic-topic%2Fa%2Bb.jsonl"));
  });

  it("rejects topic-qualified transcript filenames over 255 bytes", () => {
    const sessionId = "会".repeat(82);

    expect(validateSessionId(sessionId)).toBe(sessionId);
    expect(() => resolveSessionTranscriptPathInDir(sessionId, "/tmp/sessions", 1)).toThrow(
      /Invalid session transcript filename/,
    );
  });

  it("falls back to derived path when sessionFile is outside known agent sessions dirs", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    const resolved = resolveSessionFilePathCore(
      "sess-1",
      { sessionFile: "/tmp/openclaw/agents/work/not-sessions/abc-123.jsonl" },
      { sessionsDir },
    );
    expect(resolved).toBe(path.resolve(sessionsDir, "sess-1.jsonl"));
  });

  it("ignores multi-store sentinel paths when deriving session file options", () => {
    expect(resolveSessionFilePathOptions({ agentId: "worker", storePath: "(multiple)" })).toEqual({
      agentId: "worker",
    });
    expect(resolveSessionFilePathOptions({ storePath: "(multiple)" })).toBeUndefined();
  });

  it.each([false, true])("contains symlink session paths (escape=%s)", (escape) => {
    if (process.platform === "win32") {
      return;
    }
    withTempDirSync({ prefix: "openclaw-symlink-session-" }, (tmpDir) => {
      const realRoot = path.join(tmpDir, "real-state");
      const sessionsDir = path.join(realRoot, "agents", "main", "sessions");
      const expected = path.join(sessionsDir, "sess-1.jsonl");
      fs.mkdirSync(sessionsDir, { recursive: true });
      let sessionFile: string;
      if (escape) {
        const outsideDir = path.join(tmpDir, "outside");
        fs.mkdirSync(outsideDir);
        const outsideFile = path.join(outsideDir, "escaped.jsonl");
        fs.writeFileSync(outsideFile, "");
        sessionFile = path.join(sessionsDir, "escaped.jsonl");
        fs.symlinkSync(outsideFile, sessionFile, "file");
      } else {
        const aliasRoot = path.join(tmpDir, "alias-state");
        fs.symlinkSync(realRoot, aliasRoot, "dir");
        sessionFile = path.join(aliasRoot, "agents", "main", "sessions", "sess-1.jsonl");
        fs.writeFileSync(expected, "");
      }
      const resolved = resolveSessionFilePathCore("sess-1", { sessionFile }, { sessionsDir });
      expect(fs.realpathSync(path.dirname(resolved))).toBe(fs.realpathSync(sessionsDir));
      expect(path.basename(resolved)).toBe("sess-1.jsonl");
      if (!escape) {
        expect(fs.realpathSync(resolved)).toBe(fs.realpathSync(expected));
      }
    });
  });
});

describe("resolveSessionResetPolicy", () => {
  describe("backward compatibility: resetByType.dm -> direct", () => {
    it("does not use dm fallback for group/thread types", () => {
      const sessionCfg = {
        resetByType: {
          dm: { mode: "idle" as const, idleMinutes: 45 },
        },
      } as unknown as SessionConfig;

      const groupPolicy = resolveSessionResetPolicy({
        sessionCfg,
        resetType: "group",
      });

      expect(groupPolicy.mode).toBe("none");
    });
  });

  it("defaults to no automatic reset", () => {
    const policy = resolveSessionResetPolicy({
      resetType: "direct",
    });

    expect(policy.mode).toBe("none");
    expect(policy.atHour).toBe(4);
  });

  const dailyNow = new Date(2026, 3, 25, 12).getTime();
  const idleNow = 60 * 60_000;
  type FreshnessCase = {
    name: string;
    input: Parameters<typeof evaluateSessionFreshness>[0];
    expected: Partial<ReturnType<typeof evaluateSessionFreshness>>;
  };
  it.each<FreshnessCase>([
    {
      name: "zero idle timeout never expires",
      input: {
        updatedAt: 1_000,
        now: idleNow,
        policy: { mode: "idle", atHour: 4, idleMinutes: 0 },
      },
      expected: { fresh: true, dailyResetAt: undefined, idleExpiresAt: undefined },
    },
    {
      name: "daily freshness uses session start instead of updates",
      input: {
        updatedAt: dailyNow,
        sessionStartedAt: dailyNow - 25 * 60 * 60_000,
        now: dailyNow,
        policy: { mode: "daily", atHour: 4 },
      },
      expected: { fresh: false, staleReason: "daily" },
    },
    ...[{ lastInteractionAt: 0 }, { sessionStartedAt: 0 }].map((timestamps): FreshnessCase => ({
      name: `idle freshness uses ${Object.keys(timestamps)[0]} instead of updates`,
      input: {
        updatedAt: idleNow,
        ...timestamps,
        now: idleNow,
        policy: { mode: "idle", atHour: 4, idleMinutes: 5 },
      },
      expected: { fresh: false, idleExpiresAt: 5 * 60_000, staleReason: "idle" },
    })),
    {
      name: "combined expiry reports the first deadline",
      input: {
        updatedAt: dailyNow,
        sessionStartedAt: new Date(2026, 3, 24, 23).getTime(),
        lastInteractionAt: new Date(2026, 3, 25, 11).getTime(),
        now: dailyNow,
        policy: { mode: "daily", atHour: 4, idleMinutes: 30 },
      },
      expected: { fresh: false, staleReason: "daily" },
    },
    ...(["daily", "idle"] as const).map((mode): FreshnessCase => {
      const now = mode === "daily" ? dailyNow : idleNow;
      return {
        name: `future legacy timestamps cannot keep ${mode} sessions fresh`,
        input: {
          updatedAt: now + 30 * 24 * 60 * 60_000,
          now,
          policy: { mode, atHour: 4, ...(mode === "idle" ? { idleMinutes: 5 } : {}) },
        },
        expected: { fresh: false, ...(mode === "idle" ? { idleExpiresAt: 5 * 60_000 } : {}) },
      };
    }),
  ])("$name", ({ input, expected }) => {
    const freshness = evaluateSessionFreshness(input);
    if (expected.fresh) {
      expect(freshness).toEqual(expected);
    } else {
      expect(freshness).toMatchObject(expected);
    }
  });
});

describe("session work admission", () => {
  it("fails closed while trusted session initialization is pending", () => {
    expect(
      resolveSessionWorkStartError("agent:main:pending", {
        sessionId: "pending-session",
        initializationPending: true,
      }),
    ).toContain("still initializing");
    expect(
      resolveSessionWorkStartError("agent:main:pending", {
        sessionId: "pending-session",
      }),
    ).toBeUndefined();
  });

  it("keeps restart-recovery tombstones terminal when archive metadata is missing", () => {
    const entry = {
      sessionId: "failed-session",
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 4,
        chargedAttempts: 3,
        tombstone: {
          reason: "automatic recovery exhausted",
          recoveredSessionId: "dashboard-successor",
          recoveredSessionKey: "agent:main:dashboard:successor",
        },
      },
    };

    expect(resolveSessionWorkStartError("agent:main:matrix:channel:room-a", entry)).toContain(
      "ended during restart recovery",
    );
    expect(
      resolveSessionWorkStartError("agent:main:matrix:channel:room-a", {
        ...entry,
        modelSelectionLocked: true,
      }),
    ).toContain("Open it in WebChat and use Resume in new session");
    expect(
      resolveSessionWorkStartError("agent:main:matrix:channel:room-a", entry, {
        allowRestartTombstoneReplacement: true,
      }),
    ).toBeUndefined();
  });
});
