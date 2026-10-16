import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.entry.js";
import { readSessionTranscriptWatermark } from "../config/sessions/session-accessor.sqlite-transcript-watermark.js";
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

let testState: OpenClawTestState;
let testSignal: AbortSignal;
let cfg: OpenClawConfig;
let service: SessionActivitySummaryService;
const recap = "Completed the requested work.";
const complete = vi.fn<typeof defaultCompleteModel>();
const changed = vi.fn();
const read = () => loadSessionEntryReadOnly(scope);
const view = (
  entry = read(),
  watermark = readSessionTranscriptWatermark(scope),
  enabled?: boolean,
) => projectSessionActivitySummary({ ...target, cfg, entry, watermark, enabled });
const createService = () =>
  createSessionActivitySummaries({
    scheduler: createTestGatewayScheduler(),
    getConfig: () => cfg,
    onChanged: changed,
    prepareModel: async () => preparedActivityRecapModel,
    completeModel: complete,
  });
const ensure = async (entry = read()) => {
  const published = createDeferred();
  changed.mockImplementation(() => {
    if (view()?.state === "current") {
      published.resolve();
    }
  });
  const result = await service.ensure(target, entry);
  await withinTest(published.promise, testSignal);
  // The publication probe reads fixture state synchronously; detach it before SQL observation.
  changed.mockReset();
  return result;
};
const expectPrompt = (call: number, previousRecap: string, notes: string[]) => {
  expect(complete).toHaveBeenCalledTimes(call);
  expect(JSON.parse(complete.mock.calls[call - 1]![0].prompt)).toMatchObject({
    previousRecap,
    messages: notes,
  });
};

beforeEach(async ({ signal }) => {
  testSignal = signal;
  cfg = { agents: { defaults: { utilityModel: "test/utility" } } };
  testState = await createActivityRecapSessionFixture(cfg);
  complete.mockReset().mockResolvedValue(activityRecapResult(recap));
  changed.mockReset();
  service = createService();
});
afterEach(async () => {
  await service.dispose();
  await testState.cleanup();
});

it("keeps committed recap progress across stale requests and summarizes new activity once", async () => {
  await messages(1);
  await patchSessionEntryCore(scope, () => ({
    activitySummary: {
      version: 1,
      formatRevision: 1,
      text: "Earlier work.",
      updatedAt: 1,
      sessionId: scope.sessionId,
      lifecycleRevision: "lifecycle-1",
      ...readSessionTranscriptWatermark(scope),
      leafEntryId: "message-0",
      coveredMessages: 1,
      totalMessages: 1,
      omittedContent: false,
    },
  }));
  // A batched ensure can retain this entry while another request finishes its recap.
  const requestedEntry = read()!;
  await ensure(requestedEntry);
  expectPrompt(1, "Earlier work.", []);

  for (let request = 0; request < 3; request += 1) {
    const response = await ensure(requestedEntry);
    expect(response.text).toBe(recap);
    expect(complete).toHaveBeenCalledTimes(1);
  }

  await messages(1, 1);
  await ensure(requestedEntry);
  expectPrompt(2, recap, ["assistant: Outcome 1"]);
  await ensure(requestedEntry);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(read()?.activitySummary).toMatchObject({ coveredMessages: 2, totalMessages: 2 });
});

it("prepares recap freshness off thread and observes an in-process transcript append", async () => {
  await messages(1);
  await ensure();
  const entry = read()!;
  cfg = { agents: { defaults: {} } };
  const observed = observeHostDataSql();
  try {
    await service.ensure(target, entry);
    const before = await readSessionTranscriptWatermarkAsync(scope);
    expect(view(entry, before, true)?.state).toBe("current");
    await messages(1, 1);
    const after = await readSessionTranscriptWatermarkAsync(scope);
    expect(after.maxSeq).toBeGreaterThan(before.maxSeq!);
    expect(view(entry, after, true)?.state).toBe("stale");
    expect(observed.queries.join("\n")).not.toMatch(
      /transcript_events|transcript_rewrite_watermarks|session_transcript_cold_archives/i,
    );
  } finally {
    observed.restore();
  }
});

it("invalidates cached projection after an offline branch change without changing activity ordering", async () => {
  await messages(3);
  await ensure();
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
  await ensure();
  expect(view()?.state).toBe("current");
  expectPrompt(2, "", ["user: Outcome 0"]);
  const entry = read()!;
  const list = (includeActivitySummary: boolean) =>
    listSessionFixture({
      cfg,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: scope.agentId }),
      store: { [target.key]: entry },
      opts: includeActivitySummary ? { includeActivitySummary } : {},
    });
  expect((await list(false)).sessions[0]?.activitySummary).toBeUndefined();
  expect((await list(true)).sessions[0]?.activitySummary).toMatchObject({
    text: recap,
    state: "current",
  });
});
