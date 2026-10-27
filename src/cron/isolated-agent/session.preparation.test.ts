import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { readSessionEntriesFromStoreInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
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
  memorySessionActorOwners.reset();
});

async function withoutHostSql<T>(run: () => Promise<T>) {
  const observer = observeHostDataSql();
  try {
    const result = await run();
    expect(observer.queries).toEqual([]);
    return result;
  } finally {
    observer.restore();
  }
}

function readInput(sessionKey: string, storePath: string, guarded = true) {
  return {
    agentId: "main",
    env: { ...state.env },
    storePath,
    sessionKeys: [sessionKey, `${sessionKey}-missing`],
    lifecycleSessionKey: guarded ? sessionKey : undefined,
    projection: "full" as const,
  };
}

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
  const prepared = await withoutHostSql(() =>
    prepareCronSession({
      cfg: { session: { reset: { mode: "none" } } },
      agentId: "main",
      sessionKey,
      nowMs: now,
    }),
  );
  expect(prepared).toMatchObject({
    sessionEntry: { sessionStartedAt: now - 60_000 },
    isNewSession: false,
  });
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
  const input = readInput(sessionKey, storePath, false);
  observed.dispatch = () => {
    observed.dispatch = undefined;
    input.storePath = state.path("replacement.sqlite");
    input.env.OPENCLAW_STATE_DIR = state.path("replacement-state");
    input.sessionKeys[0] = "agent:main:cron:other";
  };
  const result = await withoutHostSql(() => readSessionEntriesFromStoreInWorker(input));
  expect(result.entries).toEqual([{ sessionKey, entry: expect.objectContaining(entry) }]);
  expect(fs.existsSync(input.storePath)).toBe(false);
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
      await replaceSessionEntry(
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

it.each(["revoked", "redirected"])("rejects a %s read at dispatch", async (interruption) => {
  const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  const sessionKey = `agent:main:cron:${interruption}`;
  writeSessionEntry(database, sessionKey, { sessionId: "original-source", updatedAt: 1 });
  // Exercise worker dispatch rather than the retained row-facts hit.
  sessionChanges.invalidate({ sessionKey, storePath: database.path, factsInvalidated: true });
  let storePath = database.path;
  let closing: Promise<boolean> | undefined;
  if (interruption === "revoked") {
    // Closing must not inherit the read's writer FIFO context.
    const runExternalClose = AsyncLocalStorage.snapshot();
    observed.dispatch = () => {
      observed.dispatch = undefined;
      closing = runExternalClose(() =>
        closeOpenClawAgentDatabaseByPathAsync(database.path, "main"),
      );
    };
  } else {
    const replacementRoot = state.path("replacement-root");
    const replacement = openOpenClawAgentDatabase({
      agentId: "main",
      env: state.env,
      path: path.join(replacementRoot, "agents", "main", "agent", "openclaw-agent.sqlite"),
    });
    writeSessionEntry(replacement, sessionKey, { sessionId: "replacement-source", updatedAt: 1 });
    const alias = state.path("alias-full");
    fs.symlinkSync(state.stateDir, alias, "junction");
    storePath = path.join(alias, "agents", "main", "agent", "openclaw-agent.sqlite");
    observed.dispatch = () => {
      observed.dispatch = undefined;
      fs.unlinkSync(alias);
      fs.symlinkSync(replacementRoot, alias, "junction");
    };
  }
  await expect(
    readSessionEntriesFromStoreInWorker(readInput(sessionKey, storePath)),
  ).rejects.toThrow(interruption === "revoked" ? /revoked/ : /outside captured discovery custody/);
  if (interruption === "revoked") {
    expect(closing).toBeDefined();
    await closing;
    expect(fs.existsSync(database.path)).toBe(true);
  }
});
