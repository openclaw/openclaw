import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import * as transcripts from "../config/sessions/session-accessor.js";
import * as activeEvents from "../config/sessions/session-accessor.sqlite-active-events.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "../config/sessions/session-transcript-worker.types.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createTestProjection } from "./session-row-projection.read-fixture.test-support.js";
import { seedSessionRowProjectionTranscriptFixture } from "./session-row-projection.transcript-fixture.test-support.js";
import * as rowInputs from "./session-utils-row.js";

afterEach(() => vi.restoreAllMocks());

it("serves describe during a 2,048-session drain without transcript reads in row materialization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const count = seedSessionRowProjectionTranscriptFixture();
    const readPage = transcripts.readSessionTranscriptMessageEventPage;
    for (const index of [0, count - 1]) {
      const sessionId = `legacy-${index}`;
      const scope = { agentId: "main", sessionId, sessionKey: `agent:main:${sessionId}` };
      expect(readPage(scope, { maxMessages: 2, offset: 0 })).toMatchObject({
        totalMessages: 2,
        events: [expect.anything(), expect.anything()],
      });
    }
    let readDuringMaterialization = false;
    const transcriptReads = [
      vi.spyOn(transcripts, "readSessionTranscriptMessageEventPage"),
      vi.spyOn(activeEvents, "readRecentSessionTranscriptMessageEvents"),
      vi.spyOn(activeEvents, "readSessionTranscriptBoundedMessageTailPage"),
    ];
    const counts = () => transcriptReads.map((read) => read.mock.calls.length);
    const readInputs = rowInputs.readSessionRowInputs;
    const materialize = vi.spyOn(rowInputs, "readSessionRowInputs").mockImplementation((params) => {
      const before = counts();
      try {
        return readInputs(params);
      } finally {
        readDuringMaterialization ||= counts().some((calls, index) => calls !== before[index]);
      }
    });
    const context = requestContext(cfg);
    const initializing = createTestProjection({ cfg });
    await nextTurn();
    using projection = await initializing;
    bindSessionRowProjection(context, () => projection);
    const describe = async (id: string, includeDerivedTitles?: boolean) => {
      const respond = vi.fn(() => projection.dirtyRowCount);
      const releaseForeground = retainSessionListForegroundWork();
      const before = materialize.mock.calls.length;
      try {
        await sessionByKeyReadHandlers["sessions.describe"]!({
          req: { type: "req", id, method: "sessions.describe" },
          params: { key: "agent:main:legacy-2047", includeDerivedTitles },
          context,
          client: null,
          isWebchatConnect: () => false,
          respond,
        });
      } finally {
        releaseForeground();
      }
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({ key: "agent:main:legacy-2047" }),
      });
      // Keyed replies must precede the bulk drain and do only bounded materialization work.
      expect(respond.mock.results[0]?.value).toBeGreaterThan(0);
      expect(materialize.mock.calls.length - before).toBeLessThanOrEqual(
        MAX_SESSION_ROW_FACTS_KEYS + 1,
      );
    };
    await describe("under-drain", true);
    await projection.ensureMaterialized();
    sessionChanges.emit({ all: true, scope: "config" });
    await describe("dirty-drain");
    expect(readDuringMaterialization).toBe(false);
  });
}, 120_000);
