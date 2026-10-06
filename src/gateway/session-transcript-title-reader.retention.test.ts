import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  persistSessionTranscriptTurn,
  type TranscriptEvent,
} from "../config/sessions/session-accessor.js";
import { replaceSessionEntryInDatabase } from "../config/sessions/session-accessor.sqlite-entry-mutation.js";
import { prepareSessionIdentityPublication } from "../config/sessions/session-accessor.sqlite-identity.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { createSessionTranscriptHeader } from "../config/sessions/transcript-header.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { sessionTitleRetentionEntrypoints } from "./session-title-retention.test-support.js";

let state: OpenClawTestState;
let storePath: string;

beforeAll(async () => {
  state = await createOpenClawTestState({ label: "title-cache-retention", applyEnv: false });
  storePath = path.join(state.sessionsDir("main"), "sessions.json");
  const scope = { agentId: "main", env: state.env, storePath };
  const transcripts = Array.from({ length: 128 }, (_, index) => {
    const sessionId = `preview-${index}`;
    const timestamp = new Date().toISOString();
    const userId = `${sessionId}-user`;
    const events: TranscriptEvent[] = [
      createSessionTranscriptHeader({ sessionId, timestamp }),
      {
        type: "message",
        id: userId,
        parentId: null,
        timestamp,
        message: { role: "user", content: index + ": " + "abcdefg ".repeat(32 * 1024) },
      },
      {
        type: "message",
        id: `${sessionId}-assistant`,
        parentId: userId,
        timestamp,
        message: { role: "assistant", content: "Short reply." },
      },
    ];
    const target = { ...scope, sessionId, sessionKey: `agent:main:dashboard:${sessionId}` };
    return {
      target: resolveSqliteTranscriptScope(target),
      entry: { sessionId, updatedAt: 1, displayName: "Named session" },
      events,
    };
  });
  // These sessions are new; appending avoids replacement's scan of existing FTS rows.
  runOpenClawAgentWriteTransaction((database) => {
    for (const { target, entry, events } of transcripts) {
      const { previous, current } = replaceSessionEntryInDatabase(
        database,
        target.sessionKey,
        entry,
      );
      appendTranscriptEventsInTransaction(database, target, events);
      prepareSessionIdentityPublication(database, scope.agentId, previous, current)();
    }
  }, toDatabaseOptions(transcripts[0]!.target));
  await persistSessionTranscriptTurn(
    { ...scope, sessionId: "unicode-preview", sessionKey: "agent:main:unicode-preview" },
    {
      config: {},
      messages: [
        { message: { role: "user", content: String.fromCharCode(0xd800) + " visible text" } },
      ],
      touchSessionEntry: false,
    },
  );
  // Share only committed disk state; each child creates its own title cache and heap.
  await cleanupSessionStateForTest({ stateDir: state.stateDir });
}, 20_000);

afterAll(async () => {
  await state?.cleanup();
});

test("releases transcript payloads after caching title fields", () => {
  const titleReaderUrl = resolveRuntimeWorkerUrl(sessionTitleRetentionEntrypoints.titleReader);
  const sessionUtilsUrl = resolveRuntimeWorkerUrl(sessionTitleRetentionEntrypoints.sessionUtils);
  const result = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      ...resolveRuntimeWorkerArgv(titleReaderUrl).slice(0, -1),
      "--input-type=module",
      "--eval",
      `
          import { setImmediate as yieldTurn } from "node:timers/promises";
          import { readSessionTitleFieldsFromTranscript } from ${JSON.stringify(titleReaderUrl.href)};
          import { deriveSessionTitle } from ${JSON.stringify(sessionUtilsUrl.href)};

          async function heapUsed() {
            await yieldTurn();
            for (let index = 0; index < 3; index++) globalThis.gc();
            return process.memoryUsage().heapUsed;
          }

          const storePath = ${JSON.stringify(storePath)};
          const scopes = Array.from({ length: 128 }, (_, index) => {
            const sessionId = "preview-" + index;
            return { agentId: "main", sessionId, sessionKey: "agent:main:dashboard:" + sessionId, storePath };
          });
          const before = await heapUsed();
          const rows = scopes.map((scope) => {
            const field = readSessionTitleFieldsFromTranscript(scope);
            return {
              derivedTitle: deriveSessionTitle({ sessionId: scope.sessionId, updatedAt: 1, displayName: "Named session" }, field.firstUserMessage),
              lastMessagePreview: field.lastMessagePreview,
            };
          });
          // Named sessions do not consume the cached first-user preview. Serializing
          // that unused field here would flatten its slices and hide the retention.
          JSON.stringify(rows);
          const retainedBytes = (await heapUsed()) - before;
          const unicodeScope = { ...scopes[0], sessionId: "unicode-preview", sessionKey: "agent:main:unicode-preview" };
          const unicodePreview = readSessionTitleFieldsFromTranscript(unicodeScope).firstUserMessage;
          process.stdout.write(JSON.stringify({ retainedBytes, rows, unicodePreview }));
        `,
    ],
    { cwd: process.cwd(), env: state.env, encoding: "utf8", timeout: 20_000 },
  );
  expect(result.error, result.stderr + result.stdout).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout) as {
    retainedBytes: number;
    rows: { derivedTitle: string; lastMessagePreview: string }[];
    unicodePreview: string;
  };
  expect(output.rows).toEqual(
    Array.from({ length: 128 }, () => ({
      derivedTitle: "Named session",
      lastMessagePreview: "Short reply.",
    })),
  );
  expect(output.unicodePreview).toBe("\ud800 visible text");
  // The source prompts total 32 MiB; allow allocator/JIT noise while rejecting
  // caches that retain those payloads behind their 240-character previews.
  expect(output.retainedBytes).toBeLessThan(8 * 1024 * 1024);
}, 30_000);
