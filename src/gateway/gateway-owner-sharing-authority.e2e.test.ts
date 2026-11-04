import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import {
  expectOwnerReadiness,
  proveOwnerSharingThroughCli,
} from "./gateway-owner-sharing-authority.test-support.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { sessionKey } from "./server-methods/sessions-github-read.test-support.js";

it("carries CLI owner authority through an agent's readiness tools and persisted reply", async ({
  signal,
}) => {
  const consumed: unknown[] = [];
  const prompt =
    "Check this conversation's GitHub readiness, then explicitly select it and check again.";
  const finalText = "Both readiness reads admitted the managed workspace.";
  const model = await startOpenAiResponsesModelServer({
    modelId: "owner-sharing",
    bindError: "Expected owner sharing model fixture address",
    onRequest: async (request, response) => {
      const raw = await readRequestText(request);
      const reply = (text: string) =>
        writeOpenAiResponsesText(response, {
          text,
          messageId: randomUUID(),
          responseId: randomUUID(),
        });
      if (!raw.includes(prompt)) {
        reply("Owner sharing proof");
        return;
      }
      const body = JSON.parse(raw) as {
        input: Array<{ type?: string; output?: string }>;
      };
      const outputs = body.input.filter((item) => item.type === "function_call_output");
      if (outputs.length > 0) {
        const output = outputs.at(-1)?.output;
        assert(typeof output === "string", "the model must consume the actual tool result");
        const readiness: unknown = JSON.parse(output);
        expectOwnerReadiness(readiness);
        consumed.push(readiness);
      }
      if (outputs.length < 2) {
        writeToolCall(response, "github_publish", {
          action: "readiness",
          ...(outputs.length === 1 ? { publishingSessionKey: sessionKey } : {}),
        });
      } else {
        reply(finalText);
      }
    },
  });
  await runQaGatewayFixture(
    async () => {
      await proveOwnerSharingThroughCli({
        config: createOpenAiResponsesModelConfig({
          baseUrl: model.baseUrl,
          providerId: "owner-sharing-fixture",
          modelId: "owner-sharing",
          reasoning: false,
          toolProfile: "full",
        }),
        prompt,
        finalText,
        waitMs: 30_000,
        signal,
      });
      expect(consumed).toHaveLength(2);
    },
    () => model.close(),
  );
});
