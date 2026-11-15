import path from "node:path";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessages,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { resolveCronJobsStorePath, saveCronJobsStore } from "../cron/store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareForwardedMessageCronJobNameResolver } from "./chat-display-projection.cron.js";
import { projectForwardedMessages } from "./chat-display-projection.history.js";
import { SerializedJsonArray } from "./serialized-json.js";
import { readChatHistoryPage } from "./server-methods/chat-history-pages.js";
import {
  readSessionHistorySnapshotAsync as readSnapshot,
  SessionHistorySseState,
} from "./session-history-state.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";

async function appendInline(
  sse: SessionHistorySseState,
  message: Parameters<SessionHistorySseState["prepareInlineMessage"]>[0]["message"],
) {
  return (await sse.prepareInlineMessage({ message }))();
}

it("batches automation names across history reads after rename and deletion without a source session", () =>
  withOpenClawTestState({ label: "cron-attribution" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    const bindingIds = [
      "daily-report",
      "report-\ufffd",
      "report\u0000suffix",
      "report\\u0000suffix",
      "DAILY-report",
      "report-é",
    ];
    const jobs = Array.from({ length: 32 }, (_, index) =>
      makeCronJob({
        id: bindingIds[index] ?? `report-${index}`,
        name: index === 0 ? "Daily report" : `Report ${index}`,
      }),
    );
    const entry = { sessionId: "destination", updatedAt: 1 };
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: entry.sessionId,
      storePath: path.join(state.sessionsDir("main"), "sessions.json"),
    };
    const target = { ...scope, sessionEntry: entry };
    const snapshotOptions = { target, maxChars: 100_000 };
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
    // Host-boundary counts exclude the history worker's independent connection.
    const measure = async <T>(
      read: () => T | Promise<T>,
      forbidden = /\bfrom\s+"?cron_jobs"?\b/iu,
    ): Promise<T> => {
      const sql = observeHostDataSql();
      try {
        const result = await read();
        expect(sql.queries.filter((query) => forbidden.test(query))).toEqual([]);
        return result;
      } finally {
        sql.restore();
      }
    };
    expect((await measure(() => readChatHistoryPage(pageParams))).messages).toEqual([]);
    const emptySnapshot = await measure(() => readSnapshot(snapshotOptions));
    expect(emptySnapshot.history.messages).toEqual([]);
    const fromSnapshot = (snapshot: typeof emptySnapshot, maxChars?: number) =>
      SessionHistorySseState.fromSnapshot({ target, snapshot, maxChars });
    const emptySse = fromSnapshot(emptySnapshot);
    const ordinaryMessage = { role: "user", content: "An ordinary message." };
    const emptyAppend = await measure(() => appendInline(emptySse, ordinaryMessage));
    expect(emptyAppend?.message).toMatchObject(ordinaryMessage);
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
      await saveCronJobsStore(resolveCronJobsStorePath(), {
        version: 1,
        jobs: name
          ? jobs.map((current, index) => ({
              ...current,
              name: index === 0 ? name : `${name} ${index}`,
              updatedAtMs: 3,
            }))
          : [],
      });
      const expected = messages.map((current, index) => ({
        role: "assistant",
        content: current.content,
        senderSession: {
          sessionKey: current.provenance.sourceSessionKey,
          agentId: "main",
          label: name ? (index % jobs.length === 0 ? name : `${name} ${index}`) : "Automation",
        },
      }));
      for (const messageId of [undefined, "forwarded-result"]) {
        const page = await measure(() =>
          readChatHistoryPage({ ...pageParams, messageId, encodeResponse: true }),
        );
        expect(page.encodedResponse?.messages).toBeInstanceOf(Uint8Array);
        expect(new SerializedJsonArray(page.encodedResponse!.messages).materialize()).toMatchObject(
          expected,
        );
      }
      for (const limit of [messages.length + 10, undefined]) {
        const snapshot = await measure(() => readSnapshot({ ...snapshotOptions, limit }));
        expect(snapshot.history.messages).toMatchObject(expected);
        if (limit === undefined) {
          const currentSse = (sse ??= fromSnapshot(snapshot, snapshotOptions.maxChars));
          const nextMessage =
            name === "Renamed report"
              ? { role: "assistant", content: "NO_REPLY" }
              : { role: "user", content: `Next message after ${name}.` };
          const appended = await measure(() => appendInline(currentSse, nextMessage));
          expect(currentSse.snapshot().messages.slice(0, messages.length)).toMatchObject(expected);
          if (name !== "Daily report") {
            expect(appended).toEqual({ shouldRefresh: true });
          } else {
            expect(appended?.message).toMatchObject(nextMessage);
          }
        }
      }
      const projected = await measure(async () =>
        projectSessionMessagePayload({
          message,
          sessionKey: scope.sessionKey,
          resolveCronJobName: await prepareForwardedMessageCronJobNameResolver([message]),
        }),
      );
      expect(projected.payload?.message).toMatchObject(expected[0]!);
    }
    await measure(() => {
      expect(() => projectSessionMessagePayload({ message, sessionKey: scope.sessionKey })).toThrow(
        /prepared/iu,
      );
      expect(projectForwardedMessages([])).toEqual([]);
      const ordinary = [{ role: "user", content: "No automation." }];
      expect(projectForwardedMessages(ordinary)).toBe(ordinary);
    }, /./su);
  }));
