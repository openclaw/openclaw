import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { readTranscriptEventRows } from "../config/sessions/session-accessor.sqlite-read.js";
import { appendExpectedSessionTranscriptTurn } from "../config/sessions/session-accessor.sqlite-transcript-turn.js";
import { appendTranscriptMessageSnapshotSync } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { appendSessionTranscriptMessageByIdentityStrict } from "./session-transcript-runtime.js";

const delivery = vi.hoisted((): { afterCommit?: (type: string) => void } => ({}));
vi.mock("../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ): ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution> => {
      const owner = actual.captureOpenClawAgentDatabaseExecution(...args);
      return {
        ...owner,
        get fileIdentity() {
          return owner.fileIdentity;
        },
        runExisting: (source, operation, options) =>
          owner.runExisting(
            source,
            (worker) =>
              operation({
                execute: async (command, commandOptions) => {
                  const result = await worker.execute(command, commandOptions);
                  delivery.afterCommit?.(command.type);
                  return result;
                },
              }),
            options,
          ),
      };
    },
  };
});

afterEach(() => {
  delivery.afterCommit = undefined;
  vi.restoreAllMocks();
});

it("rejects compound async preparation before invoking any preparer", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const f = await seed(env);
    const prepare = vi.fn(async (message: unknown) => message);
    for (const keys of [
      ["same", "same"],
      ["first", "second"],
    ]) {
      await expect(
        appendExpectedSessionTranscriptTurn(f.scope, {
          expectedSessionId: f.scope.sessionId,
          sessionFile: "synthetic-session.jsonl",
          messages: keys.map((idempotencyKey) => ({
            message: { role: "assistant", content: idempotencyKey, idempotencyKey },
            workerPreparation: { prepareMessageAfterIdempotencyCheckAsync: prepare },
          })),
        }),
      ).rejects.toThrow(
        "Awaited transcript preparation requires one message without transaction predicates",
      );
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(f.events()).toEqual([]);
  });
});

it("retains synchronous same-store SDK guards in the native adapter", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const f = await seed(env);
    const guard = vi.fn(() => {
      expect(readExactSessionEntryRow(f.database, f.scope.sessionKey)?.entry.sessionId).toBe(
        f.scope.sessionId,
      );
    });
    await expect(
      appendSessionTranscriptMessageByIdentityStrict({
        ...f.scope,
        message: { role: "assistant", content: "guarded" },
        beforeFreshMessageCommit: guard,
      }),
    ).resolves.toMatchObject({ kind: "result", result: { appended: true } });
    expect(guard).toHaveBeenCalledOnce();
  });
});

it("prepares a message once when its authority selects the native adapter", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const f = await seed(env);
    let preparations = 0;
    const first = { role: "assistant", content: "original", idempotencyKey: "first" };
    const prepare = vi.fn(async () => ({ ...first, content: `prepared ${++preparations}` }));
    const nativeSource: SessionSourceAssertion = Object.assign(() => {}, {
      async prepareSessionSource() {
        return { nativeSource: true, assertCurrent() {}, checks: [] };
      },
    });
    await expect(
      appendExpectedSessionTranscriptTurn(f.scope, {
        expectedSessionId: f.scope.sessionId,
        sessionFile: "synthetic-session.jsonl",
        messages: [
          {
            message: first,
            workerPreparation: {
              prepareMessageAfterIdempotencyCheckAsync: prepare,
              beforeFreshMessageCommit: nativeSource,
            },
          },
        ],
      }),
    ).resolves.toMatchObject({
      appendedMessages: [{ message: { content: "prepared 1" } }],
    });
    expect(prepare).toHaveBeenCalledOnce();
  });
});

async function seed(env: NodeJS.ProcessEnv) {
  const target = {
    agentId: "main",
    sessionId: "append-session",
    sessionKey: "agent:main:append",
    env,
  };
  await replaceSessionEntry(target, {
    sessionId: target.sessionId,
    updatedAt: 1,
    label: "initial",
  });
  const database = openOpenClawAgentDatabase(target);
  return {
    database,
    scope: { ...target, storePath: database.path },
    events: () =>
      readTranscriptEventRows(database, target.sessionId).map((row) => JSON.parse(row.eventJson)),
  };
}

it("prepares strict appends without caller-thread SQL and retains the released sync callback type", async () => {
  type Message = { role: string; content: string; idempotencyKey: string };
  type Params = Parameters<typeof appendSessionTranscriptMessageByIdentityStrict<Message>>[0];
  expectTypeOf<NonNullable<Params["prepareMessageAfterIdempotencyCheck"]>>().toEqualTypeOf<
    (message: Message) => Message | undefined
  >();
  expectTypeOf<NonNullable<Params["prepareMessageAfterIdempotencyCheckAsync"]>>().toEqualTypeOf<
    (message: Message) => Promise<Message | undefined>
  >();
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const { database, scope } = await seed(env);
    const prepare = vi.fn(async (message: Message) => ({ ...message, content: "prepared" }));
    const sql = observeHostDataSql();
    try {
      const result = await appendSessionTranscriptMessageByIdentityStrict({
        ...scope,
        message: { role: "assistant", content: "original", idempotencyKey: "strict-key" },
        prepareMessageAfterIdempotencyCheckAsync: prepare,
      });
      expect(result).toMatchObject({
        kind: "result",
        result: { appended: true, message: { content: "prepared" } },
      });
      expect(prepare).toHaveBeenCalledOnce();
      const executions = sql.calls.slice(1).reduce((sum, call) => sum + call.mock.calls.length, 0);
      expect(sql.queries, `MAIN strict turn: ${executions} SQL executions`).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(
      readTranscriptEventRows(database, scope.sessionId).filter(
        (row) => JSON.parse(row.eventJson).type === "message",
      ),
    ).toHaveLength(1);
  });
});

