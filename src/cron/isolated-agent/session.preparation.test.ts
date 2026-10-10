import fs from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { readSessionEntriesFromStoreInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { loadCronSessionEntryLatest, prepareCronSession, resolveCronSession } from "./session.js";

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});
afterAll(async () => {
  await state.cleanup();
});

const observed = vi.hoisted(() => ({ dispatch: undefined as (() => void) | undefined }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<Worker["postMessage"]>): void {
        if (asOptionalRecord(asOptionalRecord(args[0])?.input)?.kind === "session-exact-entries") {
          observed.dispatch?.();
        }
        super.postMessage(...args);
      }
    },
  };
});
afterEach(() => {
  observed.dispatch = undefined;
});

it("prepares a missing start timestamp from the bounded transcript header without host SQLite", async () => {
  const sessionKey = "agent:main:cron:header";
  const scope = { agentId: "main", env: state.env, sessionKey, sessionId: "header-session" };
  const now = Date.now();
  replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: now });
  replaceTranscriptEventsSync(scope, [
    {
      type: "session",
      version: 3,
      id: scope.sessionId,
      timestamp: new Date(now - 60_000).toISOString(),
    },
  ]);
  const observer = observeHostDataSql();
  try {
    const prepared = await prepareCronSession({
      cfg: { session: { reset: { mode: "none" } } },
      agentId: "main",
      sessionKey,
      nowMs: now,
    });
    expect(prepared.sessionEntry.sessionStartedAt).toBe(now - 60_000);
    expect(prepared.isNewSession).toBe(false);
    for (const call of observer.calls) {
      expect(call).not.toHaveBeenCalled();
    }
  } finally {
    observer.restore();
  }
});

it("captures store ownership before dispatch without host SQLite", async () => {
  const storePath = state.path("shared.sqlite");
  const sessionKey = "agent:main:cron:custom";
  const entry = {
    sessionId: "custom-session",
    updatedAt: 1,
    sessionStartedAt: 1,
    skillsSnapshot: { prompt: "complete saved prompt", skills: [] },
    subagentRecovery: { wedgedAt: 1, wedgedReason: "Synthetic recovery tombstone" },
  };
  replaceSessionEntrySync({ agentId: "main", env: state.env, storePath, sessionKey }, entry);
  const input = {
    agentId: "main",
    env: { ...state.env },
    storePath,
    sessionKeys: [sessionKey, "agent:main:cron:missing"],
    projection: "full" as const,
  };
  observed.dispatch = () => {
    observed.dispatch = undefined;
    input.storePath = state.path("replacement.sqlite");
    input.env.OPENCLAW_STATE_DIR = state.path("replacement-state");
    input.sessionKeys[0] = "agent:main:cron:other";
  };
  const observer = observeHostDataSql();
  try {
    const result = await readSessionEntriesFromStoreInWorker(input);
    expect(result.entries).toEqual([{ sessionKey, entry: expect.objectContaining(entry) }]);
    for (const call of observer.calls) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(fs.existsSync(input.storePath)).toBe(false);
  } finally {
    observer.restore();
  }
});

it.each(["incognito", "internal-effects"] as const)(
  "keeps %s rows hidden from cron preparation",
  async (kind) => {
    const sessionKey =
      kind === "incognito"
        ? "agent:main:dashboard:incognito-cron"
        : "agent:main:internal-session-effects:hidden";
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    if (kind === "incognito") {
      replaceSessionEntrySync(
        { agentId: "main", env: state.env, storePath, sessionKey },
        { sessionId: "process-held", updatedAt: 1 },
      );
    } else {
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      writeSessionEntry(database, sessionKey, { sessionId: "hidden-session", updatedAt: 1 });
    }
    const prepared = await prepareCronSession({ cfg: {}, agentId: "main", sessionKey, nowMs: 2 });
    expect(prepared.initialSessionEntry).toBeUndefined();
    expect(prepared.store).toEqual({});
    if (kind === "incognito") {
      expect((await loadCronSessionEntryLatest(storePath, sessionKey))?.sessionId).toBe(
        "process-held",
      );
    }
  },
);

it("rejects a read revoked during dispatch and joins worker close", async () => {
  const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  const sessionKey = "agent:main:cron:closed";
  writeSessionEntry(database, sessionKey, { sessionId: "closed-session", updatedAt: 1 });
  let closing: Promise<boolean> | undefined;
  observed.dispatch = () => {
    observed.dispatch = undefined;
    closing = closeOpenClawAgentDatabaseByPathAsync(database.path, "main");
  };
  await expect(
    readSessionEntriesFromStoreInWorker({
      agentId: "main",
      env: state.env,
      storePath: database.path,
      sessionKeys: [sessionKey],
      projection: "full",
    }),
  ).rejects.toThrow(/revoked/);
  expect(closing).toBeDefined();
  await closing;
  expect(fs.existsSync(database.path)).toBe(true);
});

it("rejects a configured alias redirected while its read is in flight", async () => {
  const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  const replacementRoot = state.path("replacement-root");
  const replacement = openOpenClawAgentDatabase({
    agentId: "main",
    env: state.env,
    path: path.join(replacementRoot, "agents", "main", "agent", "openclaw-agent.sqlite"),
  });
  const sessionKey = "agent:main:cron:alias";
  writeSessionEntry(database, sessionKey, { sessionId: "original-source", updatedAt: 1 });
  writeSessionEntry(replacement, sessionKey, { sessionId: "replacement-source", updatedAt: 1 });
  const alias = state.path("alias-full");
  fs.symlinkSync(state.stateDir, alias, "junction");
  observed.dispatch = () => {
    observed.dispatch = undefined;
    fs.unlinkSync(alias);
    fs.symlinkSync(replacementRoot, alias, "junction");
  };
  await expect(
    readSessionEntriesFromStoreInWorker({
      agentId: "main",
      env: state.env,
      storePath: path.join(alias, "agents", "main", "agent", "openclaw-agent.sqlite"),
      sessionKeys: [sessionKey],
      projection: "full",
    }),
  ).rejects.toThrow(/outside captured discovery custody/);
});

it("keeps a provider-owned CLI session with the default reset policy", () => {
  const nowMs = 1_737_600_000_000;
  const startedAt = nowMs - 24 * 60 * 60 * 1000;
  const sessionKey = "agent:main:cron:daily-job";
  const entry = {
    sessionId: "old-session-id",
    updatedAt: startedAt,
    sessionStartedAt: startedAt,
    lastInteractionAt: startedAt,
    model: "claude-opus-4-6",
    modelProvider: "claude-cli",
    cliSessionBindings: { "claude-cli": { sessionId: "cli-conversation-xyz" } },
  };
  const result = resolveCronSession({
    cfg: { session: {} },
    sessionKey,
    agentId: "main",
    nowMs,
    forceNew: false,
    store: { [sessionKey]: entry },
    lifecycleTimestamps: { sessionStartedAt: startedAt, lastInteractionAt: startedAt },
  });
  expect(result.isNewSession).toBe(false);
  expect(result.sessionEntry.sessionId).toBe("old-session-id");
  expect(getCliSessionBinding(result.sessionEntry, "claude-cli")).toEqual({
    sessionId: "cli-conversation-xyz",
  });
});
