import { expectDefined } from "@openclaw/normalization-core";
import { expect, test } from "vitest";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { SessionsListResult } from "./session-utils.types.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
  sessionStoreEntry,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

const reasoningModel = (provider: string, id: string, efforts: string[]) => ({
  provider,
  id,
  name: id,
  reasoning: true,
  compat: { supportedReasoningEfforts: efforts },
});

async function listMainSessionWithThinking(
  primaryModel: string,
  entry: Parameters<typeof sessionStoreEntry>[1],
  readPreparedGatewayModelCatalog: GatewayRequestContext["readPreparedGatewayModelCatalog"],
) {
  await createSessionStoreDir();
  testState.agentConfig = {
    model: { primary: primaryModel },
    models: { [primaryModel]: { agentRuntime: { id: "codex" } } },
  };
  await writeSessionStore({
    entries: { main: sessionStoreEntry("sess-main", entry) },
  });

  return await listMainSession({ context: { readPreparedGatewayModelCatalog } });
}

async function listMainSession(
  options: Parameters<typeof directSessionReq<SessionsListResult>>[2],
) {
  const result = await directSessionReq<SessionsListResult>("sessions.list", {}, options);
  expect(result.ok, result.error?.message).toBe(true);
  return expectDefined(
    result.payload?.sessions?.find((s) => s.key === "agent:main:main"),
    "main session",
  );
}

test("active Codex sessions patch and list catalog-advertised Ultra", async () => {
  const loadSolCatalog = async () => [
    reasoningModel("openai", "gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"]),
  ];
  const session = await listMainSessionWithThinking(
    "openai/gpt-5.6-sol",
    { modelProvider: "openai", model: "gpt-5.6" },
    async () => ({ entries: await loadSolCatalog() }),
  );

  expect(session).toMatchObject({
    modelProvider: "openai",
    model: "gpt-5.6-sol",
    agentRuntime: { id: "codex" },
    thinkingOptions: expect.arrayContaining(["max", "ultra"]),
  });

  const patchResponse = await directSessionReq(
    "sessions.patch",
    { key: "main", thinkingLevel: "ultra" },
    { context: { loadGatewayModelCatalog: loadSolCatalog } },
  );
  expect(patchResponse.ok, patchResponse.error?.message).toBe(true);
  expect(patchResponse.error).toBeUndefined();
  expect(patchResponse.payload).toMatchObject({
    ok: true,
    resolved: {
      modelProvider: "openai",
      model: "gpt-5.6-sol",
      thinkingLevel: "ultra",
    },
  });

  const listedSession = await listMainSession({
    context: { loadGatewayModelCatalog: loadSolCatalog },
  });
  expect(listedSession).toMatchObject({
    modelProvider: "openai",
    model: "gpt-5.6-sol",
    thinkingLevel: "ultra",
    thinkingOptions: expect.arrayContaining(["ultra"]),
  });
});

test("generic models retain stored Ultra as a native harness mode", async () => {
  const session = await listMainSessionWithThinking(
    "test-generic/reasoner",
    {
      modelProvider: "test-generic",
      model: "reasoner",
      providerOverride: "test-generic",
      modelOverride: "reasoner",
      thinkingLevel: "ultra",
    },
    async () => ({
      entries: [reasoningModel("test-generic", "reasoner", ["max"])],
    }),
  );

  expect(session).toMatchObject({
    thinkingOptions: expect.arrayContaining(["ultra"]),
    thinkingLevel: "ultra",
  });
});
