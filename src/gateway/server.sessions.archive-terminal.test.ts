// Destructive lifecycle tests protect exact terminal ownership at the RPC boundary.
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import { TerminalSessionManager } from "./terminal/session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  makeFakePty,
} from "./terminal/session-manager.test-helpers.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  closeOpenClawStateDatabaseForTest();
});

test.each(["archive", "incognito reset"] as const)(
  "%s drains only the exact terminal session incarnation",
  async (operation) => {
    const { storePath } = await createSessionStoreDir();
    const created =
      operation === "incognito reset"
        ? await directSessionReq<{ key: string; entry: { sessionId: string } }>("sessions.create", {
            agentId: "main",
            incognito: true,
          })
        : undefined;
    if (created && (!created.ok || !created.payload)) {
      throw new Error("expected incognito session");
    }
    const sessionKey = created?.payload?.key ?? "agent:main:archive-terminal";
    const oldOwner = agentTerminalOwner(sessionKey, created?.payload?.entry.sessionId ?? "S1");
    const replacementOwner = agentTerminalOwner(sessionKey, "S2");
    const unrelatedOwner = agentTerminalOwner("agent:main:unrelated", "U1");
    const [oldPty, replacementPty, unrelatedPty] = [makeFakePty(), makeFakePty(), makeFakePty()];
    const drainStarted = createDeferredCore();
    const killOldPty = oldPty.kill.bind(oldPty);
    oldPty.kill = () => {
      killOldPty();
      drainStarted.resolve();
    };
    const manager = new TerminalSessionManager({ emit: vi.fn() });
    if (operation === "archive") {
      await writeSessionStore({
        entries: { [sessionKey]: sessionStoreEntry(oldOwner.agentSessionId) },
      });
    }
    const [oldSession, replacementSession, unrelatedSession] = await Promise.all([
      manager.open(
        baseOpenRequest({
          owner: oldOwner,
          viewerConnId: "conn-1",
          createBackend: async () => oldPty,
        }),
      ),
      manager.open(
        baseOpenRequest({ owner: replacementOwner, createBackend: async () => replacementPty }),
      ),
      manager.open(
        baseOpenRequest({ owner: unrelatedOwner, createBackend: async () => unrelatedPty }),
      ),
    ]);
    if (!oldSession.ok || !replacementSession.ok || !unrelatedSession.ok) {
      throw new Error("expected terminal sessions");
    }

    expect(manager.write("conn-1", oldSession.sessionId, "long-running-command\n")).toBe(true);
    let mutationSettled = false;
    const context = createDirectChatContext({ terminalSessions: manager });
    const mutationPromise = withPluginRuntimeGatewayRequestScope(
      { context, isWebchatConnect: () => false },
      () =>
        directSessionReq(
          operation === "archive" ? "sessions.patch" : "sessions.reset",
          {
            key: sessionKey,
            ...(operation === "archive" ? { archived: true } : {}),
            expectedSessionId: oldOwner.agentSessionId,
          },
          { context },
        ),
    ).finally(() => {
      mutationSettled = true;
    });
    onTestFinished(async () => {
      if (!mutationSettled) {
        oldPty.emitExit(0);
      }
      await mutationPromise;
      manager.disposeAll();
    });

    // Synchronize on the PTY action itself; cold RPC loading is not lifecycle timing.
    await Promise.race([drainStarted.promise, mutationPromise]);
    expect(oldPty.killed).toBe(true);
    expect(mutationSettled).toBe(false);
    expect(manager.write("conn-1", oldSession.sessionId, "after-reset\n")).toBe(false);
    expect(oldPty.writes).toEqual(["long-running-command\n"]);
    await expect(
      manager.open(baseOpenRequest({ owner: oldOwner, createBackend: async () => makeFakePty() })),
    ).resolves.toMatchObject({ ok: false, code: "closed" });
    expect(loadSessionEntry({ storePath, sessionKey })?.sessionId).toBe(oldOwner.agentSessionId);
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    oldPty.emitExit(0);
    const mutated = await mutationPromise;

    expect(mutated.ok).toBe(true);
    expect(manager.listAgent(oldOwner)).toEqual([]);
    expect(manager.snapshotAgent(oldOwner, oldSession.sessionId)).toBeUndefined();
    replacementPty.emitData("replacement\n");
    unrelatedPty.emitData("unrelated\n");
    expect(manager.snapshotAgent(replacementOwner, replacementSession.sessionId)).toContain(
      "replacement",
    );
    expect(manager.snapshotAgent(unrelatedOwner, unrelatedSession.sessionId)).toContain(
      "unrelated",
    );
    expect(replacementPty.killed).toBe(false);
    expect(unrelatedPty.killed).toBe(false);
    expect(manager.size).toBe(2);
    if (operation === "archive") {
      expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
    } else {
      expect(mutated.payload).toMatchObject({ deleted: true });
      expect(loadSessionEntry({ storePath, sessionKey })).toBeUndefined();
    }
  },
);
