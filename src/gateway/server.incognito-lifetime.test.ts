import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { replyRunRegistry } from "../auto-reply/reply/reply-run-registry.js";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  deleteSessionEntryLifecycle,
  resetSessionEntryLifecycle,
} from "../config/sessions/session-accessor.sqlite-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPath } from "../state/openclaw-agent-db-lifecycle.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { attachInitialGatewayLifetimeSidecars } from "./server-lifetime-sidecars.js";
import { handleChatSend } from "./server-methods/chat-send-handler.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import * as deletion from "./server-methods/sessions-delete.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";

const DAY_MS = 24 * 60 * 60_000;
const config = { agents: { entries: { main: {} } } };
const ordinary = { agentId: "main", sessionKey: "agent:main:dashboard:ordinary" };
const originalDelete = deletion.deleteGatewaySession;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function withLifetime(
  run: (fixture: {
    owner: ReturnType<typeof createGatewaySidecarStopOwner>;
    context: ReturnType<typeof createDirectChatContext>;
    logWarning: ReturnType<typeof vi.fn<(message: string) => void>>;
    scope: { agentId: string; sessionKey: string; sessionId: string; storePath: string };
    stateDir: string;
  }) => Promise<void>,
  creationStamp: "provided" | "omitted" | "legacy" = "provided",
) {
  await withOpenClawTestState({ label: "incognito-lifetime" }, async (state) => {
    await state.writeConfig(config);
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(now);
    await upsertSessionEntryCore(ordinary, {
      sessionId: "ordinary",
      updatedAt: Date.now() - DAY_MS,
    });
    const owner = createGatewaySidecarStopOwner();
    const context = createDirectChatContext({
      getRuntimeConfig: () => config,
      getSessionEventSubscriberConnIds: () => new Set(["observer"]),
    });
    const logWarning = vi.fn<(message: string) => void>();
    await attachInitialGatewayLifetimeSidecars({
      chatMetadataLifecycle: { attachContext: vi.fn(async () => {}) } as never,
      gatewayRequestContext: context,
      flushPendingSessionsChangedEvents,
      minimalTestGateway: true,
      logWarning,
      publishSidecars: owner.publish,
    });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-lifetime",
      sessionId: "incognito-lifetime",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    };
    try {
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        ...(creationStamp === "omitted" ? {} : { createdAt: Date.now() }),
        updatedAt: Date.now(),
        incognito: true,
      });
      if (creationStamp === "legacy") {
        // Reproduce a historical unstamped row inside this disposable in-memory fixture.
        const database = getOpenClawAgentDatabaseIfOpen({
          agentId: scope.agentId,
          path: scope.storePath,
        });
        expect(database).toBeDefined();
        database!.db
          .prepare(
            "UPDATE session_nodes SET created_at = NULL, entry_json = json_remove(entry_json, '$.createdAt') WHERE session_key = ?",
          )
          .run(scope.sessionKey);
        expect(loadSessionEntryReadOnly(scope)?.createdAt).toBeUndefined();
      }
      await run({ owner, context, logWarning, scope, stateDir: state.stateDir });
    } finally {
      await owner.stop();
      vi.useRealTimers();
    }
  });
}

