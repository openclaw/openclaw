import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
  replaceSessionEntry,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { readSessionTaskArchivePageReadOnly } from "../../config/sessions/session-history.js";
import { handleChatHistoryRequest } from "../../gateway/server-methods/chat-history-handler.js";
import { createHistoryReadContext } from "../../gateway/server-methods/chat-history.test-helpers.js";
import { identifiedClient } from "../../gateway/server-methods/sessions-read-cache.test-support.js";
import type { RespondFn } from "../../gateway/server-methods/types.js";
import { disposeSessionReadContexts } from "../../gateway/session-read-contexts.test-support.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    `${engine} session archives through a state directory alias`,
    () => {
      const pair = useMixedAgentPair(engine, engine);

      it.each(["archive", "retained history"] as const)(
        "serves %s through the alias",
        async (operation) => {
          const stateAlias = path.join(pair.root, "state-alias");
          if (!fs.existsSync(stateAlias)) {
            fs.symlinkSync(
              fs.realpathSync.native(pair.root),
              stateAlias,
              process.platform === "win32" ? "junction" : "dir",
            );
          }
          vi.stubEnv("OPENCLAW_STATE_DIR", stateAlias);
          const runId = randomUUID();
          const scope = {
            agentId: "main",
            sessionKey: `agent:main:cron:${randomUUID()}`,
            sessionId: randomUUID(),
            storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
          };
          try {
            await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
            await appendTranscriptEvent(scope, {
              type: "session",
              version: 3,
              id: scope.sessionId,
            });
            await appendTranscriptMessage(scope, {
              eventId: "input",
              parentId: null,
              message: { role: "user", content: "Synthetic cron request" },
            });
            await appendTranscriptMessage(scope, {
              eventId: "answer",
              parentId: "input",
              message: {
                role: "assistant",
                content: "Synthetic cron answer",
                __openclaw: { runId },
              },
            });
            await waitForSessionTranscriptProjection(scope);
            if (operation === "retained history") {
              const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf8"));
              config.plugins = { enabled: false };
              setRuntimeConfigSnapshot(config, config);
              const context = await createHistoryReadContext({ getRuntimeConfig: () => config });
              const client = withEngineStoreAdmission(() =>
                identifiedClient("archive-alias-reader"),
              );
              client.connect.scopes = ["operator.read", "operator.admin"];
              const respond = vi.fn<RespondFn>();
              // cron.history retains its exact run while the reusable base session may advance.
              await handleChatHistoryRequest({
                method: "chat.history",
                req: { type: "req", id: runId, method: "chat.history" },
                params: { sessionKey: scope.sessionKey, limit: 10 },
                retainedTranscript: {
                  sessionId: scope.sessionId,
                  verifyRetainedState: async () => true,
                },
                context,
                client,
                respond,
                isWebchatConnect: () => false,
              });
              expect(respond).toHaveBeenCalledWith(
                true,
                expect.objectContaining({
                  messages: expect.arrayContaining([
                    expect.objectContaining({ content: "Synthetic cron answer" }),
                  ]),
                }),
              );
              return;
            }
            // Gateway session writes need no retained main-thread database handle.
            await closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
            const deleted = await deleteSessionEntryLifecycle({
              storePath: scope.storePath,
              archiveTranscript: true,
              target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
            });
            expect(deleted.deleted).toBe(true);
            expect(deleted.archivedTranscripts).toEqual([
              expect.objectContaining({
                sessionId: scope.sessionId,
                archivedPath: expect.any(String),
              }),
            ]);
            expect(await readSessionEntryInWorker(scope)).toBeUndefined();
            expect(await loadTranscriptEvents(scope)).toEqual([]);
            const page = await readSessionTaskArchivePageReadOnly(scope, { runId, limit: 1 });
            expect(page?.entries).toEqual([
              expect.objectContaining({
                event: expect.objectContaining({
                  id: "answer",
                  message: expect.objectContaining({ content: "Synthetic cron answer" }),
                }),
              }),
            ]);
            expect(page?.binding.sessionId).toBe(scope.sessionId);
          } finally {
            await disposeSessionReadContexts();
            await cleanupSessionStateForTest({ stateDir: stateAlias });
          }
        },
      );
    },
  );
}
