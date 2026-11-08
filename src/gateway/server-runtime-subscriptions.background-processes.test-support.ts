import { expect, it, vi } from "vitest";
import { waitForFast } from "../../test/helpers/vitest-wait.js";
import { addSession, markExited } from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { registerSessionPublicationTests } from "./server-runtime-subscriptions.publication.test-support.js";
import { prepareProjectedSessionPresentation } from "./session-row-presentation.js";
import {
  createTestProjection,
  seedRow,
} from "./session-row-projection.read-fixture.test-support.js";

export function registerBackgroundProcessPublicationTests(
  fixture: Pick<Parameters<typeof registerSessionPublicationTests>[0], "createParams" | "start">,
): void {
  const { createParams, start } = fixture;
  it("publishes live session-row background counts through start and exit without a turn", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const key = "agent:main:background-work";
      const query = { key, agentId: "main" };
      seedRow(key, { sessionId: "background-work", updatedAt: 1, status: "done" });
      using projection = await createTestProjection({ cfg: {}, modelCatalog: [] });
      await projection.ensureMaterialized();
      const params = { ...createParams(), getSessionRowProjection: () => projection };
      params.sessionEventSubscribers.subscribe("sidebar");
      start(params);
      const read = () => prepareProjectedSessionPresentation(projection).snapshot(query).row;
      expect(read()).not.toHaveProperty("backgroundProcessCount");
      vi.useFakeTimers();
      const process = createProcessSessionFixture({ id: "background", backgrounded: true });
      process.scopeKey = key;
      process.agentId = "main";
      addSession(process);
      expect(read()).toMatchObject({ backgroundProcessCount: 1, status: "done" });
      await vi.advanceTimersByTimeAsync(5_000);
      await waitForFast(() =>
        expect(params.broadcastToConnIds).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({
            reason: "background-processes",
            backgroundProcessCount: 1,
            session: expect.objectContaining({ key, backgroundProcessCount: 1 }),
          }),
          new Set(["sidebar"]),
          expect.any(Object),
        ),
      );
      vi.mocked(params.broadcastToConnIds).mockClear();
      markExited(process, 0, null, "completed");
      expect(read()).not.toHaveProperty("backgroundProcessCount");
      await vi.advanceTimersByTimeAsync(5_000);
      await waitForFast(() =>
        expect(params.broadcastToConnIds).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({
            reason: "background-processes",
            backgroundProcessCount: null,
            session: expect.objectContaining({ key, backgroundProcessCount: null }),
          }),
          new Set(["sidebar"]),
          expect.any(Object),
        ),
      );
      expect(params.broadcast).toHaveBeenCalledWith(
        "sessions.processes.changed",
        { sessionKey: key, agentId: "main" },
        expect.any(Object),
      );
    });
  });
}
