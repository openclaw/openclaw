import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as sessions from "../config/sessions/session-accessor.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "./server-methods.js";
import {
  identifiedClient,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import * as transcriptBackfill from "./session-row-transcript-backfill.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
});

it.each(["before transcript work", "before preview publication"] as const)(
  "gives an in-flight Gateway request priority %s and resumes read-only previews afterward",
  async (phase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      resetGatewayWorkAdmission();
      const cfg = { agents: { list: [{ id: "main", default: true }] } };
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:foreground-backfill",
        sessionId: "foreground-backfill",
      };
      sessions.replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await sessions.persistSessionTranscriptTurn(scope, {
        messages: [{ message: { role: "user", content: "Preview the legacy session" } }],
        touchSessionEntry: false,
        updateMode: "none",
      });
      const entered = createDeferredCore();
      const response = createDeferredCore();
      const previewPrepared = createDeferredCore();
      const previewPublication = createDeferredCore();
      const backfill = transcriptBackfill.backfillSessionRowTranscriptFields;
      const before = sessions.loadSessionEntry(scope);
      if (phase === "before preview publication") {
        vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields").mockImplementationOnce(
          async (...args) => {
            const fields = await backfill(...args);
            previewPrepared.resolve();
            await previewPublication.promise;
            return fields;
          },
        );
      }
      const request = () =>
        handleGatewayRequest({
          req: { type: "req", id: "foreground-read", method: "health", params: {} },
          context: requestContext(cfg),
          client: identifiedClient("owner@example.com"),
          isWebchatConnect: () => false,
          respond: vi.fn(),
          extraHandlers: {
            health: async ({ respond }) => {
              entered.resolve();
              await response.promise;
              respond(true, {});
            },
          },
        });
      let foreground: Promise<void> | undefined;
      if (phase === "before transcript work") {
        foreground = request();
        await entered.promise;
      }
      const projection = await createSessionRowProjection({ cfg });
      try {
        if (phase === "before preview publication") {
          await previewPrepared.promise;
          foreground = request();
          await entered.promise;
          previewPublication.resolve();
        }
        const reads = vi.spyOn(sessions, "readSessionTranscriptBoundedMessageTailPage");
        for (let turn = 0; turn < 5; turn++) {
          await nextTurn();
        }
        expect(reads).not.toHaveBeenCalled();
        expect(sessions.loadSessionEntry(scope)).toEqual(before);
        expect(
          projection.snapshot(
            { agentId: scope.agentId, key: scope.sessionKey },
            { includeLastMessage: true },
          ).row?.lastMessagePreview,
        ).toBeUndefined();
        response.resolve();
        await foreground;
        await vi.waitFor(() =>
          expect(
            projection.snapshot(
              { agentId: scope.agentId, key: scope.sessionKey },
              { includeLastMessage: true },
            ).row?.lastMessagePreview,
          ).toBe("Preview the legacy session"),
        );
        expect(sessions.loadSessionEntry(scope)).toEqual(before);
      } finally {
        previewPublication.resolve();
        response.resolve();
        await foreground;
        projection.dispose();
      }
    });
  },
);
