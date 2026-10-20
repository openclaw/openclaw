import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as registryRead from "../agents/subagents/registry/subagent-registry-read.js";
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
import { createSessionRowProjection } from "./session-row-projection.js";
import { seedSessionRowProjectionTranscriptFixture } from "./session-row-projection.transcript-fixture.test-support.js";
import * as rowInputs from "./session-utils-row.js";

afterEach(() => vi.restoreAllMocks());

it("serves describe during a 2,048-session drain without transcript reads in row materialization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const count = seedSessionRowProjectionTranscriptFixture();
    for (const index of [0, count - 1]) {
      expect(
        transcripts.readSessionTranscriptMessageEventPage(
          {
            agentId: "main",
            sessionId: `legacy-${index}`,
            sessionKey: `agent:main:legacy-${index}`,
          },
          { maxMessages: 2, offset: 0 },
        ),
      ).toMatchObject({ totalMessages: 2, events: [expect.anything(), expect.anything()] });
    }
    let inMaterialization = false;
    let materializationReads = 0;
    let describeInFlight = false;
    let describeMaterializations = 0;
    const readInputs = rowInputs.readSessionRowInputs;
    vi.spyOn(rowInputs, "readSessionRowInputs").mockImplementation((params) => {
      inMaterialization = true;
      if (describeInFlight) {
        describeMaterializations++;
      }
      try {
        return readInputs(params);
      } finally {
        inMaterialization = false;
      }
    });
    const observeRead =
      <Args extends unknown[], Result>(read: (...args: Args) => Result) =>
      (...args: Args): Result => {
        if (inMaterialization) {
          materializationReads++;
        }
        return read(...args);
      };
    const page = observeRead(transcripts.readSessionTranscriptMessageEventPage);
    const recent = observeRead(activeEvents.readRecentSessionTranscriptMessageEvents);
    const tail = observeRead(activeEvents.readSessionTranscriptBoundedMessageTailPage);
    vi.spyOn(transcripts, "readSessionTranscriptMessageEventPage").mockImplementation(page);
    vi.spyOn(activeEvents, "readRecentSessionTranscriptMessageEvents").mockImplementation(recent);
    vi.spyOn(activeEvents, "readSessionTranscriptBoundedMessageTailPage").mockImplementation(tail);
    const context = requestContext(cfg);
    const indexBuilds = vi.spyOn(registryRead, "buildSubagentSessionListReadIndex");
    const initializing = createSessionRowProjection({ cfg });
    await nextTurn();
    const projection = await initializing;
    bindSessionRowProjection(context, () => projection);
    /** Resolves with the dirty rows left at the reply and the rows materialized meanwhile. */
    const describe = async (id: string, includeDerivedTitles?: boolean) => {
      let remainingAtResponse = 0;
      const respond = vi.fn().mockImplementation(() => {
        remainingAtResponse = projection.dirtyRowCount;
      });
      const releaseForeground = retainSessionListForegroundWork();
      describeInFlight = true;
      describeMaterializations = 0;
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
        describeInFlight = false;
        releaseForeground();
      }
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        session: expect.objectContaining({ key: "agent:main:legacy-2047" }),
      });
      return { remainingAtResponse, materializedRows: describeMaterializations };
    };
    try {
      const underDrain = await describe("under-drain", true);
      await projection.ensureMaterialized();
      expect(indexBuilds).toHaveBeenCalledTimes(1);
      sessionChanges.emit({ all: true, scope: "config" });
      const dirtyDrain = await describe("dirty-drain");
      expect(materializationReads).toBe(0);
      // A response must not depend on completion of unrelated resident rows.
      expect(underDrain.remainingAtResponse).toBeGreaterThan(0);
      expect(dirtyDrain.remainingAtResponse).toBeGreaterThan(0);
      // A keyed read materializes its own exact facts and at most the bulk batch
      // already in flight; the drain parks behind the retained exact preparation.
      expect(underDrain.materializedRows).toBeLessThanOrEqual(MAX_SESSION_ROW_FACTS_KEYS + 1);
      expect(dirtyDrain.materializedRows).toBeLessThanOrEqual(MAX_SESSION_ROW_FACTS_KEYS + 1);
    } finally {
      projection.dispose();
    }
  });
}, 120_000);
