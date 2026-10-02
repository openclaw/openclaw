import path from "node:path";
import { constants } from "node:sqlite";
import { expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessages,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { resolveCronJobsStorePath, saveCronJobsStore } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  prepareForwardedMessageCronJobNameResolver,
  projectForwardedMessages,
} from "./chat-display-projection.history.js";
import { SerializedJsonArray } from "./serialized-json.js";
import { readChatHistoryPage } from "./server-methods/chat-history-pages.js";
import {
  readSessionHistorySnapshotAsync,
  SessionHistorySseState,
} from "./session-history-state.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";

it("batches automation names across history reads after rename and deletion without a source session", async () => {
  const jobCount = 32;
  await withOpenClawTestState({ label: "cron-attribution" }, async (state) => {
    const job: CronJob = {
      id: "daily-report",
      name: "Daily report",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "Check the queue." },
      state: {},
    };
    const storePath = resolveCronJobsStorePath();
    const bindingIds = [
      "daily-report",
      "report-\ufffd",
      "report\u0000suffix",
      "report\\u0000suffix",
      "DAILY-report",
      "report-é",
    ];
    const jobs = Array.from({ length: jobCount }, (_, index) =>
      index === 0
        ? job
        : { ...job, id: bindingIds[index] ?? `report-${index}`, name: `Report ${index}` },
    );
    const entry = { sessionId: "destination", updatedAt: 1 };
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: entry.sessionId,
      storePath: path.join(state.sessionsDir("main"), "sessions.json"),
    };
    await replaceSessionEntry(scope, entry);
    await replaceTranscriptEvents(scope, [{ type: "session", version: 3, id: entry.sessionId }]);
    const sourceSessionKey = "agent:main:cron:daily-report:run:completed-run";
    const message = {
      role: "user",
      content: "The queue is clear.",
      provenance: { kind: "inter_session", sourceTool: "sessions_send", sourceSessionKey },
    };
    const messages = jobs.map((current, index) =>
      index === 0
        ? message
        : {
            role: "user",
            content: `Report ${index} is ready.`,
            provenance: {
              kind: "internal_system",
              sourceTool: "cron",
              jobId: index === 1 ? "report-\ud800" : current.id,
              runId: "completed-run",
              sourceSessionKey: `agent:main:cron:${current.id}:run:completed-run`,
            },
          },
    );
    messages.push(message);
    const pageParams = {
      entry,
      provider: "openai",
      sessionId: scope.sessionId,
      storePath: scope.storePath,
      sessionAgentId: scope.agentId,
      canonicalKey: scope.sessionKey,
      max: messages.length + 10,
      offset: undefined,
      messageId: undefined,
      maxHistoryBytes: 1_000_000,
      effectiveMaxChars: 100_000,
    };
    const database = openOpenClawStateDatabase({ env: state.env });
    // Host-boundary counts exclude the history worker's independent connection.
    const measure = async <T>(operation: string, read: () => T | Promise<T>): Promise<T> => {
      const counter = trackSqliteStatementExecutions(database.db, ["names"], (sql) =>
        /\bfrom\s+"?cron_jobs"?\b/iu.test(sql) ? "names" : null,
      );
      try {
        const result = await read();
        expect(counter.counts.names, operation).toBe(0);
        return result;
      } finally {
        counter.restore();
      }
    };
    expect((await measure("no-id-rpc", () => readChatHistoryPage(pageParams))).messages).toEqual(
      [],
    );
    const emptySnapshot = await measure("no-id-http", () =>
      readSessionHistorySnapshotAsync({
        target: { ...scope, sessionEntry: entry },
        maxChars: 100_000,
      }),
    );
    expect(emptySnapshot.history.messages).toEqual([]);
    const emptySse = SessionHistorySseState.fromSnapshot({
      target: { ...scope, sessionEntry: entry },
      snapshot: emptySnapshot,
    });
    expect(
      (
        await measure("no-id-sse", async () =>
          (
            await emptySse.prepareInlineMessage({
              message: { role: "user", content: "An ordinary message." },
            })
          )(),
        )
      )?.message,
    ).toMatchObject({ role: "user", content: "An ordinary message." });
    await appendTranscriptMessage(scope, { eventId: "forwarded-result", message, now: 2 });
    await appendTranscriptMessages(scope, {
      messages: messages.slice(1).map((next, index) => ({
        eventId: `forwarded-result-${index + 1}`,
        message: next,
        now: index + 3,
      })),
    });
    let sse: SessionHistorySseState | undefined;
    for (const name of ["Daily report", "Renamed report", undefined]) {
      await saveCronJobsStore(storePath, {
        version: 1,
        jobs: name
          ? jobs.map((current, index) =>
              Object.assign({}, current, {
                name: index === 0 ? name : `${name} ${index}`,
                updatedAtMs: 3,
              }),
            )
          : [],
      });
      const expected = messages.map((current, index) => ({
        role: "assistant",
        content: current.content,
        senderSession: {
          sessionKey: current.provenance.sourceSessionKey,
          agentId: "main",
          label: name ? (index % jobCount === 0 ? name : `${name} ${index}`) : "Automation",
        },
      }));
      for (const messageId of [undefined, "forwarded-result"]) {
        const page = await measure(`${name}-${messageId ? "anchor" : "rpc"}`, () =>
          readChatHistoryPage({ ...pageParams, messageId, encodeResponse: true }),
        );
        expect(page.encodedResponse?.messages).toBeInstanceOf(Uint8Array);
        expect(new SerializedJsonArray(page.encodedResponse!.messages).materialize()).toMatchObject(
          expected,
        );
      }
      for (const limit of [messages.length + 10, undefined]) {
        const snapshot = await measure(`${name}-http-${limit}`, () =>
          readSessionHistorySnapshotAsync({
            target: { ...scope, sessionEntry: entry },
            limit,
            maxChars: 100_000,
          }),
        );
        expect(snapshot.history.messages).toMatchObject(expected);
        if (limit === undefined) {
          sse ??= SessionHistorySseState.fromSnapshot({
            target: { ...scope, sessionEntry: entry },
            maxChars: 100_000,
            snapshot,
          });
          const currentSse = sse;
          const appended = await measure(`${name}-sse`, async () =>
            (
              await currentSse.prepareInlineMessage({
                message:
                  name === "Renamed report"
                    ? { role: "assistant", content: "NO_REPLY" }
                    : { role: "user", content: `Next message after ${name}.` },
              })
            )(),
          );
          expect(currentSse.snapshot().messages.slice(0, messages.length)).toMatchObject(expected);
          if (name !== "Daily report") {
            expect(appended).toEqual({ shouldRefresh: true });
          } else {
            expect(appended?.message).toMatchObject({
              role: "user",
              content: `Next message after ${name}.`,
            });
          }
        }
      }
      const firstExpected = expected[0];
      if (!firstExpected) {
        throw new Error("Expected at least one forwarded message");
      }
      expect(
        (
          await measure(`${name}-live`, async () =>
            projectSessionMessagePayload({
              message,
              sessionKey: scope.sessionKey,
              resolveCronJobName: await prepareForwardedMessageCronJobNameResolver([message]),
            }),
          )
        ).payload?.message,
      ).toMatchObject(firstExpected);
    }
    let deniedNameReads = 0;
    database.db.setAuthorizer((action, table, column) => {
      if (action === constants.SQLITE_READ && table === "cron_jobs" && column === "name") {
        deniedNameReads++;
        return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    });
    try {
      expect(() => projectSessionMessagePayload({ message, sessionKey: scope.sessionKey })).toThrow(
        /prepared/iu,
      );
      expect(deniedNameReads).toBe(0);
      database.db.setAuthorizer(() => constants.SQLITE_DENY);
      expect(projectForwardedMessages([])).toEqual([]);
      const ordinary = [{ role: "user", content: "No automation." }];
      expect(projectForwardedMessages(ordinary)).toBe(ordinary);
    } finally {
      database.db.setAuthorizer(null);
    }
  });
});
