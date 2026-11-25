import { afterEach, expect, it } from "vitest";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { subscribeSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { listSubagentRunsForRequester } from "../agents/subagents/registry/subagent-registry-read.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { peekSystemEvents } from "../infra/system-events.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import {
  createSubagentModelConfig,
  findSubagentSpawnReceipt,
  type SpawnReceipt,
} from "./server.subagent-stop-settlement.product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

afterEach(() => resetSubagentRegistryForTests({ persist: false }));

it("settles silent and visible parent completions once through the real provider and registry", async () => {
  const requests: string[] = [];
  let completionReply = "NO_REPLY";
  let completionRequests = 0;
  let sequence = 0;
  let parentPrompt = "";
  let childTask = "";
  let childResult = "";
  let completionTarget: "parent" | "user" = "parent";
  let releaseChild = createDeferred();
  let childAccepted = createDeferred<SpawnReceipt>();
  const model = await startOpenAiResponsesModelServer({
    modelId: "quiet-completion",
    bindError: "Expected quiet completion model server address",
    onRequest: async (request, response) => {
      const body = await readRequestText(request);
      requests.push(body);
      const reply = (text: string) => {
        const id = `quiet_${++sequence}`;
        writeOpenAiResponsesText(response, { text, messageId: id, responseId: `${id}_response` });
      };
      if (body.includes(parentPrompt)) {
        if (body.includes(childResult)) {
          // Bound the broken base's continuation so the assertion reports duplicate work.
          reply(++completionRequests === 1 ? completionReply : "Unexpected extra completion turn.");
        } else if (!body.includes("function_call_output")) {
          writeToolCall(response, "sessions_spawn", {
            task: childTask,
            context: "isolated",
            ...(completionTarget === "parent" ? { completionTarget } : {}),
            cleanup: "keep",
          });
        } else {
          const receipt = findSubagentSpawnReceipt(JSON.parse(body) as unknown);
          if (receipt) {
            childAccepted.resolve(receipt);
          }
          reply("Child accepted.");
        }
      } else {
        await releaseChild.promise;
        reply(childResult);
      }
    },
  });
  const state = await createOpenClawTestState({ label: "quiet-subagent-completion" });
  const gateway = await startGatewayWithClient({
    cfg: createSubagentModelConfig(state.workspaceDir, {
      baseUrl: `${model.baseUrl}/v1`,
      modelId: "quiet-completion",
      runtime: true,
    }),
    configPath: state.configPath,
    token: "quiet-completion-token",
  });
  try {
    await gateway.server.startupSettled;
    for (const target of ["parent", "user"] as const) {
      for (const text of ["NO_REPLY", "", "The child result is ready."]) {
        completionTarget = target;
        completionReply = text;
        completionRequests = 0;
        const key = `quiet_${target}_${sequence}`;
        const sessionKey = `agent:main:${key}`;
        parentPrompt = `Spawn research for ${key}.`;
        childTask = `Return research for ${key}.`;
        childResult = `CHILD_RESULT_${key}`;
        releaseChild = createDeferred();
        childAccepted = createDeferred<SpawnReceipt>();
        const parent = gateway.client.request(
          "agent",
          {
            sessionKey,
            message: parentPrompt,
            idempotencyKey: key,
            deliver: false,
          },
          { expectFinal: true },
        );
        const child = await childAccepted.promise;
        await parent;
        const delivered = createDeferred();
        const observe = () => {
          if (listSubagentRunsForRequester(sessionKey)[0]?.delivery?.status === "delivered") {
            delivered.resolve();
          }
        };
        const stop = subscribeSubagentRunChanges("persistence", observe);
        try {
          releaseChild.resolve();
          observe();
          await delivered.promise;
          expect(listSubagentRunsForRequester(sessionKey)).toEqual([
            expect.objectContaining({
              runId: child.runId,
              delivery: expect.objectContaining({ status: "delivered" }),
            }),
          ]);
        } finally {
          stop();
        }
        expect(completionRequests, `${target} completion ${JSON.stringify(text)}`).toBe(1);
        expect(peekSystemEvents(sessionKey).join("\n")).not.toContain("delivery is blocked");
        const history = await gateway.client.request("chat.history", { sessionKey });
        expect(JSON.stringify(history)).not.toContain("delivery is blocked");
        const childHistory = await gateway.client.request("chat.history", {
          sessionKey: child.childSessionKey,
        });
        expect(JSON.stringify(childHistory)).toContain(childResult);
        if (target === "user" && text) {
          expect(JSON.stringify(history)).toContain(text === "NO_REPLY" ? "Child accepted." : text);
        }
      }
    }
    expect(requests.some((body) => body.includes("NO_REPLY is not allowed"))).toBe(false);
  } finally {
    releaseChild.resolve();
    await disconnectGatewayClient(gateway.client);
    await gateway.server.close({ reason: "quiet completion proof complete" });
    await model.close();
    await state.cleanup();
  }
});
