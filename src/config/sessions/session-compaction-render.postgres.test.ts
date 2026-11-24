import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { beforeAll, describe, expect, it } from "vitest";
import {
  collectConversationMessageFact,
  collectConversationRangeDescriptors,
  serializeConversationWithinBudget,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import {
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "../../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../../infra/database-engine/mixed-agent.conformance.test-support.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  appendTranscriptEventsInTransaction,
  replaceSqliteTranscriptEventsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import { readPreparedSessionCompaction } from "./session-compaction-prepared.worker.js";
import { withHistoryDatabase } from "./session-transcript-worker-scopes.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL prepared compaction", () => {
  useMixedAgentPair("postgres", "postgres");
  beforeAll(() => {
    installDatabaseProcessRole("cli-oneshot");
  });

  it("renders and finalizes compaction without one SQL payload request per short message", async () => {
    const store = withEngineStoreAdmission(() => openOpenClawAgentDatabase({ agentId: "main" }));
    const database = { agentId: "main", path: store.path };
    const sessionId = randomUUID();
    const target = { sessionId, sessionKey: `agent:main:compaction-${sessionId}` };
    const scope = { ...target, agentId: database.agentId, storePath: database.path };
    const resolvedScope = resolveSqliteTranscriptScope(scope);
    const messages = Array.from({ length: 160 }, (_, index) => ({
      role: "user" as const,
      content: index === 159 ? `Message 160 ${"x".repeat(20_000)} End` : `Message ${index + 1}`,
      timestamp: index + 1,
    }));
    withEngineStoreAdmission(() => {
      replaceSessionEntrySync(scope, { sessionId, updatedAt: 1 });
      runOpenClawAgentWriteTransaction(
        (writable) =>
          replaceSqliteTranscriptEventsInTransaction(writable, resolvedScope, [
            { type: "session", version: 3, id: sessionId },
            ...messages.map((message, index) => ({
              type: "message" as const,
              id: `row-${index + 1}`,
              parentId: index === 0 ? null : `row-${index}`,
              timestamp: new Date(message.timestamp).toISOString(),
              message,
            })),
          ]),
        toDatabaseOptions(resolvedScope),
      );
    });
    const control = {
      signal: new AbortController().signal,
      runNativeSection: async <T>(operation: () => T | Promise<T>) => operation(),
      throwIfCancelled() {
        this.signal.throwIfAborted();
      },
    };
    const request = { kind: "compaction-preparation" as const, database, target, resolvedScope };
    const preflight = await withHistoryDatabase(database, "compaction", () =>
      readPreparedSessionCompaction({ ...request, operation: { kind: "preflight" } }, control),
    );
    if (!preflight.ok || preflight.value.status !== "preflight") {
      throw new Error("Compaction preflight did not return a source");
    }
    const version = preflight.value.source.version;
    const entries = collectConversationRangeDescriptors(
      messages.map((message, index) => collectConversationMessageFact(message, index + 1)),
    );
    const statements = channel("openclaw.database.statement");
    let payloadRequests = 0;
    const observe = (message: unknown) => {
      const { sql } = message as { sql?: string };
      if (
        sql?.startsWith("select") &&
        sql.includes('"event_zstd"') &&
        sql.includes('"transcript_events"')
      ) {
        payloadRequests++;
      }
    };
    statements.subscribe(observe);
    try {
      const render = (maxChars: number) =>
        withHistoryDatabase(database, "compaction", () =>
          readPreparedSessionCompaction(
            { ...request, operation: { kind: "render", entries, version, maxChars } },
            control,
          ),
        );
      const rendered = await render(160_000);
      expect(rendered.ok && rendered.value).toMatchObject({
        status: "rendered",
        conversation: {
          text: messages.map(({ content }) => `[User]: ${content}`).join("\n\n"),
          omittedEntries: 0,
          trimmedEntries: 0,
        },
      });
      expect(payloadRequests).toBeGreaterThan(0);
      expect(payloadRequests).toBeLessThanOrEqual(8);

      payloadRequests = 0;
      const sampled = await render(4_000);
      const expected = serializeConversationWithinBudget(messages, 4_000);
      expect(expected.omittedEntries).toBeGreaterThan(0);
      expect(expected.trimmedEntries).toBeGreaterThan(0);
      expect(sampled.ok && sampled.value).toMatchObject({
        status: "rendered",
        conversation: expected,
      });
      expect(payloadRequests).toBeLessThanOrEqual(8);

      // A message appended while the summary was generated must survive finalization.
      withEngineStoreAdmission(() =>
        runOpenClawAgentWriteTransaction(
          (writable) =>
            appendTranscriptEventsInTransaction(writable, resolvedScope, [
              {
                type: "message",
                id: "pending",
                parentId: "row-160",
                timestamp: new Date(161).toISOString(),
                message: { role: "user", content: "Pending request", timestamp: 161 },
              },
            ]),
          toDatabaseOptions(resolvedScope),
        ),
      );
      payloadRequests = 0;
      const finalized = await withHistoryDatabase(database, "compaction", () =>
        readPreparedSessionCompaction(
          {
            ...request,
            operation: {
              kind: "finalize",
              version,
              retainedSequences: Array.from({ length: 140 }, (_, index) => index + 21),
              summary: {
                summary: "Prior conversation",
                firstKeptEntryId: "row-21",
                tokensBefore: 8000,
              },
              work: { itemId: "compaction", pendingEntryId: "pending" },
            },
          },
          control,
        ),
      );
      expect(finalized.ok && finalized.value).toMatchObject({
        status: "finalized",
        messageCountAfter: 142,
      });
      expect(payloadRequests).toBeLessThanOrEqual(8);
    } finally {
      statements.unsubscribe(observe);
    }
  });
});
