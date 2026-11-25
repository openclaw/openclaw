import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { historyParams, messageEvent } from "../../gateway/session-history-events.test-support.js";
import { readSessionHistoryRequest } from "../../gateway/session-history-worker-reader.js";
import {
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "../../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../../infra/database-engine/mixed-agent.conformance.test-support.js";
import {
  OpenClawAgentDatabaseReadOnlyScope,
  runInScopedOpenClawAgentReadSnapshot,
  withScopedOpenClawAgentDatabaseReadOnly,
} from "../../state/openclaw-agent-db-readonly-scope.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { replaceSqliteTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { withHistoryDatabase } from "./session-transcript-worker-scopes.js";

const statements = channel("openclaw.database.statement");
let observed: string[] = [];
const observe = (message: unknown) => {
  observed.push((message as { sql?: string }).sql ?? "");
};
const begins = () => observed.filter((sql) => /^BEGIN\b/i.test(sql));
const rollbacks = () => observed.filter((sql) => /^ROLLBACK\b/i.test(sql));

afterEach(() => {
  statements.unsubscribe(observe);
  observed = [];
});

describe.skipIf(!mixedAgentConnection)("PostgreSQL chat.history page reads", () => {
  const pair = useMixedAgentPair("postgres", "postgres");
  beforeAll(() => {
    // The history worker's awaited page reads run here on the test thread.
    installDatabaseProcessRole("cli-oneshot");
  });

  // A Claude CLI binding adds a revision read and, after a provider switch, a separate tail read.
  it.each([
    { name: "sparse page", entry: {}, provider: undefined },
    {
      name: "Claude CLI session after a provider switch",
      entry: { cliSessionBindings: { "claude-cli": { sessionId: "claude-session" } } },
      provider: "openai",
    },
  ])("reads a $name in one read-only snapshot", async ({ entry, provider }) => {
    const database = withEngineStoreAdmission(() => openOpenClawAgentDatabase({ agentId: "main" }));
    const sessionId = randomUUID();
    const scope = {
      agentId: "main",
      storePath: database.path,
      sessionKey: `agent:main:history-${sessionId}`,
      sessionId,
    };
    // Hidden replies make the tail scan read several pages for a two-message response.
    const ids = Array.from({ length: 252 }, (_, index) => `row-${index}`);
    withEngineStoreAdmission(() => {
      replaceSessionEntrySync(scope, { sessionId, updatedAt: 1 });
      const resolved = resolveSqliteTranscriptScope(scope);
      runOpenClawAgentWriteTransaction(
        (writable) =>
          replaceSqliteTranscriptEventsInTransaction(writable, resolved, [
            { type: "session", version: 3, id: sessionId },
            ...ids.map((id, index) =>
              messageEvent(
                id,
                index === 0
                  ? { role: "user", content: "Question before silent activity" }
                  : {
                      role: "assistant",
                      content: index === ids.length - 1 ? "Visible final answer" : "NO_REPLY",
                    },
                ids[index - 1] ?? null,
              ),
            ),
          ]),
        toDatabaseOptions(resolved),
      );
    });
    const target = { agentId: "main", path: database.path };
    statements.subscribe(observe);
    const reply = await withHistoryDatabase(target, "history.rpc", () =>
      readSessionHistoryRequest(
        {
          kind: "rpc",
          params: {
            ...historyParams(scope, { sessionId, updatedAt: 1, ...entry }),
            provider,
            max: 2,
          },
        },
        {
          transcript: { ...scope, sessionFile: scope.sessionKey },
          database: target,
          stateDatabase: {
            path: path.join(pair.root, "state", "openclaw.sqlite"),
            environment: { ...process.env, OPENCLAW_STATE_DIR: pair.root },
          },
        },
      ),
    );
    statements.unsubscribe(observe);

    const page = reply.ok && reply.value.kind === "rpc" ? reply.value.page : undefined;
    expect(page?.messages.map((message) => (message as { content?: unknown }).content)).toEqual([
      "Question before silent activity",
      "Visible final answer",
    ]);
    expect(page?.pagination).toMatchObject({ totalMessages: 252, rawPageMessages: 252 });
    expect(begins()).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"]);
    expect(rollbacks()).toHaveLength(1);
  });

  it("rolls back a held snapshot after a failed read and opens a fresh one", async () => {
    const database = withEngineStoreAdmission(() => openOpenClawAgentDatabase({ agentId: "main" }));
    const target = { agentId: "main", path: database.path };
    const read = (sql: string) =>
      withScopedOpenClawAgentDatabaseReadOnly(({ db }) => db.prepare(sql).get(), target);
    statements.subscribe(observe);
    await new OpenClawAgentDatabaseReadOnlyScope().run(target, () =>
      runInScopedOpenClawAgentReadSnapshot(async () => {
        expect(() => read("SELECT 1 FROM openclaw_missing_table")).toThrow();
        await Promise.resolve();
        // An aborted transaction would reject this read.
        expect(read("SELECT 1 AS value")).toEqual({ found: true, value: { value: 1 } });
      }),
    );
    statements.unsubscribe(observe);
    expect(begins()).toHaveLength(2);
    expect(rollbacks()).toHaveLength(2);
  });
});
