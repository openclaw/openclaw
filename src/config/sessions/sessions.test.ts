import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizePersistedSessionEntryShape } from "../../commands/doctor/shared/session-entry-shape.js";
import { withTempDirSync } from "../../test-helpers/temp-dir.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import type { SessionConfig } from "../types.base.js";
import { parseSqliteSessionFileMarker } from "./legacy-sqlite-marker.js";
import { resolveSessionWorkStartError } from "./lifecycle.js";
import {
  resolveSessionFilePathCore,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPathInDir,
  validateSessionId,
} from "./paths.js";
import { evaluateSessionFreshness, resolveSessionResetPolicy } from "./reset.js";
import { mergeRestartRecoveryTerminalRunIds } from "./restart-recovery-state.js";

it.each([
  ["linux", "legacy:session", "/state/agents/main/agent/openclaw-agent.sqlite"],
  ["linux", "legacy:x", "/state/openclaw-agent.sqlite"],
  ["win32", "legacy:x", "C:\\state\\openclaw-agent.sqlite"],
  ["win32", "legacy:x", "C:/state/openclaw-agent.sqlite"],
  ["win32", "legacy:x", "\\\\server\\state\\openclaw-agent.sqlite"],
  ["linux", "session", "/state/archive:part/openclaw-agent.sqlite"],
  ["linux", "session", "relative/sessions.json"],
  ["win32", "session", "relative\\sessions.json"],
] as const)(
  "preserves the %s transcript ID %s and store path %s in legacy markers",
  (platform, sessionId, storePath) => {
    expect(
      withMockedPlatform(platform, () =>
        parseSqliteSessionFileMarker(`sqlite:main:${sessionId}:${storePath}`),
      ),
    ).toEqual({ agentId: "main", sessionId, storePath });
  },
);

it("merges bounded restart tombstones without evicting fresh-only ids", () => {
  const existing = Array.from({ length: 64 }, (_, index) => `run-${index}`);

  expect(mergeRestartRecoveryTerminalRunIds(existing, [...existing.slice(1), "run-new"])).toEqual([
    ...existing.slice(1),
    "run-new",
  ]);
  expect(mergeRestartRecoveryTerminalRunIds(existing, ["run-0"])).toEqual(existing);
});

type NormalizationCase = [
  name: string,
  input: Record<string, unknown>,
  expected?: Record<string, unknown>,
  absent?: string[],
  sessionKey?: string,
];
const repairBacklog = [
  { id: "repair-1", text: "first", provider: "openai", model: "gpt-5.5", createdAt: 42 },
  { id: "repair-2", text: "second", createdAt: 43 },
];
const deliveries = [
  { id: "prepared", state: "prepared" },
  { id: "delivered", state: "delivered" },
];
const archived = { archivedAt: 41, archiveReason: "active-session-cap" };
const actor = { type: "human", id: "operator" };
const childKey = "agent:child:main";
const pluginExtensions = { wordboard: { draftId: "draft-1" } };

