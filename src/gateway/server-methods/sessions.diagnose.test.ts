import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionsDiagnoseResult } from "../../../packages/gateway-protocol/src/index.js";
import {
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
} from "../../agents/embedded-agent-runner/run-state.js";
import { resolveEmbeddedSessionFileKey } from "../../agents/embedded-agent-runner/session-file-key.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  markDiagnosticRunProgressForTest,
  resetDiagnosticRunActivityForTest,
} from "../../logging/diagnostic-run-activity.js";
import { writeSessionStore } from "../test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
  writeSingleLineSession,
} from "../test/server-sessions.test-helpers.js";

vi.mock("../../plugins/host-hook-state.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/host-hook-state.js")>(
    "../../plugins/host-hook-state.js",
  );
  return {
    ...actual,
    projectPluginSessionExtensionsSync: () => [],
  };
});

const { createSessionStoreDir, createSelectedGlobalSessionStore } =
  setupGatewaySessionsTestHarness();

afterEach(() => {
  ACTIVE_EMBEDDED_RUNS.clear();
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.clear();
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.clear();
  resetDiagnosticRunActivityForTest();
});

test("sessions.diagnose returns read-only live and stored evidence without transcript paths", async () => {
  const { dir } = await createSessionStoreDir();
  const sessionFile = path.join(dir, "sess-main.jsonl");
  await writeSingleLineSession(dir, "sess-main", "private prompt text should stay out");
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", {
        sessionFile,
        status: "running",
      }),
    },
  });

  const result = await directSessionReq<SessionsDiagnoseResult>(
    "sessions.diagnose",
    { key: "agent:main:main" },
    {
      context: {
        chatAbortControllers: new Map([
          [
            "run-1",
            {
              controller: new AbortController(),
              sessionId: "sess-main",
              sessionKey: "agent:main:main",
              agentId: "main",
              startedAtMs: Date.now() - 1_000,
              expiresAtMs: Date.now() + 60_000,
              kind: "agent",
            },
          ],
        ]),
      },
    },
  );

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    ok: true,
    outcome: "diagnosed",
    session: {
      found: true,
      key: "agent:main:main",
      sessionId: "sess-main",
      hasActiveRun: true,
    },
    live: {
      gatewayRun: {
        hasActiveRun: true,
      },
    },
  });
  const serialized = JSON.stringify(result.payload);
  expect(serialized).not.toContain(sessionFile);
  expect(serialized).not.toContain("private prompt text should stay out");
});

test("sessions.diagnose picks a visible active session beyond the bounded newest scan", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  const entries: Record<string, SessionEntry> = {
    "agent:main:stuck": sessionStoreEntry("sess-stuck", {
      status: "running",
      updatedAt: 1,
    }),
  };
  for (let index = 0; index < 105; index += 1) {
    entries[`agent:main:newer-${index}`] = sessionStoreEntry(`sess-newer-${index}`, {
      updatedAt: now + index,
    });
  }
  await writeSessionStore({ entries });

  const result = await directSessionReq<SessionsDiagnoseResult>(
    "sessions.diagnose",
    {},
    {
      context: {
        chatAbortControllers: new Map([
          [
            "run-stuck",
            {
              controller: new AbortController(),
              sessionId: "sess-stuck",
              sessionKey: "agent:main:stuck",
              agentId: "main",
              startedAtMs: now - 1_000,
              expiresAtMs: now + 60_000,
              kind: "agent",
            },
          ],
        ]),
      },
    },
  );

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    outcome: "diagnosed",
    chosenBecause: "highest live or contradictory evidence score",
    session: {
      key: "agent:main:stuck",
      sessionId: "sess-stuck",
      hasActiveRun: true,
    },
  });
});

test("sessions.diagnose picks an embedded active session beyond the bounded newest scan", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  const entries: Record<string, SessionEntry> = {
    "agent:main:embedded": sessionStoreEntry("sess-embedded", {
      status: "running",
      updatedAt: 1,
    }),
  };
  for (let index = 0; index < 105; index += 1) {
    entries[`agent:main:newer-${index}`] = sessionStoreEntry(`sess-newer-${index}`, {
      updatedAt: now + index,
    });
  }
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set("agent:main:embedded", "sess-embedded");
  ACTIVE_EMBEDDED_RUNS.set("sess-embedded", {
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort: () => {},
  });
  await writeSessionStore({ entries });

  const result = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {});

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    outcome: "diagnosed",
    chosenBecause: "highest live or contradictory evidence score",
    session: {
      key: "agent:main:embedded",
      sessionId: "sess-embedded",
      hasActiveRun: true,
    },
    live: {
      embeddedRun: {
        active: true,
        streaming: true,
      },
    },
  });
});

