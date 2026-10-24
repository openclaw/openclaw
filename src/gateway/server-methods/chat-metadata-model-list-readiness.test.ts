import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleChatMetadataRequest } from "./chat-metadata-handler.js";
import {
  chatMetadataCommandFields,
  createOtherAgentChatMetadataFixture,
} from "./chat-metadata-runtime.test-support.js";
import type { RespondFn } from "./types.js";

it("serves commands independently of another agent's remembered model list", async ({ signal }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = createOtherAgentChatMetadataFixture(signal);
    const { config, harness, request, entered, release, pending } = fixture;
    const context = createDirectChatContext({
      getRuntimeConfig: () => config,
      readChatMetadata: harness.runtime.read,
    });
    const readCommands = async () => {
      const respond = vi.fn<RespondFn>();
      await handleChatMetadataRequest({
        req: { type: "req", id: "commands-readiness", method: "chat.metadata" },
        params: { agentId: "main", includeModels: false },
        context,
        client: null,
        respond,
        signal,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledWith(true, {
        commands: [{ ...chatMetadataCommandFields, name: "command-1-1" }],
        swarmEnabled: true,
        revision: expect.any(String),
      });
    };
    try {
      await harness.runtime.refresh();
      await expect(harness.runtime.readModelsList(request)).resolves.toMatchObject({
        models: expect.arrayContaining([expect.objectContaining({ id: "other-model" })]),
      });
      await readCommands();
      fixture.holdOtherModel("replacement-model");
      // Reads during a refresh get the retained list; hold the replacement's own preparation.
      await harness.runtime.refresh();
      const models = harness.runtime.readModelsList(request);
      pending.push(models);
      await withinTest(entered.promise, signal);
      console.info("chat-metadata-readiness", { phase: "other model list held" });
      const started = performance.now();
      const reading = readCommands();
      pending.push(reading);
      await withinTest(reading, signal);
      console.info("chat-metadata-readiness", {
        phase: "commands completed while other model list held",
        elapsedMs: performance.now() - started,
      });
      release.resolve();
      await Promise.all(pending);
      await expect(harness.runtime.readModelsList(request)).resolves.toMatchObject({
        models: expect.arrayContaining([expect.objectContaining({ id: "replacement-model" })]),
      });
    } finally {
      await fixture.stop();
    }
  });
});
