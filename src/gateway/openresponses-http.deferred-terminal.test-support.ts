import OpenAI from "openai";
import { expect, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { parseSseEvents } from "./http-stream.test-support.js";
import { agentCommandMock } from "./test-helpers.js";

export async function expectDeferredTerminalResponse(
  port: number,
  name: string,
  failed: boolean,
  providerTerminal: boolean,
  reject: boolean,
  beforeRelease?: (work: ReadonlyArray<{ kind: string; settled: boolean }>) => void,
) {
  const idleRootCount = getActiveGatewayRootWorkCount();
  let terminalAdmission: { active: number } | undefined;
  let wireRead: Promise<string> | undefined;
  const continueAgent = createDeferred();
  const lifecycleTerminals: string[] = [];
  const ownedWork: Array<{ kind: string; promise: Promise<unknown>; settled: boolean }> = [];
  const own = <T>(kind: string, promise: Promise<T>): Promise<T> => {
    const work = { kind, promise, settled: false };
    ownedWork.push(work);
    void promise.then(
      () => {
        work.settled = true;
      },
      () => {
        work.settled = true;
      },
    );
    return promise;
  };
  const providerFailure = new Error("provider request failed");
  let agentEntered = false;
  let assertionFailed = false;
  let primaryFailure: unknown;
  const cleanupFailures: unknown[] = [];
  let stream: ReturnType<OpenAI["responses"]["stream"]> | undefined;
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
      terminalAdmission = { active };
    });
  });

  agentCommandMock.mockClear();
  agentCommandMock.mockImplementationOnce(((opts: unknown) =>
    own(
      "agent",
      (async () => {
        agentEntered = true;
        activeRunId = (opts as { runId?: string }).runId;
        if (!activeRunId) {
          throw new Error("expected a streaming response run ID");
        }
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
          throw providerFailure;
        }
        return {
          payloads: [{ text: "answer" }],
          meta: { agentMeta: { usage: { input: 3, output: 2, total: 5 } } },
        };
      })(),
    )) as never);

  try {
    const client = new OpenAI({
      apiKey: "test",
      baseURL: `http://127.0.0.1:${port}/v1`,
      defaultHeaders: { "x-openclaw-scopes": "operator.write" },
      maxRetries: 0,
      fetch: (input, init) =>
        own(
          "fetch",
          fetch(input, init).then((response) => {
            wireRead = own("wire", response.clone().text());
            return response;
          }),
        ),
    });
    stream = client.responses.stream({
      model: "openclaw",
      input: "Keep the stream owned.",
    });
    const terminalEvents: string[] = [];
    stream.on("response.completed", () => terminalEvents.push("response.completed"));
    stream.on("response.failed", () => terminalEvents.push("response.failed"));
    const finalResponse = own("sdk", stream.finalResponse());
    await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledTimes(1));
    beforeRelease?.(ownedWork);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    continueAgent.resolve();

    const response = await finalResponse;
    if (!wireRead) {
      throw new Error("expected the streaming HTTP response body");
    }
    const wire = await wireRead;

    expect(terminalAdmission?.active).toBe(idleRootCount + 1);
    expect(response.status).toBe(name);
    expect(terminalEvents).toEqual([`response.${name}`]);
    expect(lifecycleTerminals).toEqual([failed ? "error" : "end"]);
    expect(parseSseEvents(wire).at(-1)?.data).toBe("[DONE]");
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(idleRootCount));
  } catch (error) {
    assertionFailed = true;
    primaryFailure = error;
  } finally {
    continueAgent.resolve();
    // A failed pre-dispatch assertion must not leave a request free to consume
    // the next test's mock. Once entered, the released producer finishes normally.
    const abortedForCleanup = assertionFailed && !agentEntered;
    if (abortedForCleanup) {
      stream?.abort();
    }
    let joined = 0;
    const drain = async () => {
      while (joined < ownedWork.length) {
        const batch = ownedWork.slice(joined);
        joined += batch.length;
        const results = await Promise.allSettled(batch.map((work) => work.promise));
        for (const [index, result] of results.entries()) {
          if (result.status !== "rejected" || result.reason === primaryFailure) {
            continue;
          }
          if (batch[index]?.kind === "agent" && reject && result.reason === providerFailure) {
            continue;
          }
          if (
            abortedForCleanup &&
            ((batch[index]?.kind === "sdk" && result.reason instanceof OpenAI.APIUserAbortError) ||
              (result.reason instanceof Error && result.reason.name === "AbortError"))
          ) {
            continue;
          }
          cleanupFailures.push(result.reason);
        }
      }
    };
    try {
      await drain();
      try {
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(idleRootCount));
      } catch (error) {
        cleanupFailures.push(error);
      }
      // Root retirement may join an agent that entered after fetch cancellation.
      await drain();
    } finally {
      unsubscribe();
    }
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      [...(assertionFailed ? [primaryFailure] : []), ...cleanupFailures],
      "deferred response fixture did not retire cleanly",
    );
  }
  if (assertionFailed) {
    throw primaryFailure;
  }
}
