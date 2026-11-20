import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  resolveSessionEntryResetFreshness as resolve,
  resolveSessionEntryResetFreshnessAsync as resolveAsync,
} from "./entry-freshness.js";
import {
  appendTranscriptEvent,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";

const now = Date.parse("2026-01-02T12:00:00Z");
const old = now - 2 * 24 * 60 * 60 * 1000;
const sessionId = "session";
const expected = {
  missing: {
    state: "missing",
    entry: undefined,
    freshness: undefined,
    resetType: "thread",
    resetPolicy: { mode: "none", atHour: 4 },
  },
  defaultAgent: { state: "fresh", entry: { sessionId } },
  providerOwned: { state: "fresh", freshness: { fresh: true } },
  configuredStore: {
    state: "stale",
    entry: { sessionId },
    resetPolicy: { mode: "idle", idleMinutes: 30 },
    freshness: { fresh: false, staleReason: "idle" },
  },
  header: {
    state: "stale",
    lifecycleTimestamps: { sessionStartedAt: old },
    freshness: { fresh: false, staleReason: "daily" },
  },
};

it.each([
  ["missing", resolve],
  ["missing", resolveAsync],
  ["defaultAgent", resolve],
  ["providerOwned", resolve],
  ["configuredStore", resolve],
  ["header", resolve],
  ["header", resolveAsync],
] as const)("%s freshness through %s", (kind, lookup) =>
  withOpenClawTestState({ label: "entry-freshness" }, async (state) => {
    const storePath = state.statePath("sessions.json");
    const sessionKey = kind === "defaultAgent" ? "global" : "agent:main:main:thread:test";
    const target = {
      sessionId,
      sessionKey,
      storePath,
      agentId: kind === "defaultAgent" ? "ops" : "main",
    };
    const query: Parameters<typeof resolve>[0] = {
      sessionKey,
      storePath,
      resetType: "thread",
      sessionCfg: {},
      now,
    };
    if (kind === "header") {
      const entry = await replaceSessionEntry(target, { sessionId, updatedAt: now });
      expect(entry?.sessionStartedAt).toBeUndefined();
      await appendTranscriptEvent(target, {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date(old).toISOString(),
        cwd: state.root,
      });
      query.sessionCfg = { reset: { mode: "daily" } };
    } else if (kind !== "missing") {
      await upsertSessionEntryCore(target, {
        sessionId,
        updatedAt: now,
        sessionStartedAt: kind === "providerOwned" ? old : now,
        lastInteractionAt:
          kind === "providerOwned" ? old : kind === "configuredStore" ? now - 60 * 60 * 1000 : now,
        ...(kind === "providerOwned"
          ? {
              providerOverride: "claude-cli",
              cliSessionBindings: { "claude-cli": { sessionId: "cli-session-provider-owned" } },
            }
          : {}),
      });
      if (kind === "defaultAgent") {
        query.defaultAgentId = "ops";
        query.resetType = "direct";
      } else if (kind === "configuredStore") {
        query.storePath = undefined;
        query.sessionCfg = { store: storePath, reset: { mode: "idle", idleMinutes: 30 } };
      }
    }
    expect(await lookup(query)).toMatchObject(expected[kind]);
  }),
);
