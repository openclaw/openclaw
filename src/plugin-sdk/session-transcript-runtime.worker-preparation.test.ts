import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  replaceSessionEntry as replaceEntry,
  replaceSessionEntrySync as replaceEntrySync,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { readTranscriptEventRows } from "../config/sessions/session-accessor.sqlite-read.js";
import { appendExpectedSessionTranscriptTurn as appendTurn } from "../config/sessions/session-accessor.sqlite-transcript-turn.js";
import { appendTranscriptMessageSnapshotSync } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { captureSessionEntryReadSource } from "../config/sessions/session-entry-read-source.js";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import {
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  withCodexSessionTranscriptMirrorWrite,
  withCodexSessionTranscriptMirrorWriteLock,
} from "./codex-session-transcript-runtime.js";
import {
  appendSessionTranscriptMessageByIdentity as appendMessage,
  appendSessionTranscriptMessageByIdentityStrict as appendStrict,
  withSessionTranscriptWrite,
  withSessionTranscriptWriteLock,
} from "./session-transcript-runtime.js";

const delivery = vi.hoisted((): { beforeTurnCommit?: () => void } => ({}));
vi.mock("../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: Object.assign(
      (...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>) => {
        const owner = actual.captureOpenClawAgentDatabaseExecution(...args);
        const runExisting = owner.runExisting.bind(owner);
        owner.runExisting = (source, operation, options) =>
          runExisting(
            source,
            (worker) =>
              operation({
                execute: async (command, commandOptions) => {
                  if (command.type === "session.turn.commit") {
                    delivery.beforeTurnCommit?.();
                  }
                  return await worker.execute(command, commandOptions);
                },
              }),
            options,
          );
        return owner;
      },
      actual.captureOpenClawAgentDatabaseExecution,
    ),
  };
});

afterEach(() => {
  delivery.beforeTurnCommit = undefined;
  vi.restoreAllMocks();
});

it("retains callback ordering and names each migration once per plugin across reloads", async () => {
  await withSeed(async (f) => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const instances = ["first", "second", "first"].map(
      (id) => new PluginInstance(`transcript-compat-${id}`),
    );
    const guard = vi.fn(() => {
      expect(f.database.db.isTransaction).toBe(true);
      const row = readExactSessionEntryRow(f.database, f.scope.sessionKey);
      expect(row?.entry.sessionId).toBe(f.scope.sessionId);
    });
    try {
      for (const instance of instances) {
        await instance.run(async () => {
          const warningCount = warning.mock.calls.length;
          await withSessionTranscriptWrite(f.scope, () => undefined);
          await withCodexSessionTranscriptMirrorWrite(f.scope, () => undefined);
          expect(warning).toHaveBeenCalledTimes(warningCount);
          await expect(
            appendStrict({
              ...f.scope,
              message: { role: "assistant", content: "guarded" },
              prepareMessageAfterIdempotencyCheck: (message) => message,
              beforeFreshMessageCommit: guard,
            }),
          ).resolves.toMatchObject({ kind: "result", result: { appended: true } });
          await withSessionTranscriptWriteLock(f.scope, () => undefined);
          await withCodexSessionTranscriptMirrorWriteLock(f.scope, () => undefined);
        });
      }
      expect([guard.mock.calls.length, warning.mock.calls.length]).toEqual([3, 8]);
      for (const plugin of ["transcript-compat-first", "transcript-compat-second"]) {
        for (const [method, replacement] of [
          [
            "prepareMessageAfterIdempotencyCheck",
            "preparation.prepareMessage outside the transaction",
          ],
          ["beforeFreshMessageCommit", "preparation.source"],
          ["withSessionTranscriptWriteLock", "withSessionTranscriptWrite"],
          ["withCodexSessionTranscriptMirrorWriteLock", "withCodexSessionTranscriptMirrorWrite"],
        ]) {
          expect(warning).toHaveBeenCalledWith(
            expect.stringContaining(
              `Plugin ${plugin}: ${method} is deprecated; use ${replacement}`,
            ),
            { code: "DEP_SESSION_PERSISTENCE", type: "DeprecationWarning" },
          );
        }
      }
      for (const [message] of warning.mock.calls) {
        expect(message).toContain("Final compatibility day: 2026-12-31");
        expect(message).toContain("first January 2027 stable release");
      }
    } finally {
      warning.mockRestore();
      await Promise.all(instances.map((instance) => instance.dispose()));
    }
  });
});

