import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import * as utilityCompletion from "../agents/utility-completion.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  readSessionTranscriptWatermark,
} from "../config/sessions/session-accessor.js";
import { createOwnedTestInstance } from "../plugins/plugin-instance.test-support.js";
import { PluginInvocationScope } from "../plugins/plugin-invocation-scope.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { createSessionActivitySummaries } from "./session-activity-summaries.js";
import {
  activityRecapResult,
  createActivityRecapSessionFixture,
  messages,
  preparedActivityRecapModel,
  scope,
  target,
} from "./session-activity-summaries.test-support.js";
import { projectSessionActivitySummary } from "./session-activity-summary-state.js";
import * as observerModel from "./session-observer-model.js";

it("finishes an archive recap after the calling plugin scope closes", async ({ signal }) => {
  const cfg = { agents: { defaults: { utilityModel: "test/utility" } } };
  const state = await createActivityRecapSessionFixture(cfg);
  const connectionWork = new AsyncWorkScope();
  const service = createSessionActivitySummaries({
    scheduler: createTestGatewayScheduler(),
    getConfig: () => cfg,
    onChanged: () => {},
  });
  const context = createGatewayRequestContext(
    makeContextParams({ connectionWork, sessionActivitySummaries: service }),
  );
  const plugin = createOwnedTestInstance("archive-caller");
  const caller = new PluginInvocationScope(plugin.owner!.registry!, [plugin]);
  const started = createDeferred();
  const resume = createDeferred();
  vi.spyOn(utilityCompletion, "hasAvailableUtilityCompletionAuth").mockResolvedValue(true);
  const prepare = vi
    .spyOn(observerModel, "defaultPrepareModel")
    .mockResolvedValue(preparedActivityRecapModel);
  vi.spyOn(observerModel, "defaultCompleteModel").mockResolvedValue(
    activityRecapResult("Completed the requested work."),
  );
  try {
    await messages(2);
    await connectionWork.track(() => service.ensure(target, loadSessionEntryReadOnly(scope)));
    await connectionWork.runWhenIdle(() => {});
    await messages(2, 2);
    prepare.mockImplementationOnce(async () => {
      started.resolve();
      await withinTest(resume.promise, signal);
      return plugin.wrap(() => preparedActivityRecapModel)();
    });
    const response = await caller.run(() =>
      dispatchGatewayRequestInProcessRaw(
        "sessions.patch",
        { ...target, expectedSessionId: scope.sessionId, archived: true },
        { context, client: createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] }) },
      ),
    );
    expect(response).toMatchObject({ ok: true });
    expect(loadSessionEntryReadOnly(scope)?.archivedAt).toBeDefined();
    await withinTest(started.promise, signal);
    caller.release();
    resume.resolve();
    await connectionWork.runWhenIdle(() => {});
    const entry = loadSessionEntryReadOnly(scope);
    expect(entry?.activitySummary).toMatchObject({
      coveredMessages: 4,
      text: "Completed the requested work.",
    });
    expect(
      projectSessionActivitySummary({
        ...target,
        cfg,
        entry,
        watermark: readSessionTranscriptWatermark(scope),
      })?.state,
    ).toBe("current");
  } finally {
    caller.release();
    resume.resolve();
    await AsyncWorkScope.runWhenAllIdle(
      () => [connectionWork],
      () => connectionWork.drain(),
    );
    await service.dispose();
    await state.cleanup();
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
  }
});