test("sessions.diagnose keeps file-indexed embedded active sessions during final ranking", async () => {
  const { dir } = await createSessionStoreDir();
  const sessionFile = path.join(dir, "sess-file-indexed.jsonl");
  const now = Date.now();
  await writeSessionStore({
    entries: {
      "agent:main:file-indexed": sessionStoreEntry("sess-stored-file-indexed", {
        sessionFile,
        status: "running",
        updatedAt: 1,
      }),
      "agent:main:newer": sessionStoreEntry("sess-newer", {
        updatedAt: now,
      }),
    },
  });
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set(
    resolveEmbeddedSessionFileKey(sessionFile),
    "sess-live-file-indexed",
  );
  ACTIVE_EMBEDDED_RUNS.set("sess-live-file-indexed", {
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort: () => {},
  });

  const result = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {});

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    outcome: "diagnosed",
    chosenBecause: "highest live or contradictory evidence score",
    session: {
      key: "agent:main:file-indexed",
      sessionId: "sess-stored-file-indexed",
      hasActiveRun: true,
    },
    live: {
      embeddedRun: {
        active: true,
        sessionId: "sess-live-file-indexed",
        streaming: true,
      },
    },
  });
});

test("sessions.diagnose ignores stale completed progress when choosing default target", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "agent:main:old": sessionStoreEntry("sess-old", { updatedAt: 1 }),
      "agent:main:new": sessionStoreEntry("sess-new", { updatedAt: 2 }),
    },
  });

  const nowSpy = vi.spyOn(Date, "now");
  try {
    nowSpy.mockReturnValue(1_700_000_000_000);
    markDiagnosticRunProgressForTest({
      sessionId: "sess-old",
      sessionKey: "agent:main:old",
      reason: "run.completed",
    });
    nowSpy.mockReturnValue(1_700_000_130_000);

    const result = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {});

    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({
      outcome: "diagnosed",
      chosenBecause: "newest stored session",
      session: { key: "agent:main:new", sessionId: "sess-new" },
    });
  } finally {
    nowSpy.mockRestore();
  }
});

test("sessions.diagnose reports no_sessions when no stored sessions exist", async () => {
  await createSessionStoreDir();
  await writeSessionStore({ entries: {} });

  const result = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {});

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    ok: true,
    outcome: "no_sessions",
    session: { found: false },
  });
});

test("sessions.diagnose marks terminal sessions with partial delivery route as uncertain", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", {
        endedAt: Date.now(),
        lastChannel: "telegram",
        status: "done",
      }),
    },
  });

  const result = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {
    key: "agent:main:main",
  });

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    delivery: {
      uncertain: true,
      lastChannel: "telegram",
    },
    findings: expect.arrayContaining([
      expect.objectContaining({
        code: "delivery_uncertain",
      }),
    ]),
  });
});

test("sessions.diagnose excludes global and unknown fallback rows unless opted in", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", { updatedAt: 10 }),
      global: sessionStoreEntry("sess-global", { updatedAt: 30 }),
      unknown: sessionStoreEntry("sess-unknown", { updatedAt: 50 }),
    },
  });

  const defaultResult = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {});
  expect(defaultResult.ok).toBe(true);
  expect(defaultResult.payload).toMatchObject({
    outcome: "diagnosed",
    session: { key: "agent:main:main", sessionId: "sess-main" },
  });

  const globalResult = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {
    includeGlobal: true,
  });
  expect(globalResult.ok).toBe(true);
  expect(globalResult.payload).toMatchObject({
    outcome: "diagnosed",
    session: { key: "global", sessionId: "sess-global" },
  });

  const unknownResult = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", {
    includeUnknown: true,
  });
  expect(unknownResult.ok).toBe(true);
  expect(unknownResult.payload).toMatchObject({
    outcome: "diagnosed",
    session: { key: "unknown", sessionId: "sess-unknown" },
  });
});

test("sessions.diagnose keeps the source agent for global fallback rows", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  const now = Date.now();
  await writeSessionStore({
    storePath: mainStorePath,
    entries: {
      global: sessionStoreEntry("sess-main-global", { updatedAt: 10 }),
    },
  });
  await writeSessionStore({
    storePath: workStorePath,
    entries: {
      global: sessionStoreEntry("sess-work-global", { updatedAt: 20 }),
    },
  });

  const result = await directSessionReq<SessionsDiagnoseResult>(
    "sessions.diagnose",
    { includeGlobal: true },
    {
      context: {
        chatAbortControllers: new Map([
          [
            "run-work-global",
            {
              controller: new AbortController(),
              sessionId: "sess-work-global",
              sessionKey: "global",
              agentId: "work",
              startedAtMs: now - 1_000,
              expiresAtMs: now + 60_000,
              kind: "agent",
            },
          ],
        ]),
      },
    },
  );

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    outcome: "diagnosed",
    session: {
      key: "global",
      sessionId: "sess-work-global",
      agentId: "work",
      hasActiveRun: true,
    },
    live: {
      gatewayRun: {
        hasActiveRun: true,
        runs: [expect.objectContaining({ agentId: "work" })],
      },
    },
    nextChecks: [
      "openclaw sessions --agent work tail --session-key global",
      "openclaw sessions --agent work export-trajectory --session-key global",
      "openclaw health --verbose",
    ],
  });
});

