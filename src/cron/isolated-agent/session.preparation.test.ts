import fs from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { readSessionEntriesFromStoreInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { loadCronSessionEntryLatest, prepareCronSession } from "./session.js";

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

it.each([
  ["shared.sqlite", "full"],
  ["shared.sqlite", "backing"],
  ["configured.json", "full"],
  ["configured.json", "backing"],
] as const)(
  "resolves %s ownership in the worker with the %s projection",
  async (name, projection) => {
    const storePath = state.path(name);
    const sessionKey = "agent:main:cron:custom";
    const entry = {
      sessionId: "custom-session",
      updatedAt: 1,
      sessionStartedAt: 1,
      skillsSnapshot: { prompt: "complete saved prompt", skills: [] },
      subagentRecovery: { wedgedAt: 1, wedgedReason: "Synthetic recovery tombstone" },
    };
    replaceSessionEntrySync({ agentId: "main", env: state.env, storePath, sessionKey }, entry);
    const observer = observeHostDataSql();
    try {
      const result = await readSessionEntriesFromStoreInWorker({
        agentId: "main",
        env: state.env,
        storePath,
        sessionKeys: [sessionKey, "agent:main:cron:missing"],
        projection,
      });
      expect(result.entries).toEqual([
        {
          sessionKey,
          entry:
            projection === "full"
              ? expect.objectContaining(entry)
              : {
                  sessionId: entry.sessionId,
                  updatedAt: entry.updatedAt,
                  subagentRecovery: entry.subagentRecovery,
                },
        },
      ]);
      for (const call of observer.calls) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      observer.restore();
    }
  },
);

it("keeps preparation on the configured store for an incognito-shaped target", async () => {
  const sessionKey = "agent:main:dashboard:incognito-cron";
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  replaceSessionEntrySync(
    { agentId: "main", env: state.env, storePath, sessionKey },
    { sessionId: "process-held", updatedAt: 1 },
  );
  const prepared = await prepareCronSession({ cfg: {}, agentId: "main", sessionKey, nowMs: 2 });
  expect(prepared.initialSessionEntry).toBeUndefined();
  expect(prepared.store).toEqual({});
  expect(loadCronSessionEntryLatest(storePath, sessionKey)?.sessionId).toBe("process-held");
});

it("keeps internal-effects rows hidden from cron preparation", async () => {
  const sessionKey = "agent:main:internal-session-effects:hidden";
  const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  writeSessionEntry(database, sessionKey, { sessionId: "hidden-session", updatedAt: 1 });
  const prepared = await prepareCronSession({ cfg: {}, agentId: "main", sessionKey, nowMs: 2 });
  expect(prepared.initialSessionEntry).toBeUndefined();
  expect(prepared.store).toEqual({});
});

it("rejects a noncanonical persisted key instead of repairing it at runtime", async () => {
  const database = openOpenClawAgentDatabase({ agentId: "malformed", env: state.env });
  const sessionKey = "agent:malformed:cron:canonical";
  writeSessionEntry(database, sessionKey, { sessionId: "canonical-session", updatedAt: 1 });
  // Inject the pre-migration shape without the current writer repairing or rejecting it.
  database.db.exec("PRAGMA foreign_keys = OFF");
  database.db
    .prepare("UPDATE session_nodes SET session_key = ? WHERE session_key = ?")
    .run(` ${sessionKey} `, sessionKey);
  database.db.exec("PRAGMA foreign_keys = ON");
  await expect(
    readSessionEntriesFromStoreInWorker({
      agentId: "malformed",
      env: state.env,
      storePath: database.path,
      sessionKeys: [sessionKey],
    }),
  ).rejects.toThrow(/doctor --fix/i);
});

it.each(["full", "backing"] as const)(
  "rejects a %s read revoked during dispatch and joins worker close",
  async (projection) => {
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
        projection,
      }),
    ).rejects.toThrow(/revoked/);
    expect(closing).toBeDefined();
    await closing;
    expect(fs.existsSync(database.path)).toBe(true);
  },
);

it("keeps the captured source when caller inputs change during dispatch", async () => {
  const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  const sessionKey = "agent:main:cron:captured";
  writeSessionEntry(database, sessionKey, { sessionId: "captured-session", updatedAt: 1 });
  const input = {
    agentId: "main",
    env: { ...state.env },
    storePath: database.path,
    sessionKeys: [sessionKey],
  };
  observed.dispatch = () => {
    observed.dispatch = undefined;
    input.storePath = state.path("replacement.sqlite");
    input.env.OPENCLAW_STATE_DIR = state.path("replacement-state");
    input.sessionKeys[0] = "agent:main:cron:other";
  };
  const result = await readSessionEntriesFromStoreInWorker(input);
  expect(result.entries).toEqual([
    { sessionKey, entry: expect.objectContaining({ sessionId: "captured-session" }) },
  ]);
  expect(fs.existsSync(input.storePath)).toBe(false);
});

it.each(["full", "backing"] as const)(
  "rejects a configured alias redirected while its %s read is in flight",
  async (projection) => {
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
    const alias = state.path(`alias-${projection}`);
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
        projection,
      }),
    ).rejects.toThrow(/outside captured discovery custody/);
  },
);
