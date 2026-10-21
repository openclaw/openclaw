import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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
const threadKey = "agent:main:main:thread:test";
const sessionId = "session";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let storePath: string;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "entry-freshness" });
  storePath = state.statePath("sessions.json");
});
afterEach(async () => {
  await state.cleanup();
});
type Scope = Parameters<typeof upsertSessionEntryCore>[0];
const lifecycle = { updatedAt: now, sessionStartedAt: now, lastInteractionAt: now };
const seed = (entry: Partial<SessionEntry> = {}, scope: Partial<Scope> = {}) =>
  upsertSessionEntryCore(
    { sessionKey: threadKey, storePath, ...scope },
    { sessionId, ...lifecycle, ...entry },
  );

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
  await seed({}, { sessionKey, agentId: "ops", defaultAgentId: "ops" });

  const result = resolveSessionEntryResetFreshness({
    ...params(sessionKey),
    defaultAgentId: "ops",
    resetType: "direct",
  });

  expect(result).toMatchObject({ state: "fresh", entry: { sessionId } });
});

it("keeps provider-owned sessions fresh when reset policy is implicit", async () => {
  await seed({
    sessionStartedAt: now - 2 * DAY_MS,
    lastInteractionAt: now - 2 * DAY_MS,
    providerOverride: "claude-cli",
    cliSessionBindings: {
      "claude-cli": { sessionId: "cli-session-provider-owned" },
    },
  });

  const result = resolveSessionEntryResetFreshness(params(threadKey));

  expect(result).toMatchObject({ state: "fresh", freshness: { fresh: true } });
});

it("resolves the store path from session config", async () => {
  const configuredStorePath = state.statePath("configured-sessions.json");
  await seed({ lastInteractionAt: now - 60 * 60 * 1000 }, { storePath: configuredStorePath });

  const result = resolveSessionEntryResetFreshness({
    sessionKey: threadKey,
    sessionCfg: { store: configuredStorePath, reset: { mode: "idle", idleMinutes: 30 } },
    resetType: "thread",
    now,
  });

  expect(result).toMatchObject({
    state: "stale",
    entry: { sessionId },
    resetPolicy: { mode: "idle", idleMinutes: 30 },
    freshness: { fresh: false, staleReason: "idle" },
  });
});

it.each([resolveSessionEntryResetFreshness, resolveSessionEntryResetFreshnessAsync])(
  "uses the SQLite transcript header when lifecycle metadata is missing (%s)",
  async (resolveFreshness) => {
    const headerTimestamp = new Date(now - 2 * DAY_MS).toISOString();
    const target = { agentId: "main", sessionId, sessionKey: threadKey, storePath };
    const entry = await replaceSessionEntry(target, { sessionId, updatedAt: now });
    expect(entry?.sessionStartedAt).toBeUndefined();
    await appendTranscriptEvent(target, {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: headerTimestamp,
      cwd: state.root,
    });

    const result = await resolveFreshness({
      ...params(threadKey),
      sessionCfg: { reset: { mode: "daily" } },
    });

    expect(result).toMatchObject({
      state: "stale",
      lifecycleTimestamps: { sessionStartedAt: Date.parse(headerTimestamp) },
      freshness: { fresh: false, staleReason: "daily" },
    });
  },
);
