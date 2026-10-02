import { afterAll, afterEach, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as sessionHistoryWorkers from "../config/sessions/session-history-worker-runtime.js";
import { createHookRunner } from "../plugins/hooks.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import type { PluginHookEndedTranscriptReadResult } from "../plugins/session-end-transcript.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  seedSessionTranscript,
  sessionStoreEntry,
  setSessionLifecycleHookRunnerForTest,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const resultKeys = {
  granted: Symbol.for("openclaw.test.sessions-reset-transcript-result.granted"),
  ungranted: Symbol.for("openclaw.test.sessions-reset-transcript-result.ungranted"),
};

afterEach(() => {
  setSessionLifecycleHookRunnerForTest(undefined);
  resetPluginLoaderTestStateForTest();
  for (const key of Object.values(resultKeys)) {
    delete (globalThis as Record<PropertyKey, unknown>)[key];
  }
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

function requireStorePath(): string {
  expect(typeof testState.sessionStorePath).toBe("string");
  if (typeof testState.sessionStorePath !== "string") {
    throw new Error("expected test session store path");
  }
  return testState.sessionStorePath;
}

async function resetMainSession(): Promise<void> {
  const result = await directSessionReq("sessions.reset", { key: "main", reason: "new" });
  expect(result.ok).toBe(true);
}

function writeReaderPlugin(name: keyof typeof resultKeys) {
  const pluginId = `session-end-reader-${name}`;
  return writePlugin({
    id: pluginId,
    body: `
const resultKey = Symbol.for("openclaw.test.sessions-reset-transcript-result.${name}");
module.exports = {
  id: ${JSON.stringify(pluginId)},
  name: ${JSON.stringify(pluginId)},
  register(api) {
    api.on("session_end", async (_event, context) => {
      try {
        const transcript = context.endedTranscript;
        const result = transcript?.available
          ? await transcript.readTail({ maxMessages: 10, maxBytes: 4 * 1024 })
          : transcript;
        globalThis[resultKey]?.resolve(result);
      } catch (error) {
        globalThis[resultKey]?.reject(error);
        throw error;
      }
    });
  },
};
`,
  });
}

test("sessions.reset delivers the ended SQLite window only to a loaded granted plugin", async () => {
  await createSessionStoreDir();
  const storePath = requireStorePath();
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-main") } });
  const latestEndedContent = "latest ended interval ".padEnd(3_600, "x");
  await seedSessionTranscript({
    agentId: "main",
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
    messages: [{ role: "user", content: "first closed interval", id: "m1" }],
  });
  await resetMainSession();
  await seedSessionTranscript({
    agentId: "main",
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
    messages: [{ role: "user", content: latestEndedContent, id: "m2" }],
  });

  useNoBundledPlugins();
  const grantedPlugin = writeReaderPlugin("granted");
  const ungrantedPlugin = writeReaderPlugin("ungranted");
  const registry = loadOpenClawPlugins({
    cache: false,
    config: {
      plugins: {
        allow: [grantedPlugin.id, ungrantedPlugin.id],
        load: { paths: [grantedPlugin.file, ungrantedPlugin.file] },
        entries: {
          [grantedPlugin.id]: { enabled: true, hooks: { allowConversationAccess: true } },
          [ungrantedPlugin.id]: { enabled: true, hooks: { allowConversationAccess: false } },
        },
      },
    },
    workspaceDir: grantedPlugin.dir,
  });
  const runner = createHookRunner(registry);
  const hookSettled = createDeferred();
  setSessionLifecycleHookRunnerForTest({
    ...runner,
    runSessionEnd: async (...args: Parameters<typeof runner.runSessionEnd>) => {
      try {
        await runner.runSessionEnd(...args);
      } finally {
        hookSettled.resolve();
      }
    },
  });
  const grantedResult = createDeferred<PluginHookEndedTranscriptReadResult>();
  const ungrantedResult = createDeferred<unknown>();
  (globalThis as Record<PropertyKey, unknown>)[resultKeys.granted] = grantedResult;
  (globalThis as Record<PropertyKey, unknown>)[resultKeys.ungranted] = ungrantedResult;
  const historyRead = vi.spyOn(sessionHistoryWorkers, "readSessionHistoryPageInWorker");
  try {
    await resetMainSession();
    const [granted, ungranted] = await Promise.all([
      grantedResult.promise,
      ungrantedResult.promise,
      hookSettled.promise,
    ]);
    expect(granted).toMatchObject({
      messages: [expect.objectContaining({ role: "user", content: latestEndedContent })],
      totalMessages: 1,
      truncated: false,
    });
    expect(Buffer.byteLength(JSON.stringify(granted.messages), "utf8")).toBeLessThanOrEqual(
      4 * 1024,
    );
    expect(ungranted).toEqual({
      available: false,
      reason: "conversation-access-required",
    });
    expect(historyRead).toHaveBeenCalledOnce();
    expect(historyRead).toHaveBeenCalledWith({
      kind: "around-id",
      params: expect.objectContaining({
        options: expect.objectContaining({ closedResetInterval: true }),
      }),
    });
  } finally {
    historyRead.mockRestore();
  }
});
