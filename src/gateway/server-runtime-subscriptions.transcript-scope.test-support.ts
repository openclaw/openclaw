import { expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import type { registerSessionPublicationTests } from "./server-runtime-subscriptions.publication.test-support.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

export function registerTranscriptScopePublicationTests(
  fixture: Parameters<typeof registerSessionPublicationTests>[0] & {
    runtimeConfigState: { value: OpenClawConfig };
  },
): void {
  const { createParams, start, transcriptBroadcastMocks, runtimeConfigState, warn } = fixture;
  it("broadcasts a transcript update after the producer's async-work scope closes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      transcriptBroadcastMocks.useActualHandler = true;
      runtimeConfigState.value = { agents: { entries: { main: {} } } };
      const target = {
        agentId: "main",
        sessionId: "sess-scoped",
        sessionKey: "agent:main:main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: target.sessionKey },
        { sessionId: target.sessionId, updatedAt: 1 },
      );
      const message = { role: "assistant", content: [{ type: "text", text: "tool reply" }] };
      transcriptBroadcastMocks.readMessageById.mockResolvedValue({
        found: true,
        oversized: false,
        seq: 1,
        message,
      });
      const projection = await createSessionRowProjection({
        cfg: runtimeConfigState.value,
        modelCatalog: [],
        placementFactsReader: createWorkerSessionPlacementStore(),
      });
      let unsubs: ReturnType<typeof startGatewayEventSubscriptions> | undefined;
      try {
        const params = createParams();
        params.sessionEventSubscribers.subscribe("conn-transcript");
        unsubs = start({
          ...params,
          getSessionRowProjection: () => projection,
        });
        await projection.ensureMaterialized();

        // A dynamic tool call persists its row inside a per-call scope that closes on return.
        await runWithAsyncWorkResources(async () => {
          emitSessionTranscriptUpdate({
            sessionFile: "/tmp/openclaw-scoped-transcript.sqlite",
            sessionKey: target.sessionKey,
            message,
            messageId: "scoped-message",
            target,
          });
        });

        await vi.waitFor(
          () =>
            expect(
              warn.mock.calls.length + vi.mocked(params.broadcastToConnIds).mock.calls.length,
            ).toBeGreaterThan(0),
          { interval: 1 },
        );
        expect(warn).not.toHaveBeenCalled();
        expect(params.broadcastToConnIds).toHaveBeenCalledWith(
          "session.message",
          expect.objectContaining({ sessionKey: target.sessionKey, messageId: "scoped-message" }),
          new Set(["conn-transcript"]),
          expect.anything(),
        );
      } finally {
        await unsubs?.agentUnsub();
        unsubs?.transcriptUnsub();
        unsubs?.lifecycleUnsub();
        projection.dispose();
      }
    });
  });
}
