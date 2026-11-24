import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { emitAgentEvent, onAgentEventForRun } from "../infra/agent-events.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { createOpenAiHttpTestClient, parseSseEvents } from "./http-stream.test-support.js";
import { agentCommandMock } from "./test-helpers.js";

export function registerOpenResponsesHttpAdmissionTests(getPort: () => number) {
  it.for([
    ["completed response without a provider terminal", "completed", false, false, false],
    ["provider-failed response with a resolved run", "failed", true, true, false],
    ["rejected response with a provider terminal", "failed", true, true, true],
  ] as const)(
    "keeps the %s admitted until its deferred SSE terminal is written",
    async ([_label, name, failed, providerTerminal, reject], { signal }) => {
      const idleRootCount = getActiveGatewayRootWorkCount();
      const entered = createDeferred<string>();
      const terminalAdmission = createDeferred<number>();
      const wireResponse = createDeferred<string>();
      const continueAgent = createDeferred();
      const lifecycleTerminals: string[] = [];
      let unsubscribe = () => {};

      agentCommandMock.mockImplementationOnce((async (opts: unknown) => {
        const activeRunId = (opts as { runId?: string }).runId;
        if (!activeRunId) {
          throw new Error("expected a streaming response run ID");
        }
        entered.resolve(activeRunId);
        await continueAgent.promise;
        emitAgentEvent({ runId: activeRunId, stream: "assistant", data: { delta: "answer" } });
        if (providerTerminal) {
          emitAgentEvent({
            runId: activeRunId,
            stream: "lifecycle",
            data: failed ? { phase: "error", error: "provider request failed" } : { phase: "end" },
          });
        }
        if (reject) {
          throw new Error("provider request failed");
        }
        return { payloads: [{ text: "answer" }] };
      }) as never);

      const client = createOpenAiHttpTestClient(getPort()).withOptions({
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          void response.clone().text().then(wireResponse.resolve, wireResponse.reject);
          return response;
        },
      });
      const stream = client.responses.stream({
        model: "openclaw",
        input: "Keep the stream owned.",
      });
      const terminalEvents: string[] = [];
      stream.on("response.completed", () => terminalEvents.push("response.completed"));
      stream.on("response.failed", () => terminalEvents.push("response.failed"));
      const completion = Promise.all([stream.finalResponse(), wireResponse.promise]);
      try {
        const entry = awaitGateBeforeSettlement(
          entered.promise,
          completion,
          "Response ended before entry",
        );
        const activeRunId = await withinTest(entry, signal);
        unsubscribe = onAgentEventForRun(activeRunId, (event) => {
          const phase = event.data?.phase;
          if (event.stream !== "lifecycle" || (phase !== "end" && phase !== "error")) {
            return;
          }
          lifecycleTerminals.push(phase);
          // Observe restart admission before the next-turn SSE finalizer.
          queueMicrotask(() => terminalAdmission.resolve(getActiveGatewayRootWorkCount()));
        });
        expect(agentCommandMock).toHaveBeenCalledTimes(1);
        continueAgent.resolve();

        const [response, wire] = await withinTest(completion, signal);
        const admission = await withinTest(terminalAdmission.promise, signal);

        expect(admission).toBe(idleRootCount + 1);
        expect(response.status).toBe(name);
        expect(terminalEvents).toEqual([`response.${name}`]);
        expect(lifecycleTerminals).toEqual([failed ? "error" : "end"]);
        expect(parseSseEvents(wire).at(-1)?.data).toBe("[DONE]");
      } finally {
        continueAgent.resolve();
        stream.abort();
        await completion.catch(() => {});
        unsubscribe();
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(idleRootCount));
      }
    },
  );
}