it("expires Incognito at creation plus 24 hours, cancels work, and deletes without an archive", async () => {
  await withLifetime(async ({ context, logWarning, scope }) => {
    const deleted = createDeferredCore<Awaited<ReturnType<typeof originalDelete>>>();
    const deletes = vi.spyOn(deletion, "deleteGatewaySession").mockImplementation((params) => {
      const operation = originalDelete(params);
      void operation.then(deleted.resolve, deleted.reject);
      return operation;
    });
    await appendTranscriptMessage(scope, {
      eventId: "private-input",
      message: { role: "user", content: "Ephemeral conversation", timestamp: Date.now() },
    });
    await vi.advanceTimersByTimeAsync(23 * 60 * 60_000);
    await patchSessionEntryCore(scope, () => ({ label: "Recent activity", updatedAt: Date.now() }));
    await resetSessionEntryLifecycle({
      ...scope,
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      buildNextEntry: ({ currentEntry }) => ({ ...currentEntry!, lifecycleRevision: "rewound" }),
    });
    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
    expect(loadSessionEntryReadOnly(scope)).toBeDefined();
    const active = replyRunRegistry.begin({ ...scope, resetTriggered: false });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(deletes).toHaveBeenCalledOnce();
      await expect(deleted.promise).resolves.toMatchObject({
        ok: true,
        result: { deleted: true, archived: [] },
      });
      expect(active.abortSignal.aborted).toBe(true);
      expect(replyRunRegistry.isActive(scope.sessionKey)).toBe(false);
      await flushPendingSessionsChangedEvents(context);
      expect(logWarning).not.toHaveBeenCalled();
      expect(loadSessionEntryReadOnly(scope)).toBeUndefined();
      expect(await loadTranscriptEvents(scope)).toEqual([]);
      expect(loadSessionEntryReadOnly(ordinary)?.sessionId).toBe("ordinary");
      expect(fs.existsSync(scope.storePath)).toBe(false);
      expect(context.broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({ sessionKey: scope.sessionKey, reason: "delete" }),
        expect.any(Set),
        expect.any(Object),
      );
    } finally {
      active.complete();
    }
  });
});

it("does not replace its deadline or delete another Gateway's Incognito publication", async () => {
  await withLifetime(async ({ scope, stateDir, logWarning }) => {
    const foreign = {
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(stateDir, "other-gateway") },
    };
    const foreignPath = resolveIncognitoOpenClawAgentSqlitePath(foreign);
    expect(foreignPath).not.toBe(scope.storePath);
    const deletes = vi.spyOn(deletion, "deleteGatewaySession");
    try {
      await upsertSessionEntryCore(foreign, {
        sessionId: "foreign-incognito",
        createdAt: Date.now() - DAY_MS + 1,
        updatedAt: Date.now(),
        incognito: true,
      });
      expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe(scope.sessionId);
      await vi.advanceTimersByTimeAsync(1);
      expect(deletes).not.toHaveBeenCalled();
      expect(logWarning).not.toHaveBeenCalled();
      expect(loadSessionEntryReadOnly(foreign)?.sessionId).toBe("foreign-incognito");
      await vi.advanceTimersByTimeAsync(DAY_MS - 1);
      await Promise.allSettled(deletes.mock.results.map((result) => result.value));
      expect(deletes).toHaveBeenCalledOnce();
      expect(loadSessionEntryReadOnly(scope)).toBeUndefined();
      expect(loadSessionEntryReadOnly(foreign)?.sessionId).toBe("foreign-incognito");
    } finally {
      closeOpenClawAgentDatabaseByPath(foreignPath);
    }
  });
});

it.each(["provided", "omitted", "legacy"] as const)(
  "inherits the original deadline with a %s creation stamp when a sibling outlives the creator",
  async (creationStamp) => {
    await withLifetime(async ({ owner, scope, logWarning }) => {
      const createdAt = Date.now();
      expect(loadSessionEntryReadOnly(scope)?.createdAt).toBe(
        creationStamp === "legacy" ? undefined : createdAt,
      );
      expect(loadSessionEntryReadOnly(ordinary)?.createdAt).toBeUndefined();
      const sibling = createGatewaySidecarStopOwner();
      const context = createDirectChatContext({ getRuntimeConfig: () => config });
      const deletes = vi.spyOn(deletion, "deleteGatewaySession");
      await vi.advanceTimersByTimeAsync(DAY_MS - 1);
      await patchSessionEntryCore(scope, () => ({ createdAt: Date.now(), updatedAt: Date.now() }));
      expect(loadSessionEntryReadOnly(scope)?.createdAt).toBe(createdAt);
      await attachInitialGatewayLifetimeSidecars({
        chatMetadataLifecycle: { attachContext: vi.fn(async () => {}) } as never,
        gatewayRequestContext: context,
        flushPendingSessionsChangedEvents,
        minimalTestGateway: true,
        logWarning,
        publishSidecars: sibling.publish,
      });
      try {
        await owner.stop();
        expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe(scope.sessionId);
        await vi.advanceTimersByTimeAsync(1);
        await Promise.allSettled(deletes.mock.results.map((result) => result.value));
        expect(deletes).toHaveBeenCalledOnce();
        expect(loadSessionEntryReadOnly(scope)).toBeUndefined();
        expect(logWarning).not.toHaveBeenCalled();
      } finally {
        await sibling.stop();
      }
    }, creationStamp);
  },
);

