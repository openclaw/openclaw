import { expect, test, vi } from "vitest";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "../session-projection-work.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { invokeProjectMethod, projectsHandlers } from "./projects.test-support.js";

test("project recents do not enumerate unrelated sessions after projection hydration", async ({
  onTestFinished,
}) => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "recents-perf-" });
  const release = retainSessionListForegroundWork();
  const cfg = { agents: { entries: { main: {} } } };
  let projection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
  try {
    const profile = ensureProfileForEmail("recents@example.test");
    const actor = { type: "human" as const, source: "profile" as const, id: profile.id };
    const now = Date.now();
    const unrelated = 4_096;
    runOpenClawAgentWriteTransaction(
      (database) => {
        for (let index = 0; index < unrelated + 32; index++) {
          const foreign = index < unrelated;
          const own = index - unrelated;
          const key = foreign ? `agent:main:unrelated-${index}` : `agent:main:recent-${own}`;
          writeSessionEntry(
            database,
            key,
            {
              sessionId: key,
              updatedAt: now - index,
              archivedAt: now,
              createdActor: foreign ? { ...actor, id: "other" } : actor,
              spawnedCwd: foreign ? "/work/foreign" : `/work/recent-${Math.max(0, own - 24)}`,
            },
            { canonicalPreviousEntry: null, previousEntry: null },
          );
        }
      },
      { agentId: "main" },
    );
    projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const expected = Array.from({ length: 8 }, (_, index) => ({
      kind: "folder",
      folder: `/work/recent-${index}`,
      displayName: `recent-${index}`,
    }));
    const expectRecents = async () => {
      expect(
        await invokeProjectMethod(
          "projects.list",
          {},
          cfg,
          ["operator.write"],
          profile.id,
          projectsHandlers,
          projection,
        ),
      ).toMatchObject({ ok: true, payload: { recents: expected } });
    };
    await expectRecents();
    const originalEntries = Object.entries;
    let enumerated = 0;
    const enumeration = vi.spyOn(Object, "entries").mockImplementation((value) => {
      const entries = originalEntries(value);
      if (Object.hasOwn(value, "agent:main:unrelated-0")) {
        enumerated += entries.length;
      }
      return entries;
    });
    onTestFinished(() => enumeration.mockRestore());
    for (let index = 0; index < 7; index++) {
      await expectRecents();
    }
    expect(enumerated).toBe(0);
  } finally {
    projection?.dispose();
    release();
    await state.cleanup();
  }
});
