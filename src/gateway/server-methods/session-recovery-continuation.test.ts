import { expect, test, vi } from "vitest";
import { getRuntimeConfig } from "../../config/io.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import { captureSessionControllerSettlement } from "../../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { useUserProfileCatalogForTest } from "../../test-utils/user-profile-catalog.js";
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
const prepareProfiles = useUserProfileCatalogForTest();

test.each(["membership", "identity"] as const)(
  "recovery continuation replays one active/completed turn but rejects changed destination %s",
  async (change) => {
    const { storePath } = await createSessionStoreDir();
    await prepareProfiles();
    const { launchSessionRecoveryContinuation } =
      await import("./session-recovery-continuation.js");
    const sessionKey = "agent:main:dashboard:recovery-retry-authority";
    const sessionId = "recovery-retry-destination";
    const member = ensureProfileForEmail("recovery-retry-member@example.test");
    const scope = { agentId: "main", sessionKey, storePath };
    const entry = (id: string) =>
      sessionStoreEntry(id, {
        visibility: "read-only",
        createdActor: { type: "human", source: "profile", id: "recovery-owner" },
      });
    await writeSessionStore({
      entries: { [sessionKey]: entry(sessionId) },
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
    const settle = async () => {
      const settled = captureSessionControllerSettlement({
        scope: storePath,
        identities: [sessionKey, sessionId],
      });
      release.resolve();
      await settled;
    };
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
    try {
      expect(await launch()).toEqual({ status: "started", runId: idempotencyKey });
      await entered.promise;
      expect(await launch()).toEqual({ status: "started", runId: idempotencyKey });
      await loadOrCreateProcessDeviceIdentityAsync();
      expect(await launch()).toEqual({ status: "started", runId: idempotencyKey });
      await settle();
      expect(await launch()).toEqual({ status: "started", runId: idempotencyKey });

      // The destination was authorized before this awaited read. A cached outcome
      // cannot replace its identity/participation check when freshness is lost.
      const readSessionEntry = sessionStores.withGatewaySessionEntry;
      let destinationChanged = false;
      using _ = vi
        .spyOn(sessionStores, "withGatewaySessionEntry")
        .mockImplementation(async (...args) => {
          await readSessionEntry(...args);
          if (!destinationChanged) {
            destinationChanged = true;
            if (change === "membership") {
              removeSessionMember(scope, member.id);
            } else {
              await replaceSessionEntry(scope, entry("replacement-recovery-destination"));
            }
          }
          throw new GatewaySessionFactsChangedDuringReadError();
        });
      expect(await launch()).toMatchObject({ status: "rejected" });
      expect(destinationChanged).toBe(true);
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    } finally {
      await settle();
      dispatchInboundMessageMock.mockReset();
    }
  },
);
