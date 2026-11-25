// Prepare the real Gateway and model path before entering the proof deadline.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { withinTest } from "../../test/helpers/promise.js";
import { createSessionGoal } from "../config/sessions/goals.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import {
  createProductState,
  productModelConfig,
  productProvider,
} from "./server.chat-product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it(
  "stops built-in Goal continuations after settled usage crosses the cap at fixed context",
  {
    timeout: 120_000,
  },
  async ({ signal }) => {
    await using cleanup = new AsyncDisposableStack();
    const state = await createProductState("goal-settled-budget");
    cleanup.defer(() => state.cleanup());
    const receivedThird = createDeferredCore();
    const errors: unknown[] = [];
    const samples: Array<number | undefined> = [];
    const objective = "Index the public-domain poems";
    const storePath = state.path("agent", "openclaw-agent.sqlite");
    const scope = { storePath, sessionKey: "" };
    const provider = productProvider(errors, (text, response) => {
      if (text.includes("conversationLabelSource")) {
        writeOpenAiResponsesText(response, {
          text: "Poem index",
          messageId: randomUUID(),
          responseId: randomUUID(),
        });
        return;
      }
      expect(text).toContain(objective);
      samples.push(loadSessionEntry(scope)?.goal?.tokensUsed);
      if (samples.length > 3) {
        // Bound the broken path without instructing the Goal to complete.
        response.writeHead(400).end("An extra turn exceeded the Goal budget");
        return;
      }
      writeOpenAiResponsesText(response, {
        text: "There are more poems to index.",
        messageId: randomUUID(),
        responseId: randomUUID(),
        usage: { input_tokens: 40_000, output_tokens: 5_000, total_tokens: 45_000 },
      });
      if (samples.length === 3) {
        receivedThird.resolve();
      }
    });
    cleanup.defer(() => closeProvider(provider));
    const model = buildMockOpenAiResponsesProvider(await listenProvider(provider), "goal-budget");
    const { defaults, models } = productModelConfig(state.workspaceDir, model);
    const gateway = await startGatewayWithClient({
      cfg: {
        agents: { defaults },
        models,
        session: { store: storePath },
        messages: { queue: { mode: "followup", debounceMsByChannel: { webchat: 0 } } },
      },
      configPath: state.configPath,
      token: "synthetic-goal-budget",
    });
    cleanup.defer(async () => {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "Goal budget proof complete" });
    });
    await gateway.server.startupSettled;
    const { key } = await gateway.client.request<{ key: string }>("sessions.create", {
      agentId: "main",
    });
    scope.sessionKey = key;
    await createSessionGoal({ ...scope, objective, tokenBudget: 100_000 });
    await gateway.client.request("chat.send", {
      sessionKey: key,
      message: objective,
      idempotencyKey: randomUUID(),
    });
    await withinTest(receivedThird.promise, signal);
    expect((await waitForGatewayActiveWork(30_000)).drained).toBe(true);
    expect(errors).toEqual([]);
    expect(samples).toEqual([0, 45_000, 90_000]);
    expect(loadSessionEntry(scope)).toMatchObject({
      totalTokens: 45_000,
      goal: { status: "budget_limited", tokensUsed: 135_000, continuationTurns: 2 },
    });
  },
);
