import path from "node:path";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { readSessionColdTranscript } from "../../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "../../config/sessions/session-cold-storage.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionMessageSubscriberRegistry } from "../server-chat-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";
import type { RespondFn } from "./types.js";

it("serves initial subscription history without restoring the cold transcript", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = await createSessionColdStorageFixture(
      path.join(state.agentDir(), "openclaw-agent.sqlite"),
    );
    const cfg = maintenanceConfig(fixture.scope.storePath);
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    expect(await runSessionColdStorageMaintenance({ config: cfg })).toMatchObject({
      archivedTranscripts: 1,
    });
    replaceSessionEntrySync(fixture.scope, { sessionId: historicalId, updatedAt: 1 });
    const archive = readSessionColdTranscript(fixture.database(), historicalId);
    expect(archive).toBeDefined();
    const client = {
      ...sharingPolicyClient({ scopes: ["operator.admin"] }),
      connId: "cold-reader",
    };
    const subscribers = createSessionMessageSubscriberRegistry();
    const context = await createHistoryReadContext({
      getRuntimeConfig: () => cfg,
      subscribeSessionMessageEvents: subscribers.subscribe,
      unsubscribeSessionMessageEvents: subscribers.unsubscribe,
    });
    const respond = vi.fn<RespondFn>();
    try {
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "subscribe-cold",
          method: "sessions.messages.subscribe",
          params: {
            key: fixture.scope.sessionKey,
            initialHistory: { limit: 80, maxBytes: 256 * 1024 },
          },
        },
        client,
        context,
        respond,
        isWebchatConnect: () => false,
        extraHandlers: sessionSubscriptionHandlers,
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        expect.objectContaining({
          initialHistory: {
            ok: true,
            payload: expect.objectContaining({
              messages: expect.arrayContaining([
                expect.objectContaining({
                  role: "assistant",
                  content: [{ type: "text", text: "Preserved response" }],
                }),
              ]),
            }),
          },
        }),
        undefined,
      );
      expect(
        readSessionColdTranscript(fixture.database(), historicalId),
        "subscription must preserve the cold archive",
      ).toEqual(archive);
    } finally {
      subscribers.unsubscribeAll(client.connId);
      await disposeSessionReadContexts();
    }
  });
});
