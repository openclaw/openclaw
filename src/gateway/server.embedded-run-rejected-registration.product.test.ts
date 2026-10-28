import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, it } from "vitest";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getActiveNativeAttempt,
  getEmbeddedRunAttachment,
} from "../agents/embedded-agent-runner/run-state.js";
import {
  attachActiveEmbeddedRun,
  resolveActiveEmbeddedRunOwnerByRunId,
} from "../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../agents/embedded-agent-runner/runs.test-support.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createSubagentStopFixture } from "./server.subagent-stop-settlement.product.test-support.js";
import { disconnectGatewayClient } from "./test-helpers.e2e.js";

const firstRunId = "rejected-registration-predecessor";
const rejectedRunId = "rejected-registration-successor";
const sessionKey = "agent:main:rejected-registration-proof";
const firstPrompt = "Hold the predecessor model request until the Gateway stops it.";
const registrationRejected = "proof: replacement registration authority rejected";

type Gateway = Awaited<ReturnType<Awaited<ReturnType<typeof createSubagentStopFixture>>["start"]>>;
type Deferred<T> = ReturnType<typeof createDeferred<T>>;

async function onModelRequest(
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
  started: Deferred<void>,
  providerStopped: Deferred<void>,
  providerRequests: string[],
) {
  providerRequests.push(body);
  if (body.includes(firstPrompt)) {
    const closed = createDeferred();
    request.once("aborted", () => closed.resolve(undefined));
    response.once("close", () => closed.resolve(undefined));
    started.resolve(undefined);
    await closed.promise;
    providerStopped.resolve(undefined);
    return;
  }
  writeOpenAiResponsesText(response, {
    text: "UNEXPECTED_MODEL_DISPATCH",
    messageId: `rejected_registration_${providerRequests.length}`,
    responseId: `rejected_registration_response_${providerRequests.length}`,
  });
}

it("keeps a live Gateway run discoverable after replacement registration is rejected", async () => {
  const firstModelStarted = createDeferred();
  const providerStopped = createDeferred();
  const providerRequests: string[] = [];
  const rejectedRegistrations: string[] = [];
  const model = await startOpenAiResponsesModelServer({
    modelId: "stop-proof",
    bindError: "Expected rejected-registration model server address",
    onRequest: async (request, response) =>
      onModelRequest(
        request,
        response,
        await readRequestText(request),
        firstModelStarted,
        providerStopped,
        providerRequests,
      ),
  });
  const fixture = await createSubagentStopFixture(
    "embedded-run-rejected-registration",
    `${model.baseUrl}/v1`,
  );
  let gateway: Gateway | undefined;
  try {
    gateway = await fixture.start();
    await gateway.server.startupSettled;

    await expect(
      gateway.client.request("agent", {
        sessionKey,
        message: firstPrompt,
        idempotencyKey: firstRunId,
        deliver: false,
      }),
    ).resolves.toMatchObject({ runId: firstRunId, status: "accepted" });
    await firstModelStarted.promise;

    const originalOwner = resolveActiveEmbeddedRunOwnerByRunId(firstRunId);
    expect(originalOwner).toMatchObject({ runId: firstRunId, sessionKey });
    const originalHandle = originalOwner && getActiveNativeAttempt(originalOwner.sessionId);
    if (!originalHandle || originalHandle.runId !== firstRunId) {
      throw new Error("The held predecessor was not the active native run");
    }
    const originalAttachment = getEmbeddedRunAttachment(originalHandle);
    const operation = originalAttachment?.operation;
    if (!originalAttachment || !operation) {
      throw new Error("The Gateway run did not retain its session controller operation");
    }

    const replacement = createEmbeddedRunHandle({ runId: rejectedRunId });
    await expect(
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey,
          embeddedRunToolAuthorityBinding: ({ handle }) => {
            rejectedRegistrations.push(handle.runId ?? "");
            return {
              source: "reply",
              operation,
              acceptsRequesterOrigin: () => false,
              project: () => undefined,
              projectAsync: async () => undefined,
              assertRegistrationActive: () => {
                throw new Error(registrationRejected);
              },
              assertActive: () => {},
            };
          },
        },
        () =>
          attachActiveEmbeddedRun(
            originalOwner.sessionId,
            replacement,
            sessionKey,
            undefined,
            "main",
            operation,
          ),
      ),
    ).rejects.toThrow(registrationRejected);

    expect(rejectedRegistrations).toEqual([rejectedRunId]);
    expect(resolveActiveEmbeddedRunOwnerByRunId(firstRunId)).toMatchObject({
      runId: firstRunId,
      sessionId: originalOwner?.sessionId,
    });
    expect(getActiveNativeAttempt(originalOwner!.sessionId)).toBe(originalHandle);
    expect(getEmbeddedRunAttachment(originalHandle)).toBe(originalAttachment);
    expect(getEmbeddedRunAttachment(replacement)).toBeUndefined();

    await expect(
      gateway.client.request("chat.abort", { sessionKey, runId: firstRunId }),
    ).resolves.toMatchObject({ aborted: true, runIds: [firstRunId] });
    await providerStopped.promise;
    await expect(
      gateway.client.request("agent.wait", { runId: firstRunId, timeoutMs: 30_000 }),
    ).resolves.toMatchObject({ status: "error", stopReason: "rpc" });
    expect(resolveActiveEmbeddedRunOwnerByRunId(firstRunId)).toBeUndefined();
    expect(providerRequests.filter((body) => body.includes(firstPrompt))).toHaveLength(1);
  } finally {
    if (gateway) {
      await gateway.client
        .request("chat.abort", { sessionKey, runId: firstRunId })
        .catch(() => undefined);
      await disconnectGatewayClient(gateway.client).catch(() => undefined);
      await gateway.server.close({ reason: "rejected registration proof complete" });
    }
    await fixture.state.cleanup();
    await model.close();
  }
}, 90_000);
