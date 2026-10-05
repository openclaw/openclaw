import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../../test/helpers/promise.js";
import {
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID,
} from "../../../agents/embedded-agent-runner/run-state.js";
import * as embeddedRuns from "../../../agents/embedded-agent-runner/runs.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  SESSION_ID,
  installNativePluginTestHooks,
  upstream,
  withParkedNativeTask,
} from "./client-native-control.test-support.js";

describe("native Talk registration readiness cleanup", () => {
  installNativePluginTestHooks();
  registerAgentSessionLoopTestLifecycle();

  it(
    "releases the provider when unpublished registration readiness is cancelled",
    { timeout: 10_000 },
    async ({ signal }) => {
      const { session } = await createTestSession();
      const providerStream = createAssistantMessageEventStream();
      const answer = createAssistant(testModel, [{ type: "text", text: "Task finished." }]);
      const finish = vi.fn(() => {
        providerStream.push({ type: "done", reason: "stop", message: answer });
        providerStream.end();
      });
      const providerStarted = createDeferredCore();
      const cancelReadiness = new AbortController();
      streamMocks.streamSimple.mockImplementation(() => {
        providerStarted.resolve();
        return providerStream;
      });
      const publish = vi.spyOn(embeddedRuns, "setActiveEmbeddedRun").mockImplementation(() => {});
      const assertions = vi.fn(async () => {});

      const parked = withParkedNativeTask(
        assertions,
        "Keep working until I cancel.",
        session,
        finish,
        cancelReadiness.signal,
      );
      const outcome = parked.then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            providerStarted.promise,
            parked,
            "Native task completed before the provider stream started",
          ),
          signal,
        );
        expect(assertions).not.toHaveBeenCalled();
        expect(publish).toHaveBeenCalledOnce();
        expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
        expect(ACTIVE_EMBEDDED_RUNS.has(SESSION_ID)).toBe(false);
      } finally {
        cancelReadiness.abort(new Error("Synthetic registration readiness cancellation"));
        await outcome;
      }
      expect((await outcome).error).toMatchObject({
        message: "Synthetic registration readiness cancellation",
      });
      expect(assertions).not.toHaveBeenCalled();
      expect(finish).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledOnce();
      expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
      expect(await providerStream.result()).toBe(answer);
      expect(session.isStreaming).toBe(false);
      expect(ACTIVE_EMBEDDED_RUNS.has(SESSION_ID)).toBe(false);
      const runId = upstream.runEmbeddedAgent.mock.calls[0]![0].runId;
      expect(ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.has(runId)).toBe(false);
    },
  );
});