it("refuses legacy incognito callbacks while prepared unbound writes use the memory owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const sessionKey = "agent:main:dashboard:incognito-private";
    const target = { agentId: "main", sessionId: "private", sessionKey, env };
    const prepare = vi.fn((message: unknown) => message);
    const guard = vi.fn();
    const locked = vi.fn();
    const message = { role: "assistant", content: "private" };
    const expectedError = /preparation\.prepareMessage \/ preparation\.source/u;
    for (const operation of [
      () => appendStrict({ ...target, message, prepareMessageAfterIdempotencyCheck: prepare }),
      () => appendMessage({ ...target, message, beforeFreshMessageCommit: guard }),
      () => withSessionTranscriptWriteLock(target, locked),
      () => withCodexSessionTranscriptMirrorWriteLock(target, locked),
    ]) {
      await expect(operation()).rejects.toThrow(expectedError);
    }
    expect([prepare, guard, locked].map((callback) => callback.mock.calls)).toEqual([[], [], []]);
    const path = resolveIncognitoOpenClawAgentSqlitePath(target);
    const location = { agentId: target.agentId, path };
    setRuntimeConfigSnapshot({});
    const sql = observeHostDataSql();
    try {
      await replaceEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      const candidate = { ...message, idempotencyKey: "memory-private" };
      const prepareMemory = vi.fn(async (value: typeof candidate) => ({
        ...value,
        content: "prepared",
      }));
      const events = await withSessionTranscriptWrite(target, async (transcript) => {
        const options = {
          eventId: "memory-private",
          message: candidate,
          idempotencyLookup: "scan" as const,
          preparation: { prepareMessage: prepareMemory },
        };
        const expected = { messageId: "memory-private", message: { content: "prepared" } };
        for (const appended of [true, false]) {
          expect(await transcript.appendMessage(options)).toMatchObject({ ...expected, appended });
        }
        await expect(
          transcript.appendMessage({
            message: { ...message, idempotencyKey: "suppressed" },
            preparation: { prepareMessage: async () => undefined },
          }),
        ).resolves.toBeUndefined();
        return await transcript.readEvents();
      });
      expect(prepareMemory).toHaveBeenCalledOnce();
      expect(events).toMatchObject([
        {},
        { type: "message", id: "memory-private", message: { content: "prepared" } },
      ]);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
      clearRuntimeConfigSnapshot();
      memorySessionActorOwners.closeDatabase(location);
    }
  });
});

type Prepare = (value: unknown) => Promise<unknown>;
async function seed(env: NodeJS.ProcessEnv) {
  setRuntimeConfigSnapshot({});
  const sessionKey = "agent:main:append";
  const target = { agentId: "main", sessionId: "append-session", sessionKey, env };
  await replaceEntry(target, { sessionId: target.sessionId, updatedAt: 1, label: "initial" });
  const database = openOpenClawAgentDatabase(target);
  const scope = { ...target, storePath: database.path };
  return {
    database,
    scope,
    appendTurn: (message: unknown, prepare: Prepare, eventId?: string) => {
      const workerPreparation = { prepareMessageAfterIdempotencyCheckAsync: prepare };
      return appendTurn(scope, {
        expectedSessionId: scope.sessionId,
        sessionFile: "synthetic-session.jsonl",
        messages: [{ eventId, message, workerPreparation }],
      });
    },
    messages: () =>
      readTranscriptEventRows(database, target.sessionId)
        .map((row) => JSON.parse(row.eventJson))
        .filter((event) => event.type === "message"),
  };
}

type Fixture = Awaited<ReturnType<typeof seed>>;
const appendExternal = (scope: Fixture["scope"], eventId: string, message: unknown) =>
  expect(appendTranscriptMessageSnapshotSync(scope, { eventId, message }).ok).toBe(true);
