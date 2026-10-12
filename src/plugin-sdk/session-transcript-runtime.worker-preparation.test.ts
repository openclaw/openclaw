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
import { PluginInstance } from "../plugins/plugin-instance.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withCodexSessionTranscriptMirrorWriteLock } from "./codex-session-transcript-runtime.js";
import {
  appendSessionTranscriptMessageByIdentity,
  appendSessionTranscriptMessageByIdentityStrict,
  withSessionTranscriptWrite,
  withSessionTranscriptWriteLock,
} from "./session-transcript-runtime.js";

const delivery = vi.hoisted((): { beforeTurnCommit?: () => void } => ({}));
vi.mock("../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: Object.assign(
      (
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
                    if (command.type === "session.turn.commit") {
                      delivery.beforeTurnCommit?.();
                    }
                    return await worker.execute(command, commandOptions);
                  },
                }),
              options,
            ),
        };
      },
      actual.captureOpenClawAgentDatabaseExecution,
    ),
  };
});

afterEach(() => {
  delivery.beforeTurnCommit = undefined;
  vi.restoreAllMocks();
});

it("retains durable callback ordering and warns once per plugin across legacy writes and reloads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const f = await seed(env);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const instances = [
      new PluginInstance("transcript-compat-first"),
      new PluginInstance("transcript-compat-second"),
      new PluginInstance("transcript-compat-first"),
    ];
    const guard = vi.fn(() => {
      expect(f.database.db.isTransaction).toBe(true);
      expect(readExactSessionEntryRow(f.database, f.scope.sessionKey)?.entry.sessionId).toBe(
        f.scope.sessionId,
      );
    });
    try {
      for (const instance of instances) {
        await instance.run(async () => {
          await expect(
            appendSessionTranscriptMessageByIdentityStrict({
              ...f.scope,
              message: { role: "assistant", content: "guarded" },
              beforeFreshMessageCommit: guard,
            }),
          ).resolves.toMatchObject({ kind: "result", result: { appended: true } });
          await withSessionTranscriptWriteLock(f.scope, () => undefined);
        });
      }
      expect(guard).toHaveBeenCalledTimes(3);
      expect(warning).toHaveBeenCalledTimes(2);
      for (const plugin of ["transcript-compat-first", "transcript-compat-second"]) {
        expect(warning).toHaveBeenCalledWith(expect.stringContaining(`Plugin ${plugin}:`), {
          code: "DEP_SESSION_PERSISTENCE",
          type: "DeprecationWarning",
        });
      }
      for (const [message] of warning.mock.calls) {
        expect(message).toContain("preparation.prepareMessage / preparation.source");
        expect(message).toContain("next Plugin SDK major");
      }
    } finally {
      warning.mockRestore();
      await Promise.all(instances.map((instance) => instance.dispose()));
    }
  });
});

it("refuses legacy incognito callbacks while prepared unbound writes retain the native owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const target = {
      agentId: "main",
      sessionId: "private",
      sessionKey: "agent:main:dashboard:incognito-private",
      env,
    };
    const prepare = vi.fn((message: unknown) => message);
    const guard = vi.fn();
    const locked = vi.fn();
    const message = { role: "assistant", content: "private" };
    const expected = /preparation\.prepareMessage \/ preparation\.source/u;
    await expect(
      appendSessionTranscriptMessageByIdentityStrict({
        ...target,
        message,
        prepareMessageAfterIdempotencyCheck: prepare,
      }),
    ).rejects.toThrow(expected);
    await expect(
      appendSessionTranscriptMessageByIdentity({
        ...target,
        message,
        beforeFreshMessageCommit: guard,
      }),
    ).rejects.toThrow(expected);
    await expect(withSessionTranscriptWriteLock(target, locked)).rejects.toThrow(expected);
    await expect(withCodexSessionTranscriptMirrorWriteLock(target, locked)).rejects.toThrow(
      expected,
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
    expect(locked).not.toHaveBeenCalled();
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const candidate = { ...message, idempotencyKey: "native-private" };
    const prepareNative = vi.fn(async (value: typeof candidate) => ({
      ...value,
      content: "native prepared",
    }));
    const events = await withSessionTranscriptWrite(target, async (transcript) => {
      const options = {
        eventId: "native-private",
        message: candidate,
        idempotencyLookup: "scan" as const,
        preparation: { prepareMessage: prepareNative },
      };
      await expect(transcript.appendMessage(options)).resolves.toMatchObject({
        appended: true,
        messageId: "native-private",
        message: { content: "native prepared" },
      });
      await expect(transcript.appendMessage(options)).resolves.toMatchObject({
        appended: false,
        messageId: "native-private",
        message: { content: "native prepared" },
      });
      await expect(
        transcript.appendMessage({
          message: { ...message, idempotencyKey: "suppressed" },
          preparation: { prepareMessage: async () => undefined },
        }),
      ).resolves.toBeUndefined();
      return await transcript.readEvents();
    });
    expect(prepareNative).toHaveBeenCalledOnce();
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      type: "message",
      id: "native-private",
      message: { content: "native prepared" },
    });
    expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
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
        preparation: { prepareMessage: prepare },
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
        preparation: { source: beforeFreshMessageCommit },
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

it("rejects an async prepared message after a foreign transcript write", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const f = await seed(env);
    const prepare = vi.fn(async (message: unknown) => {
      if (prepare.mock.calls.length === 1) {
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
    await expect(appending).rejects.toThrow("SQLite transcript changed while preparing rewrite");
    expect(
      f
        .events()
        .filter((event) => event.type === "message")
        .map((event) => event.id),
    ).toEqual(["foreign"]);
  });
});

it("replays a skipped async preparation after a foreign transcript append", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const f = await seed(env);
    const message = { role: "assistant", content: "original", idempotencyKey: "existing" };
    expect(appendTranscriptMessageSnapshotSync(f.scope, { message, eventId: "existing" }).ok).toBe(
      true,
    );
    delivery.beforeTurnCommit = () => {
      delivery.beforeTurnCommit = undefined;
      expect(
        appendTranscriptMessageSnapshotSync(f.scope, {
          message: { role: "assistant", content: "foreign" },
          eventId: "foreign",
        }).ok,
      ).toBe(true);
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
