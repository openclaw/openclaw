import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as utilityCompletion from "../agents/utility-completion.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.entry.js";
import { readSessionTranscriptWatermark } from "../config/sessions/session-accessor.sqlite-transcript-watermark.js";
import { appendTranscriptEvent } from "../config/sessions/session-accessor.transcript.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
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
import * as summarySource from "./session-activity-summary-source.js";
import { projectSessionActivitySummary } from "./session-activity-summary-state.js";
import { listSessionFixture } from "./session-list.test-support.js";
import type { defaultCompleteModel } from "./session-observer-model.js";
import * as observerModel from "./session-observer-model.js";

let testState: OpenClawTestState;
let cfg: OpenClawConfig;
let service: SessionActivitySummaryService;
const recap = "Completed the requested work.";
const complete = vi.fn<typeof defaultCompleteModel>();
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
  });
const ensure = async (entry = read()) => {
  const work = new AsyncWorkScope();
  const result = await work.track(() => service.ensure(target, entry));
  await work.drain();
  expect(view()?.state).toBe("current");
  return result;
};
const expectPrompt = (call: number, previousRecap: string, notes: string[]) => {
  expect(complete).toHaveBeenCalledTimes(call);
  expect(JSON.parse(complete.mock.calls[call - 1]![0].prompt)).toMatchObject({
    previousRecap,
    messages: notes,
  });
};

beforeEach(async () => {
  cfg = { agents: { defaults: { utilityModel: "test/utility" } } };
  testState = await createActivityRecapSessionFixture(cfg);
  complete.mockReset().mockResolvedValue(activityRecapResult(recap));
  vi.spyOn(utilityCompletion, "hasAvailableUtilityCompletionAuth").mockResolvedValue(true);
  vi.spyOn(observerModel, "defaultPrepareModel").mockResolvedValue(preparedActivityRecapModel);
  vi.spyOn(observerModel, "defaultCompleteModel").mockImplementation(complete);
  changed.mockReset();
  service = createService();
});
afterEach(async () => {
  await service.dispose();
  await testState.cleanup();
  vi.restoreAllMocks();
});

it("keeps committed recap progress across stale requests and summarizes new activity once", async () => {
  await messages(1);
  await ensure();
  complete.mockClear();
  const initialSummary = read()!.activitySummary!;
  await patchSessionEntryCore(scope, () => ({
    activitySummary: {
      ...initialSummary,
      formatRevision: 1,
      text: "Earlier work.",
      updatedAt: 1,
    },
  }));
  // A batched ensure can retain this entry while another request finishes its recap.
  const requestedEntry = read()!;
  await ensure(requestedEntry);
  expectPrompt(1, "Earlier work.", []);

  changed.mockClear();
  const sourceReads = vi.spyOn(summarySource, "readActivitySummarySource");
  expect((await ensure(requestedEntry)).text).toBe(recap);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(changed).not.toHaveBeenCalled();
  expect(sourceReads).not.toHaveBeenCalled();

  await messages(1, 1);
  await ensure(requestedEntry);
  expectPrompt(2, recap, ["assistant: Outcome 1"]);
  expect(sourceReads).toHaveBeenCalledTimes(1);
  await ensure(requestedEntry);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(read()?.activitySummary).toMatchObject({ coveredMessages: 2, totalMessages: 2 });
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
