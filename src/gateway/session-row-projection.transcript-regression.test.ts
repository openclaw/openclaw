import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as registryRead from "../agents/subagents/registry/subagent-registry-read.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import * as transcripts from "../config/sessions/session-accessor.js";
import * as activeEvents from "../config/sessions/session-accessor.sqlite-active-events.js";
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
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
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
    console.log("Prepared 2,048 legacy rows and transcript graphs");
    let inMaterialization = false;
    let materializationTranscriptReads = 0;
    const readInputs = rowInputs.readSessionRowInputs;
    vi.spyOn(rowInputs, "readSessionRowInputs").mockImplementation((params) => {
      inMaterialization = true;
      try {
        return readInputs(params);
      } finally {
        inMaterialization = false;
      }
    });
    const readPage = transcripts.readSessionTranscriptMessageEventPage;
    vi.spyOn(transcripts, "readSessionTranscriptMessageEventPage").mockImplementation((...args) => {
      if (inMaterialization) {
        materializationTranscriptReads++;
      }
      return readPage(...args);
    });
    let materializationUsageReads = 0;
    const readUsage = activeEvents.readRecentSessionTranscriptMessageEvents;
    vi.spyOn(activeEvents, "readRecentSessionTranscriptMessageEvents").mockImplementation(
      (...args) => {
        if (inMaterialization) {
          materializationUsageReads++;
        }
        return readUsage(...args);
      },
    );
    let materializationBoundedReads = 0;
    const readBounded = activeEvents.readSessionTranscriptBoundedMessageTailPage;
    vi.spyOn(activeEvents, "readSessionTranscriptBoundedMessageTailPage").mockImplementation(
      (...args) => {
        if (inMaterialization) {
          materializationBoundedReads++;
        }
        return readBounded(...args);
      },
    );
    const context = requestContext(cfg);
    const indexBuilds = vi.spyOn(registryRead, "buildSubagentSessionListReadIndex");
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    const initializing = createSessionRowProjection({ cfg });
    await nextTurn();
    const projection = await initializing;
    bindSessionRowProjection(context, () => projection);
    const startupMs = performance.now() - started;
    const respond = vi.fn();
    const describe = async (id: string, includeDerivedTitles?: boolean) => {
      const releaseForeground = retainSessionListForegroundWork();
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
    };
    try {
      const requestStarted = performance.now();
      await describe("under-drain", true);
      const describeMs = performance.now() - requestStarted;
      const remainingAtResponse = projection.dirtyRowCount;
      await projection.ensureMaterialized();
      const initialDrainMs = performance.now() - started;
      const initialDrainCpu = process.threadCpuUsage(cpu);
      expect(indexBuilds).toHaveBeenCalledTimes(1);
      sessionChanges.emit({ all: true, scope: "config" });
      const dirtyRequestStarted = performance.now();
      await describe("dirty-drain");
      const dirtyDescribeMs = performance.now() - dirtyRequestStarted;
      const remainingAfterDirtyResponse = projection.dirtyRowCount;
      console.log(
        JSON.stringify({
          count,
          startupMs,
          initialDrainMs,
          initialDrainThreadCpuMs: (initialDrainCpu.user + initialDrainCpu.system) / 1000,
          describeMs,
          dirtyDescribeMs,
          remainingAfterDirtyResponse,
          remainingAtResponse,
          materializationTranscriptReads,
          materializationUsageReads,
          materializationBoundedReads,
        }),
      );
      expect(respond).toHaveBeenCalledWith(true, {
        session: expect.objectContaining({ key: "agent:main:legacy-2047" }),
      });
      expect(materializationTranscriptReads).toBe(0);
      expect(materializationUsageReads).toBe(0);
      expect(materializationBoundedReads).toBe(0);
      expect(describeMs).toBeLessThan(100);
      expect(dirtyDescribeMs).toBeLessThan(100);
      // A response must not depend on completion of unrelated resident rows.
      expect(remainingAtResponse).toBeGreaterThan(0);
      expect(remainingAfterDirtyResponse).toBeGreaterThan(0);
    } finally {
      projection.dispose();
    }
  });
}, 120_000);
