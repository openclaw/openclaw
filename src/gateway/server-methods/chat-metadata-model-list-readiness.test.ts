import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleChatMetadataRequest } from "./chat-metadata-handler.js";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";
import * as modelLists from "./models-list-result.js";
import type { RespondFn } from "./types.js";

it("serves commands independently of another agent's remembered model list", async ({ signal }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = {
      agents: {
        entries: { main: {}, other: {} },
        defaults: { model: "test/main-model", modelPolicy: { allow: ["test/*"] } },
      },
    };
    const pluginRegistry = createEmptyPluginRegistry();
    const owner = (id: string) => ({
      ...createChatMetadataOwner(config, id, {}, "test", "openai-completions"),
      pluginRegistry,
    });
    const mainOwner = owner("main-model");
    let otherOwner = owner("other-model");
    const harness = createChatMetadataHarness(config);
    harness.setOwner(mainOwner);
    harness.getPreparedOwner.mockImplementation((params) =>
      params?.agentId === "other" ? otherOwner : mainOwner,
    );
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
        commands: [{ name: "command-1-1" }],
        swarmEnabled: true,
        revision: expect.any(String),
      });
    };
    const request = {
      agentId: "other",
      params: { agentId: "other", view: "all" as const },
      includeManualSelection: true,
    };
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const abort = () => release.resolve();
    signal.addEventListener("abort", abort, { once: true });
    let blockOther = false;
    const prepare = modelLists.prepareModelsListResult;
    const preparation = vi
      .spyOn(modelLists, "prepareModelsListResult")
      .mockImplementation(async (params) => {
        if (blockOther && params.agentId === "other") {
          entered.resolve();
          await release.promise;
        }
        return prepare(params);
      });
    const pending: Promise<unknown>[] = [];
    try {
      await harness.runtime.refresh();
      await expect(harness.runtime.readModelsList(request)).resolves.toMatchObject({
        models: expect.arrayContaining([expect.objectContaining({ id: "other-model" })]),
      });
      await readCommands();
      otherOwner = owner("replacement-model");
      blockOther = true;
      const refresh = harness.runtime.refresh();
      const models = harness.runtime.readModelsList(request);
      pending.push(refresh, models);
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
      release.resolve();
      await Promise.allSettled(pending);
      preparation.mockRestore();
      signal.removeEventListener("abort", abort);
      await harness.runtime.stop();
    }
  });
});