test("sessions.diagnose scopes unknown fallback active runs to the requested agent", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  const now = Date.now();
  await writeSessionStore({
    storePath: mainStorePath,
    entries: {
      unknown: sessionStoreEntry("sess-main-unknown", { updatedAt: 10 }),
    },
  });
  await writeSessionStore({
    storePath: workStorePath,
    entries: {
      unknown: sessionStoreEntry("sess-work-unknown", { updatedAt: 20 }),
    },
  });

  const result = await directSessionReq<SessionsDiagnoseResult>(
    "sessions.diagnose",
    { key: "unknown", agentId: "work" },
    {
      context: {
        chatAbortControllers: new Map([
          [
            "run-main-unknown",
            {
              controller: new AbortController(),
              sessionId: "sess-main-unknown",
              sessionKey: "unknown",
              agentId: "main",
              startedAtMs: now - 1_000,
              expiresAtMs: now + 60_000,
              kind: "agent",
            },
          ],
        ]),
      },
    },
  );

  expect(result.ok).toBe(true);
  const payload = result.payload;
  if (!payload) {
    throw new Error("expected diagnose payload");
  }
  const gatewayRun = payload.live.gatewayRun;
  if (!gatewayRun) {
    throw new Error("expected gateway run diagnosis");
  }
  expect(payload.outcome).toBe("diagnosed");
  expect(payload.session).toMatchObject({
    key: "unknown",
    sessionId: "sess-work-unknown",
    agentId: "work",
    hasActiveRun: false,
  });
  expect(gatewayRun.hasActiveRun).toBe(false);
  expect(gatewayRun.runs).toEqual([]);
  expect(payload.nextChecks).toEqual([
    "openclaw sessions --agent work tail --session-key unknown",
    "openclaw sessions --agent work export-trajectory --session-key unknown",
    "openclaw health --verbose",
  ]);
});

test("sessions.diagnose rejects key agent mismatch with agentId", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });

  const result = await directSessionReq("sessions.diagnose", {
    key: "agent:work:main",
    agentId: "main",
  });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "session key agent does not match agentId",
    },
  });
});

test("sessions.diagnose rejects ambiguous label selectors", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      first: sessionStoreEntry("sess-first", { label: "ops" }),
      second: sessionStoreEntry("sess-second", { label: "ops" }),
    },
  });

  const result = await directSessionReq("sessions.diagnose", { label: "ops" });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("multiple sessions match label ops"),
    },
  });
});

test("sessions.diagnose rejects ambiguous label selectors across agent global rows", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  await writeSessionStore({
    storePath: mainStorePath,
    entries: {
      global: sessionStoreEntry("sess-main-global", { label: "ops", updatedAt: 1 }),
    },
  });
  await writeSessionStore({
    storePath: workStorePath,
    entries: {
      global: sessionStoreEntry("sess-work-global", { label: "ops", updatedAt: 2 }),
    },
  });

  const result = await directSessionReq("sessions.diagnose", { label: "ops" });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("multiple sessions match label ops"),
    },
  });
});

test("sessions.diagnose rejects ambiguous session-id selectors", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      first: sessionStoreEntry("sess-shared"),
      second: sessionStoreEntry("sess-shared"),
    },
  });

  const result = await directSessionReq("sessions.diagnose", { sessionId: "sess-shared" });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("multiple sessions match sessionId sess-shared"),
    },
  });
});

test("sessions.diagnose rejects ambiguous session-id selectors across agent unknown rows", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  await writeSessionStore({
    storePath: mainStorePath,
    entries: {
      unknown: sessionStoreEntry("sess-shared", { updatedAt: 1 }),
    },
  });
  await writeSessionStore({
    storePath: workStorePath,
    entries: {
      unknown: sessionStoreEntry("sess-shared", { updatedAt: 2 }),
    },
  });

  const result = await directSessionReq("sessions.diagnose", { sessionId: "sess-shared" });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("multiple sessions match sessionId sess-shared"),
    },
  });
});

test("sessions.diagnose rejects multiple primary selectors", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", { label: "ops" }),
    },
  });

  const result = await directSessionReq("sessions.diagnose", {
    key: "agent:main:main",
    label: "ops",
  });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("choose only one of key, sessionId, or label"),
    },
  });
});
