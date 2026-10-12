import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.entry.js";
import { readSessionTranscriptWatermark } from "../config/sessions/session-accessor.sqlite-transcript-watermark.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import { appendTranscriptEvent } from "../config/sessions/session-accessor.transcript.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { readSessionTranscriptWatermarkAsync } from "../config/sessions/session-transcript-watermark.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createSessionActivitySummaries,
  type SessionActivitySummaryService,
} from "./session-activity-summaries.js";
import {
  activityRecapResult,
  createActivityRecapSessionFixture,
  messages,
  preparedActivityRecapModel,
  scope,
  target,
} from "./session-activity-summaries.test-support.js";
import { projectSessionActivitySummary } from "./session-activity-summary-state.js";
import { listSessionFixture } from "./session-list.test-support.js";
import type { defaultCompleteModel } from "./session-observer-model.js";

describe("Activity recap freshness after transcript writes", () => {
  let testState: OpenClawTestState;
  let testSignal: AbortSignal;
  let cfg: OpenClawConfig;
  let service: SessionActivitySummaryService;
  const complete = vi.fn(async (_params: Parameters<typeof defaultCompleteModel>[0]) =>
    activityRecapResult("Completed the requested work."),
  );
  const changed = vi.fn();
  const read = () => loadSessionEntryReadOnly(scope);
  const view = () =>
    projectSessionActivitySummary({
      ...target,
      cfg,
      entry: read(),
      watermark: readSessionTranscriptWatermark(scope),
    });
  const createService = () =>
    createSessionActivitySummaries({
      scheduler: createTestGatewayScheduler(),
      getConfig: () => cfg,
      onChanged: changed,
      prepareModel: async () => preparedActivityRecapModel,
      completeModel: complete,
    });
  const awaitPublication = async (start: () => unknown) => {
    const published = createDeferred();
    changed.mockImplementation(() => {
      if (view()?.state === "current") {
        published.resolve();
      }
    });
    await start();
    await withinTest(published.promise, testSignal);
    // The publication probe reads fixture state synchronously; detach it before SQL observation.
    changed.mockReset();
  };

  beforeEach(async ({ signal }) => {
    testSignal = signal;
    testState = await createActivityRecapSessionFixture();
    cfg = { agents: { defaults: { utilityModel: "test/utility" } } };
    complete
      .mockReset()
      .mockImplementation(async () => activityRecapResult("Completed the requested work."));
    changed.mockReset();
    service = createService();
  });
  afterEach(async () => {
    await service.dispose();
    await testState.cleanup();
  });

  it("prepares recap freshness off thread and observes an in-process transcript append", async () => {
    await messages(1);
    await awaitPublication(() => service.ensure(target));
    const entry = read()!;
    cfg = { agents: { defaults: {} } };
    const observed = observeHostDataSql();
    try {
      await service.ensure(target);
      const before = await readSessionTranscriptWatermarkAsync(scope);
      expect(
        projectSessionActivitySummary({ ...target, cfg, entry, enabled: true, watermark: before })
          ?.state,
      ).toBe("current");
      await persistSessionTranscriptTurn(scope, {
        expectedSessionId: scope.sessionId,
        messages: [
          {
            eventId: "freshness-append",
            message: { role: "assistant", content: "Completed another step." },
          },
        ],
        touchSessionEntry: false,
      });
      const after = await readSessionTranscriptWatermarkAsync(scope);
      expect(after.maxSeq).toBeGreaterThan(before.maxSeq!);
      expect(
        projectSessionActivitySummary({ ...target, cfg, entry, enabled: true, watermark: after })
          ?.state,
      ).toBe("stale");
      expect(
        observed.queries.filter((sql) =>
          /transcript_events|transcript_rewrite_watermarks|session_transcript_cold_archives/i.test(
            sql,
          ),
        ),
      ).toEqual([]);
    } finally {
      observed.restore();
    }
  });

  it("invalidates cached projection after an offline branch change without changing activity ordering", async () => {
    await messages(3);
    await awaitPublication(() => service.ensure(target));
    expect(view()?.state).toBe("current");
    await service.dispose();
    const oldActivity = read()?.updatedAt;
    const oldWatermark = readSessionTranscriptWatermark(scope);
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "rewind",
      parentId: "message-0",
      targetId: "message-0",
    });
    expect(readSessionTranscriptWatermark(scope).generation).toBe(oldWatermark.generation);
    expect(read()?.updatedAt).toBe(oldActivity);
    expect(view()?.state).toBe("stale");
    // Offline edits rebuild asynchronously; finish the fixture before restarting its observer.
    await waitForSessionTranscriptProjection(scope);
    service = createService();
    await awaitPublication(() => service.ensure(target));
    expect(view()?.state).toBe("current");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(JSON.parse(complete.mock.calls[1]![0].prompt)).toMatchObject({
      previousRecap: "",
      messages: ["user: Outcome 0"],
    });
    const entry = read()!;
    const ordinary = await listSessionFixture({
      cfg,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: scope.agentId }),
      store: { [target.key]: entry },
      opts: {},
    });
    expect(ordinary.sessions[0]?.activitySummary).toBeUndefined();
    const activity = await listSessionFixture({
      cfg,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: scope.agentId }),
      store: { [target.key]: entry },
      opts: { includeActivitySummary: true },
    });
    expect(activity.sessions[0]?.activitySummary).toMatchObject({
      text: "Completed the requested work.",
      state: "current",
    });
  });
});