it.each<NormalizationCase>([
  ["noncanonical ID", { sessionId: "legacy:session", pluginExtensions: { memory: {} } }],
  [
    "retired conversation link",
    {
      sessionId: "existing",
      conversationLink: { url: "https://example.test" },
      pluginExtensions,
    },
    {
      sessionId: "existing",
      updatedAt: 42,
      pluginExtensions: structuredClone(pluginExtensions),
    },
    ["conversationLink"],
  ],
  ["known archive reason", archived, { archiveReason: "active-session-cap" }],
  [
    "orphan archive metadata",
    { archivedBy: actor, archiveReason: "active-session-cap" },
    { updatedAt: 42 },
    ["archivedBy", "archiveReason"],
  ],
  [
    "unknown archive reason preserves actor",
    { ...archived, archivedBy: actor, archiveReason: "unknown" },
    { archivedBy: structuredClone(actor) },
  ],
  ...[undefined, Number.NaN, 0].map((snoozedUntil): NormalizationCase => [
    `invalid snooze ${String(snoozedUntil)}`,
    { snoozedUntil, snoozedAt: 41 },
    { updatedAt: 42 },
    ["snoozedUntil", "snoozedAt"],
  ]),
  [
    "archived snooze",
    {
      archivedAt: 43,
      archiveReason: "active-session-cap",
      snoozedUntil: Number.MAX_SAFE_INTEGER,
      snoozedAt: 41,
    },
    { archivedAt: 43, archiveReason: "active-session-cap" },
    ["snoozedUntil", "snoozedAt"],
  ],
  [
    "shipped pending key-as-ID",
    { sessionId: childKey },
    { initializationPending: true, updatedAt: 42 },
    ["sessionId"],
    childKey,
  ],
  [
    "locked key-as-ID",
    { sessionId: childKey, modelSelectionLocked: true },
    undefined,
    undefined,
    childKey,
  ],
  [
    "boolean pending delivery",
    { pendingFinalDelivery: true },
    { pendingFinalDelivery: { kind: "transport-only", createdAt: 42 } },
  ],
  [
    "pending delivery owners",
    {
      pendingFinalDelivery: {
        kind: "replayable",
        text: "reply",
        createdAt: 41,
        intentId: "intent-1",
        deliveries: [
          ...structuredClone(deliveries),
          { id: "", state: "queued" },
          { id: "invalid", state: "invalid" },
        ],
      },
    },
    { pendingFinalDelivery: { intentId: "intent-1", deliveries } },
  ],
  [
    "transcript repair backlog",
    { pendingTranscriptRepair: structuredClone(repairBacklog) },
    { pendingTranscriptRepair: repairBacklog },
  ],
  ...[{ id: "repair-1", text: "first", createdAt: 42 }, [{ kind: "transport-only" }]].map(
    (pendingTranscriptRepair): NormalizationCase => [
      `invalid repair backlog ${JSON.stringify(pendingTranscriptRepair)}`,
      { pendingTranscriptRepair },
      { updatedAt: 42 },
      ["pendingTranscriptRepair"],
    ],
  ),
])("normalization: %s", (_name, input, expected, absent, sessionKey) => {
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
  type Input = Parameters<typeof evaluateSessionFreshness>[0];
  type Case = [
    name: string,
    input: Input,
    expected: Partial<ReturnType<typeof evaluateSessionFreshness>>,
  ];
  function input(
    mode: "daily" | "idle",
    timestamps: Partial<Input> = {},
    idleMinutes?: number,
  ): Input {
    const now = mode === "daily" ? dailyNow : idleNow;
    return {
      updatedAt: now,
      now,
      policy: { mode, atHour: 4, ...(idleMinutes === undefined ? {} : { idleMinutes }) },
      ...timestamps,
    };
  }
  it.each<Case>([
    [
      "zero idle timeout",
      input("idle", { updatedAt: 1_000 }, 0),
      { fresh: true, dailyResetAt: undefined, idleExpiresAt: undefined },
    ],
    [
      "daily uses session start",
      input("daily", { sessionStartedAt: dailyNow - 25 * 60 * 60_000 }),
      { fresh: false, staleReason: "daily" },
    ],
    ...[{ lastInteractionAt: 0 }, { sessionStartedAt: 0 }].map((timestamps): Case => [
      `idle uses ${Object.keys(timestamps)[0]}`,
      input("idle", timestamps, 5),
      { fresh: false, idleExpiresAt: 5 * 60_000, staleReason: "idle" },
    ]),
    [
      "first of combined deadlines",
      input(
        "daily",
        {
          sessionStartedAt: new Date(2026, 3, 24, 23).getTime(),
          lastInteractionAt: new Date(2026, 3, 25, 11).getTime(),
        },
        30,
      ),
      { fresh: false, staleReason: "daily" },
    ],
    ...(["daily", "idle"] as const).map((mode): Case => [
      `future legacy timestamp: ${mode}`,
      input(
        mode,
        { updatedAt: (mode === "daily" ? dailyNow : idleNow) + 30 * 24 * 60 * 60_000 },
        mode === "idle" ? 5 : undefined,
      ),
      { fresh: false, ...(mode === "idle" ? { idleExpiresAt: 5 * 60_000 } : {}) },
    ]),
  ])("%s", (_name, request, expected) => {
    const freshness = evaluateSessionFreshness(request);
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
    ).toContain("Open it in WebChat and use Resume.");
    expect(
      resolveSessionWorkStartError("agent:main:matrix:channel:room-a", entry, {
        allowRestartTombstoneReplacement: true,
      }),
    ).toBeUndefined();
  });
});
