import { afterEach, expect, it } from "vitest";
import { recordRequiredCompletionNotice } from "../agents/subagents/completion/subagent-completion-admission.store.js";
import { records } from "../agents/subagents/completion/subagent-completion-admission.test-helpers.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { event, runId, seed, target } from "./session-lifecycle-run-failure.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

afterEach(() => clearRuntimeConfigSnapshot());

it("keeps a yielded delivery failure as one accurate completion notice", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    await seed();
    const { subagent } = records();
    subagent.requesterSettleWake = {
      status: "dispatching",
      attemptCount: 1,
      requesterYieldBatch: true,
      requesterRunId: runId,
    };
    await recordRequiredCompletionNotice(subagent, "delivery unavailable");
    const before = await loadTranscriptEvents(target);
    await persistGatewaySessionLifecycleEvent({
      ...target,
      event: { ...event, data: { ...event.data, error: "delivery unavailable" } },
    });
    expect(loadSessionEntry(target)?.status).toBe("failed");
    expect(await loadTranscriptEvents(target)).toEqual(before);
    expect(before).toContainEqual(
      expect.objectContaining({
        type: "custom_message",
        customType: "subagent-completion",
        details: expect.objectContaining({ runId, error: "delivery unavailable" }),
      }),
    );
  });
});