function withSeed(run: (fixture: Fixture) => Promise<void>) {
  return withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => run(await seed(env)));
}
it("prepares strict appends without caller-thread SQL and retains the released sync callback type", async () => {
  type Message = { role: string; content: string; idempotencyKey: string };
  type Params = Parameters<typeof appendStrict<Message>>[0];
  expectTypeOf<NonNullable<Params["prepareMessageAfterIdempotencyCheck"]>>().toEqualTypeOf<
    (message: Message) => Message | undefined
  >();
  expectTypeOf<NonNullable<Params["prepareMessageAfterIdempotencyCheckAsync"]>>().toEqualTypeOf<
    (message: Message) => Promise<Message | undefined>
  >();
  await withSeed(async ({ scope, messages }) => {
    const prepare = vi.fn(async (message: Message) => ({ ...message, content: "prepared" }));
    const sql = observeHostDataSql();
    try {
      const message = { role: "assistant", content: "original", idempotencyKey: "strict-key" };
      const preparation = { prepareMessage: prepare };
      const result = await appendStrict({ ...scope, message, preparation });
      const expected = { appended: true, message: { content: "prepared" } };
      expect(result).toMatchObject({ kind: "result", result: expected });
      expect(prepare).toHaveBeenCalledOnce();
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(messages()).toHaveLength(1);
  });
});

it.each([false, true])("rechecks sources after foreign replay=%s", async (foreignReplay) => {
  await withSeed(async ({ database, scope, messages }) => {
    const message = { role: "assistant", content: "accepted", idempotencyKey: "foreign-key" };
    const source = captureSessionEntryReadSource(database, undefined);
    const legacyGuard = vi.fn(() => {
      throw new Error("Legacy guard should use its prepared source");
    });
    const assertion: SessionSourceAssertion = Object.assign(legacyGuard, {
      async prepareSessionSource() {
        // This separate native connection commits after the worker's first duplicate check.
        if (foreignReplay) {
          appendExternal(scope, "foreign-message", message);
        }
        replaceEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 2, label: "foreign" });
        return {
          assertCurrent() {},
          checks: [
            {
              predicate: {
                source,
                sessionKey: scope.sessionKey,
                fields: ["label" as const],
                expected: { sessionId: scope.sessionId, label: "initial" },
              },
              refuse(): never {
                throw new Error("Prepared transcript source changed");
              },
            },
          ],
        };
      },
    });
    const appending = appendStrict({ ...scope, message, preparation: { source: assertion } });
    if (foreignReplay) {
      const result = { appended: false, messageId: "foreign-message", message };
      expect(await appending).toMatchObject({ kind: "result", result });
    } else {
      await expect(appending).rejects.toThrow("Prepared transcript source changed");
    }
    expect(legacyGuard).not.toHaveBeenCalled();
    expect(messages()).toHaveLength(foreignReplay ? 1 : 0);
  });
});

it("rejects an async prepared message after a foreign transcript write", async () => {
  await withSeed(async (f) => {
    const prepare = vi.fn(async (message: unknown) => {
      if (prepare.mock.calls.length === 1) {
        appendExternal(f.scope, "foreign", { role: "assistant", content: "foreign" });
      }
      return message;
    });
    const message = { role: "assistant", content: "prepared", idempotencyKey: "prepared" };
    const appending = f.appendTurn(message, prepare, "prepared");
    await expect(appending).rejects.toThrow("SQLite transcript changed while preparing rewrite");
    expect(f.messages().map((event) => event.id)).toEqual(["foreign"]);
  });
});

it("replays a skipped async preparation after a foreign transcript append", async () => {
  await withSeed(async (f) => {
    const message = { role: "assistant", content: "original", idempotencyKey: "existing" };
    appendExternal(f.scope, "existing", message);
    delivery.beforeTurnCommit = () => {
      delivery.beforeTurnCommit = undefined;
      appendExternal(f.scope, "foreign", { role: "assistant", content: "foreign" });
    };
    const prepare = vi.fn(async (value: unknown) => value);
    await expect(f.appendTurn(message, prepare)).resolves.toMatchObject({
      appendedMessages: [{ appended: false, messageId: "existing" }],
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(f.messages().map((event) => event.id)).toEqual(["existing", "foreign"]);
  });
});