it.each([false, true])(
  "checks fresh sources after a foreign replay decision (foreignReplay=%s)",
  async (foreignReplay) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const { database, scope } = await seed(env);
      const message = { role: "assistant", content: "accepted", idempotencyKey: "foreign-key" };
      const identity = readOpenClawAgentDatabaseIdentity(database);
      const legacyGuard = vi.fn(() => {
        throw new Error("Legacy guard should use its prepared source");
      });
      const beforeFreshMessageCommit: SessionSourceAssertion = Object.assign(legacyGuard, {
        async prepareSessionSource() {
          // This separate native connection commits after the worker's first duplicate check.
          if (foreignReplay) {
            expect(
              appendTranscriptMessageSnapshotSync(scope, { message, eventId: "foreign-message" })
                .ok,
            ).toBe(true);
          }
          replaceSessionEntrySync(scope, {
            sessionId: scope.sessionId,
            updatedAt: 2,
            label: "foreign",
          });
          return {
            assertCurrent() {},
            checks: [
              {
                predicate: {
                  source: {
                    agentId: scope.agentId,
                    path: database.path,
                    databaseIdentity: identity.identity,
                    databaseBirthtime: identity.birthtime,
                  },
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
      const appending = appendSessionTranscriptMessageByIdentityStrict({
        ...scope,
        message,
        beforeFreshMessageCommit,
      });
      if (foreignReplay) {
        await expect(appending).resolves.toMatchObject({
          kind: "result",
          result: { appended: false, messageId: "foreign-message", message },
        });
      } else {
        await expect(appending).rejects.toThrow("Prepared transcript source changed");
      }
      expect(legacyGuard).not.toHaveBeenCalled();
      expect(
        readTranscriptEventRows(database, scope.sessionId).filter(
          (row) => JSON.parse(row.eventJson).type === "message",
        ),
      ).toHaveLength(foreignReplay ? 1 : 0);
    });
  },
);

it.each([false, true])(
  "commits an async prepared message against its transaction-entry version (foreignWrite=%s)",
  async (foreignWrite) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const f = await seed(env);
      const prepare = vi.fn(async (message: unknown) => {
        if (foreignWrite && prepare.mock.calls.length === 1) {
          expect(
            appendTranscriptMessageSnapshotSync(f.scope, {
              message: { role: "assistant", content: "foreign" },
              eventId: "foreign",
            }).ok,
          ).toBe(true);
        }
        return message;
      });
      const appending = appendExpectedSessionTranscriptTurn(f.scope, {
        expectedSessionId: f.scope.sessionId,
        sessionFile: "synthetic-session.jsonl",
        messages: [
          {
            eventId: "prepared",
            message: { role: "assistant", content: "prepared", idempotencyKey: "prepared" },
            workerPreparation: { prepareMessageAfterIdempotencyCheckAsync: prepare },
          },
        ],
      });
      if (foreignWrite) {
        await expect(appending).rejects.toThrow(
          "SQLite transcript changed while preparing rewrite",
        );
      } else {
        await expect(appending).resolves.toMatchObject({
          appendedMessages: [{ appended: true, messageId: "prepared" }],
        });
      }
      expect(
        f
          .events()
          .filter((event) => event.type === "message")
          .map((event) => event.id),
      ).toEqual(foreignWrite ? ["foreign"] : ["prepared"]);
    });
  },
);

it("replays a skipped async preparation after a foreign transcript append", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const f = await seed(env);
    const message = { role: "assistant", content: "original", idempotencyKey: "existing" };
    expect(appendTranscriptMessageSnapshotSync(f.scope, { message, eventId: "existing" }).ok).toBe(
      true,
    );
    let preparations = 0;
    delivery.afterCommit = (type) => {
      if (type === "session.turn.prepare" && ++preparations === 2) {
        expect(
          appendTranscriptMessageSnapshotSync(f.scope, {
            message: { role: "assistant", content: "foreign" },
            eventId: "foreign",
          }).ok,
        ).toBe(true);
      }
    };
    const prepare = vi.fn(async (value: unknown) => value);
    await expect(
      appendExpectedSessionTranscriptTurn(f.scope, {
        expectedSessionId: f.scope.sessionId,
        sessionFile: "synthetic-session.jsonl",
        messages: [
          { message, workerPreparation: { prepareMessageAfterIdempotencyCheckAsync: prepare } },
        ],
      }),
    ).resolves.toMatchObject({ appendedMessages: [{ appended: false, messageId: "existing" }] });
    expect(prepare).not.toHaveBeenCalled();
    expect(
      f
        .events()
        .filter((event) => event.type === "message")
        .map((event) => event.id),
    ).toEqual(["existing", "foreign"]);
  });
});
