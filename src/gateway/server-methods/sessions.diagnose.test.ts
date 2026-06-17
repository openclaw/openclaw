import path from "node:path";
import { expect, test, vi } from "vitest";
import type { SessionsDiagnoseResult } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
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

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

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
