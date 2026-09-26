import { afterEach, expect, it, vi } from "vitest";
import { updateSessionEntry } from "../config/sessions/session-accessor.entry-mutation.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { reportPlacementTransition } from "./worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

afterEach(() => vi.restoreAllMocks());

it("reuses placement facts after transcript writes and refreshes actual placement changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {
      agents: {
        list: [{ id: "main", default: true }],
        defaults: { model: "unit-test/model", utilityModel: "" },
      },
    };
    const target = {
      agentId: "main",
      sessionKey: "agent:main:entry-placement",
      sessionId: "entry-placement",
    };
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
    const placements = createWorkerSessionPlacementStore();
    await placements.startDispatch(target);
    const projection = await createSessionRowProjection({
      cfg,
      modelCatalog: [],
      placementFactsReader: placements,
    });
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const respond = vi.fn();
    const describe = async () => {
      respond.mockClear();
      await sessionByKeyReadHandlers["sessions.describe"]!({
        req: { type: "req", id: "entry-placement", method: "sessions.describe" },
        params: { key: target.sessionKey },
        client: null,
        context,
        isWebchatConnect: () => false,
        respond,
      });
    };
    try {
      await projection.ensureMaterialized();
      const reads = vi.spyOn(placements, "readProjection");
      for (let index = 0; index < 3; index++) {
        await persistSessionTranscriptTurn(target, {
          messages: [
            {
              eventId: `entry-message-${index}`,
              message: { role: "user", content: `Message ${index}` },
            },
          ],
          touchSessionEntry: true,
        });
        await describe();
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
          session: expect.objectContaining({
            sessionId: target.sessionId,
            placement: expect.objectContaining({ state: "requested" }),
          }),
        });
      }
      await updateSessionEntry(target, () => ({ label: "Updated by the entry worker" }));
      await describe();
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({
          label: "Updated by the entry worker",
          placement: expect.objectContaining({ state: "requested" }),
        }),
      });
      expect(reads).not.toHaveBeenCalled();

      sessionChanges.emit({
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        factsInvalidated: true,
      });
      await describe();
      expect(reads).toHaveBeenCalled();
      reads.mockClear();

      reportPlacementTransition(
        undefined,
        placements.fail({ sessionId: target.sessionId, recoveryError: "Worker stopped" }),
      );
      await describe();
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({
          placement: expect.objectContaining({ state: "failed", recoveryError: "Worker stopped" }),
        }),
      });
      expect(reads).toHaveBeenCalled();

      replaceSessionEntrySync(target, { sessionId: "replacement-session", updatedAt: 2 });
      await describe();
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({
          sessionId: "replacement-session",
        }),
      });
      expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("session.placement");
    } finally {
      projection.dispose();
    }
  });
});
