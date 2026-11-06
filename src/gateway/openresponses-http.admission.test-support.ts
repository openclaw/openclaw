import OpenAI from "openai";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { parseSseEvents } from "./http-stream.test-support.js";
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
      const entered = createDeferred();
      const terminalAdmission = createDeferred<{ active: number }>();
      const wireResponse = createDeferred<string>();
      const continueAgent = createDeferred();
      const lifecycleTerminals: string[] = [];
      let activeRunId: string | undefined;
      const unsubscribe = onAgentEvent((event) => {
        const phase = event.data?.phase;
        if (event.runId !== activeRunId || event.stream !== "lifecycle") {
          return;
        }
        if (phase !== "end" && phase !== "error") {
          return;
        }
        lifecycleTerminals.push(phase);
        // Restart drains run before the next-turn SSE finalizer, so inspect the real
        // root owner at that boundary instead of observing eventual client delivery.
        queueMicrotask(() => {
          const active = getActiveGatewayRootWorkCount();
          terminalAdmission.resolve({ active });
        });
      });

      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce((async (opts: unknown) => {
        activeRunId = (opts as { runId?: string }).runId;
        if (!activeRunId) {
          throw new Error("expected a streaming response run ID");
        }
        entered.resolve();
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
        return {
          payloads: [{ text: "answer" }],
          meta: { agentMeta: { usage: { input: 3, output: 2, total: 5 } } },
        };
      }) as never);

      const client = new OpenAI({
        apiKey: "test",
        baseURL: `http://127.0.0.1:${getPort()}/v1`,
        defaultHeaders: { "x-openclaw-scopes": "operator.write" },
        maxRetries: 0,
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
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            completion,
            "Response settled before agent entry",
          ),
          signal,
        );
        expect(agentCommandMock).toHaveBeenCalledTimes(1);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        continueAgent.resolve();

        const [admission, [response, wire]] = await withinTest(
          Promise.all([terminalAdmission.promise, completion]),
          signal,
        );

        expect(admission.active).toBe(idleRootCount + 1);
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
