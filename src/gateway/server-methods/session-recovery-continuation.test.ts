import { expect, test, vi } from "vitest";
import { getRuntimeConfig } from "../../config/io.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { GatewaySessionFactsChangedDuringReadError } from "../session-utils-store-errors.js";
import * as sessionStores from "../session-utils-store.js";
import { dispatchInboundMessageMock, writeSessionStore } from "../test-helpers.js";
import {
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test.each(["membership", "identity"] as const)(
  "recovery continuation replays one active/completed turn but rejects changed destination %s",
  async (change) => {
    const { storePath } = await createSessionStoreDir();
    const { launchSessionRecoveryContinuation } =
      await import("./session-recovery-continuation.js");
    const sessionKey = "agent:main:dashboard:recovery-retry-authority";
    const sessionId = "recovery-retry-destination";
    const member = ensureProfileForEmail("recovery-retry-member@example.test");
    const scope = { agentId: "main", sessionKey, storePath };
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry(sessionId, {
          visibility: "read-only",
          createdActor: { type: "human", source: "profile", id: "recovery-owner" },
        }),
      },
    });
    addSessionMember(scope, {
      identityId: member.id,
      addedBy: "recovery-owner",
      expectedSessionId: sessionId,
    });
    const client = sharingPolicyClient({ user: member.id });
    prepareGatewayRecipientProfile(client);
    const context = createDirectChatContext({ getRuntimeConfig });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    dispatchInboundMessageMock.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });
    const idempotencyKey = "recovery-deterministic-continuation";
    const launch = () =>
      launchSessionRecoveryContinuation({
        ...scope,
        sessionId,
        idempotencyKey,
        context,
        client,
        req: { type: "req", id: "recovery", method: "sessions.recover" },
      });
    let restoreRead: (() => void) | undefined;
    try {
      expect(await launch()).toEqual({ status: "started", runId: idempotencyKey });
      await entered.promise;
      expect(context.chatAbortControllers.has(idempotencyKey)).toBe(true);
      expect(await launch()).toEqual({ status: "started", runId: idempotencyKey });
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();

      const settled = getSessionWorkAdmissionRelease({
        scope: storePath,
        identities: [sessionKey, sessionId],
      });
      expect(settled).toBeDefined();
      release.resolve();
      await settled;
      expect(context.chatAbortControllers.has(idempotencyKey)).toBe(false);
      expect(context.dedupe.get(`chat:${idempotencyKey}`)).toMatchObject({
        ok: true,
        payload: { runId: idempotencyKey, status: "ok" },
      });
      expect(await launch()).toEqual({ status: "started", runId: idempotencyKey });
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();

      // The destination was authorized before this awaited read. A cached outcome
      // cannot replace its identity/participation check when freshness is lost.
      const readSessionEntry = sessionStores.withGatewaySessionEntry;
      let destinationChanged = false;
      const interruptRead = vi
        .spyOn(sessionStores, "withGatewaySessionEntry")
        .mockImplementation(async (...args) => {
          await readSessionEntry(...args);
          if (!destinationChanged) {
            destinationChanged = true;
            if (change === "membership") {
              removeSessionMember(scope, member.id);
            } else {
              await replaceSessionEntry(
                scope,
                sessionStoreEntry("replacement-recovery-destination", {
                  visibility: "read-only",
                  createdActor: { type: "human", source: "profile", id: "recovery-owner" },
                }),
              );
            }
          }
          throw new GatewaySessionFactsChangedDuringReadError();
        });
      restoreRead = () => interruptRead.mockRestore();
      expect(await launch()).toMatchObject({ status: "rejected" });
      expect(destinationChanged).toBe(true);
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    } finally {
      restoreRead?.();
      const settled = getSessionWorkAdmissionRelease({
        scope: storePath,
        identities: [sessionKey, sessionId],
      });
      release.resolve();
      await settled;
      dispatchInboundMessageMock.mockReset();
    }
  },
);