it.each(["session replacement", "database replacement", "Gateway stop"] as const)(
  "revokes a pending expiry across %s before cancellation or deletion",
  async (replacement) => {
    await withLifetime(async ({ owner, scope, logWarning }) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const finished = createDeferredCore();
      const deletes = vi
        .spyOn(deletion, "deleteGatewaySession")
        .mockImplementation(async (params) => {
          entered.resolve();
          await release.promise;
          try {
            return await originalDelete(params);
          } finally {
            finished.resolve();
          }
        });
      let stopping: Promise<void> | undefined;
      try {
        await vi.advanceTimersByTimeAsync(DAY_MS);
        await entered.promise;
        if (replacement === "session replacement") {
          await deleteSessionEntryLifecycle({
            agentId: scope.agentId,
            storePath: scope.storePath,
            target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
            archiveTranscript: false,
            deleteTranscriptWithoutArchive: true,
          });
        } else if (replacement === "database replacement") {
          closeOpenClawAgentDatabaseByPath(scope.storePath);
        } else {
          stopping = owner.stop();
        }
        const successor = {
          sessionId: replacement === "session replacement" ? "successor" : scope.sessionId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          incognito: true as const,
        };
        if (replacement !== "Gateway stop") {
          await upsertSessionEntryCore(scope, successor);
        }
        const before = loadSessionEntryReadOnly(scope);
        release.resolve();
        await finished.promise;
        await Promise.allSettled(deletes.mock.results.map((result) => result.value));
        await stopping;
        expect(loadSessionEntryReadOnly(scope)).toEqual(before);
        expect(logWarning).not.toHaveBeenCalled();
        if (replacement === "Gateway stop") {
          await vi.advanceTimersByTimeAsync(DAY_MS);
          expect(deletes).toHaveBeenCalledOnce();
        }
      } finally {
        release.resolve();
        await stopping;
      }
    });
  },
);

it.each(["provided", "legacy"] as const)(
  "refuses work while %s session cleanup retries",
  async (creationStamp) => {
    await withLifetime(async ({ scope, context, logWarning }) => {
      const failed = createDeferredCore();
      const deleted = createDeferredCore<Awaited<ReturnType<typeof originalDelete>>>();
      const deletes = vi
        .spyOn(deletion, "deleteGatewaySession")
        .mockImplementationOnce(async () => {
          failed.resolve();
          return { ok: false, error: { code: "UNAVAILABLE", message: "Cleanup still draining" } };
        })
        .mockImplementation((params) => {
          const operation = originalDelete(params);
          void operation.then(deleted.resolve, deleted.reject);
          return operation;
        });
      await vi.advanceTimersByTimeAsync(DAY_MS);
      await failed.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(logWarning).toHaveBeenCalledOnce();
      expect(loadSessionEntryReadOnly(scope)).toBeDefined();
      expect(resolveSessionWorkStartError(scope.sessionKey, loadSessionEntryReadOnly(scope))).toBe(
        `Incognito session "${scope.sessionKey}" expired. Start a new Incognito session.`,
      );
      expect(
        resolveSessionWorkStartError(ordinary.sessionKey, loadSessionEntryReadOnly(ordinary)),
      ).toBeUndefined();
      const respond = vi.fn();
      await handleChatSend({
        params: {
          sessionKey: scope.sessionKey,
          message: "Must not start work while expiry cleanup retries",
          idempotencyKey: "expired-incognito-send",
        },
        req: { type: "req", id: "expired-send", method: "chat.send" },
        respond,
        context,
        client: null,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: `Incognito session "${scope.sessionKey}" expired. Start a new Incognito session.`,
        }),
      );
      expect(await loadTranscriptEvents(scope)).toEqual([]);
      expect(context.chatAbortControllers.size).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(deleted.promise).resolves.toMatchObject({ ok: true, result: { deleted: true } });
      expect(deletes).toHaveBeenCalledTimes(2);
      expect(loadSessionEntryReadOnly(scope)).toBeUndefined();
    }, creationStamp);
  },
);
