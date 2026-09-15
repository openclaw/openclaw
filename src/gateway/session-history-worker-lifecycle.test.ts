import fs from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { DEFAULT_WORKER_PENDING_BYTES } from "../infra/worker-task-capacity.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { readChatHistoryPage } from "./server-methods/chat-history-pages.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";

const observed = vi.hoisted(() => ({
  timers: vi.spyOn(globalThis, "setTimeout"),
  workers: [] as Worker[],
  dispatch: undefined as ((message: unknown) => void) | undefined,
  restoration: undefined as
    | { sessionId: string; entered: () => void; wait: Promise<void> }
    | undefined,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<Worker["postMessage"]>): void {
        if (
          asOptionalRecord(asOptionalRecord(args[0])?.input)?.kind === "history-page" &&
          !observed.workers.includes(this)
        ) {
          observed.workers.push(this);
        }
        observed.dispatch?.(args[0]);
        super.postMessage(...args);
      }
    },
  };
});
vi.mock("../config/sessions/session-cold-storage-read.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/sessions/session-cold-storage-read.js")>();
  return {
    ...actual,
    readRestoredSessionTranscript: async (
      ...args: Parameters<typeof actual.readRestoredSessionTranscript>
    ) => {
      const held = observed.restoration;
      if (args[0].sessionId === held?.sessionId) {
        held.entered();
        await held.wait;
      }
      return actual.readRestoredSessionTranscript(...args);
    },
  };
});

afterAll(() => observed.timers.mockRestore());

afterEach(() => {
  observed.dispatch = undefined;
  observed.restoration = undefined;
  for (const worker of observed.workers.splice(0)) {
    expect(worker.threadId).toBe(-1);
  }
});

async function seed(state: OpenClawTestState, agentId: string, sessionId: string) {
  const target = {
    agentId,
    sessionId,
    sessionKey: `agent:${agentId}:${sessionId}`,
    storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
  };
  const entry = { sessionId, updatedAt: 1 };
  await replaceSessionEntry(target, entry);
  await replaceTranscriptEvents(target, [
    { type: "session", version: 3, id: sessionId },
    {
      type: "message",
      id: `${sessionId}-message`,
      parentId: null,
      message: { role: "user", content: sessionId },
    },
  ]);
  await waitForSessionTranscriptProjection(target);
  const params = {
    entry,
    provider: undefined,
    sessionId,
    storePath: target.storePath,
    sessionAgentId: agentId,
    canonicalKey: target.sessionKey,
    max: 20,
    maxHistoryBytes: 100_000,
    effectiveMaxChars: 8000,
    offset: undefined,
    messageId: undefined,
  };
  return {
    path: resolveOpenClawAgentSqlitePath({ agentId, env: state.env }),
    read: () => readChatHistoryPage(params),
  };
}

it("closes A through native exit while active and queued B pages survive, then reopens replaced A", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const a = await seed(state, "main", "close-a");
    const b = await seed(state, "other", "active-b");
    const c = await seed(state, "other", "queued-b");
    await a.read();
    const oldWorker = observed.workers.at(-1)!;
    let closing: Promise<boolean> | undefined;
    observed.dispatch = (message) => {
      const input = asOptionalRecord(asOptionalRecord(message)?.input);
      const params = asOptionalRecord(asOptionalRecord(input?.request)?.params);
      if (params?.sessionId === "active-b") {
        observed.dispatch = undefined;
        closing = closeOpenClawAgentDatabaseByPathAsync(a.path, "main");
      }
    };
    const results = await Promise.all([b.read(), c.read()]);
    expect(closing).toBeDefined();
    await closing;
    expect(results.map((page) => page.messages.map(readChatHistoryMessageId))).toEqual([
      ["active-b-message"],
      ["queued-b-message"],
    ]);
    expect(oldWorker.threadId).toBe(-1);
    // This also exercises Windows replacement while the unrelated agent remains usable.
    fs.copyFileSync(a.path, `${a.path}.replacement`);
    fs.renameSync(a.path, `${a.path}.previous`);
    fs.renameSync(`${a.path}.replacement`, a.path);
    expect((await a.read()).messages.map(readChatHistoryMessageId)).toEqual(["close-a-message"]);
    expect((await b.read()).messages.map(readChatHistoryMessageId)).toEqual(["active-b-message"]);
  });
});

it("rejects the captured generation when A closes during restoration before worker admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const a = await seed(state, "main", "restoring-a");
    const b = await seed(state, "other", "unrelated-b");
    await b.read();
    const entered = createDeferredCore();
    const gate = createDeferredCore();
    observed.restoration = {
      sessionId: "restoring-a",
      entered: entered.resolve,
      wait: gate.promise,
    };
    const pending = a.read();
    const failure = expect(pending).rejects.toThrow("revoked");
    try {
      await entered.promise;
      await closeOpenClawAgentDatabaseByPathAsync(a.path, "main");
      expect((await b.read()).messages.map(readChatHistoryMessageId)).toEqual([
        "unrelated-b-message",
      ]);
    } finally {
      observed.restoration = undefined;
      gate.resolve();
    }
    await failure;
    expect((await a.read()).messages.map(readChatHistoryMessageId)).toEqual([
      "restoring-a-message",
    ]);
  });
});

it("leaves the unrelated warm worker running when admission rejects a request before dispatch", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const b = await seed(state, "other", "overload-b");
    await b.read();
    const worker = observed.workers.at(-1)!;
    const threadId = worker.threadId;
    await expect(
      withSessionHistoryWorkerDatabase(
        {
          agentId: "main",
          path: resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
        },
        (owner) =>
          owner.run(() => {
            throw new Error("refused factory must not run");
          }, DEFAULT_WORKER_PENDING_BYTES + 1),
      ),
    ).rejects.toMatchObject({ code: "overloaded" });
    expect(worker.threadId).toBe(threadId);
    expect((await b.read()).messages.map(readChatHistoryMessageId)).toEqual(["overload-b-message"]);
    expect(observed.workers.at(-1)).toBe(worker);
  });
});

it("joins the history worker and releases database custody when its 30-minute idle timer fires", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const a = await seed(state, "main", "idle-a");
    await a.read();
    const worker = observed.workers.at(-1)!;
    const index = observed.timers.mock.calls.findLastIndex((call) => call[1] === 30 * 60_000);
    expect(index).toBeGreaterThanOrEqual(0);
    const [expire] = observed.timers.mock.calls[index]!;
    const timer = observed.timers.mock.results[index]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    clearTimeout(timer);
    expire();
    await expect.poll(() => worker.threadId).toBe(-1);
    expect((await a.read()).messages.map(readChatHistoryMessageId)).toEqual(["idle-a-message"]);
    expect(observed.workers.at(-1)).not.toBe(worker);
  });
});
