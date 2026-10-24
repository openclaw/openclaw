import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import { replaceSessionEntryInDatabase as replaceEntry } from "../config/sessions/session-accessor.sqlite-entry-mutation.js";
import {
  resolveSqliteTranscriptScope as resolveScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction as append } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { createSessionTranscriptHeader } from "../config/sessions/transcript-header.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { runOpenClawAgentWriteTransaction as transaction } from "../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { sessionTitleRetentionEntrypoints } from "./session-title-retention.test-support.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let storePath: string;

beforeAll(async () => {
  state = await createOpenClawTestState({ label: "title-cache-retention", applyEnv: false });
  storePath = path.join(state.sessionsDir("main"), "sessions.json");
  const scope = { agentId: "main", env: state.env, storePath };
  const targetFor = (id: string) =>
    resolveScope({ ...scope, sessionId: id, sessionKey: `agent:main:dashboard:${id}` });
  const named = { updatedAt: 1, displayName: "Named session" };
  // Seed new rows in one transaction; child readers see only committed disk state.
  transaction(
    (db) => {
      for (let index = 0; index < 128; index++) {
        const sessionId = `preview-${index}`;
        const target = targetFor(sessionId);
        replaceEntry(db, target.sessionKey, { sessionId, ...named });
        const messages = [
          ["user", null, "user", index + ": " + "abcdefg ".repeat(32 * 1024)] as const,
          ["assistant", "user", "assistant", "Short reply."] as const,
        ].map(([id, parentId, role, content]) => {
          return { type: "message", id, parentId, message: { role, content } };
        });
        append(db, target, [createSessionTranscriptHeader({ sessionId }), ...messages]);
      }
    },
    toDatabaseOptions(targetFor("preview-0")),
  );
  const unicode = { role: "user", content: "\ud800 visible text" };
  await persistSessionTranscriptTurn(
    { ...scope, sessionId: "unicode-preview", sessionKey: "agent:main:unicode-preview" },
    { config: {}, messages: [{ message: unicode }], touchSessionEntry: false },
  );
  await cleanupSessionStateForTest({ stateDir: state.stateDir });
}, 20_000);

afterAll(() => state?.cleanup());

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
          // Do not serialize first-user previews: flattening their slices would hide retention.
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
  const expectedRow = { derivedTitle: "Named session", lastMessagePreview: "Short reply." };
  expect(output.rows).toEqual(Array.from({ length: 128 }, () => expectedRow));
  expect(output.unicodePreview).toBe("\ud800 visible text");
  // Reject caches retaining the 32 MiB of source text behind 240-character previews.
  expect(output.retainedBytes).toBeLessThan(8 * 1024 * 1024);
}, 30_000);
