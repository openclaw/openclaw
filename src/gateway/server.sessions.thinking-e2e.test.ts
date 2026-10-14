import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
  getGatewayConfigModule,
  getSessionsHandlers,
  sessionStoreEntry,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

type ThinkingSession = {
  key: string;
  modelProvider?: string;
  model?: string;
  agentRuntime?: { id?: string };
  thinkingLevel?: string;
  thinkingLevels?: Array<{ label: string }>;
  thinkingOptions?: string[];
};

type SessionsListResult = {
  sessions?: ThinkingSession[];
};

async function listMainSessionWithThinking(params: {
  reqId: string;
  primaryModel: string;
  sessionModelProvider: string;
  sessionModel: string;
  agentRuntime?: "codex" | "openclaw";
  selectedByOverride?: boolean;
  thinkingLevel?: string;
  readPreparedGatewayModelCatalog?: GatewayRequestContext["readPreparedGatewayModelCatalog"];
}) {
  await createSessionStoreDir();
  testState.agentConfig = {
    model: { primary: params.primaryModel },
    ...(params.agentRuntime
      ? {
          models: {
            [params.primaryModel]: { agentRuntime: { id: params.agentRuntime } },
          },
        }
      : {}),
  };
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", {
        modelProvider: params.sessionModelProvider,
        model: params.sessionModel,
        ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
        ...(params.selectedByOverride === false
          ? {}
          : {
              providerOverride: params.sessionModelProvider,
              modelOverride: params.sessionModel,
            }),
      }),
    },
  });

  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const context = {
    getRuntimeConfig,
    readPreparedGatewayModelCatalog:
      params.readPreparedGatewayModelCatalog ?? (async () => ({ entries: [] })),
  } as GatewayRequestContext;
  await initializeSessionReadContext(context);
  await expectDefined(
    sessionsHandlers["sessions.list"],
    'sessionsHandlers["sessions.list"] test invariant',
  )({
    req: { type: "req", id: params.reqId, method: "sessions.list", params: {} },
    params: {},
    respond,
    client: null,
    isWebchatConnect: () => false,
    context,
  });

  const result = respond.mock.calls[0]?.[1] as SessionsListResult | undefined;
  return {
    session: result?.sessions?.find((s) => s.key === "agent:main:main"),
  };
}

test("active Codex sessions patch and list catalog-advertised Ultra", async () => {
  const loadSolCatalog = async () => [
    {
      provider: "openai",
      id: "gpt-5.6-sol",
      name: "GPT-5.6-Sol",
      reasoning: true,
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
    },
  ];
  const { session } = await listMainSessionWithThinking({
    reqId: "req-e2e-codex-sol-family",
    primaryModel: "openai/gpt-5.6-sol",
    sessionModelProvider: "openai",
    sessionModel: "gpt-5.6",
    agentRuntime: "codex",
    selectedByOverride: false,
    readPreparedGatewayModelCatalog: async () => ({ entries: await loadSolCatalog() }),
  });

  expect(session).toMatchObject({
    modelProvider: "openai",
    model: "gpt-5.6-sol",
  });
  expect(session?.agentRuntime?.id).toBe("codex");
  expect(session?.thinkingOptions).toContain("max");
  expect(session?.thinkingOptions).toContain("ultra");

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

  const listResponse = await directSessionReq<SessionsListResult>(
    "sessions.list",
    {},
    { context: { loadGatewayModelCatalog: loadSolCatalog } },
  );
  expect(listResponse.ok, listResponse.error?.message).toBe(true);
  const listedSession = listResponse.payload?.sessions?.find(
    (candidate) => candidate.key === "agent:main:main",
  );
  expect(listedSession).toMatchObject({
    modelProvider: "openai",
    model: "gpt-5.6-sol",
    thinkingLevel: "ultra",
  });
  expect(listedSession?.thinkingOptions).toContain("ultra");
});

test("generic models retain stored Ultra as a native harness mode", async () => {
  const { session } = await listMainSessionWithThinking({
    reqId: "req-e2e-generic-ultra",
    primaryModel: "test-generic/reasoner",
    sessionModelProvider: "test-generic",
    sessionModel: "reasoner",
    agentRuntime: "codex",
    thinkingLevel: "ultra",
    readPreparedGatewayModelCatalog: async () => ({
      entries: [
        {
          provider: "test-generic",
          id: "reasoner",
          name: "Generic Reasoner",
          reasoning: true,
          compat: { supportedReasoningEfforts: ["max"] },
        },
      ],
    }),
  });

  expect(session?.thinkingOptions).toContain("ultra");
  expect(session?.thinkingLevel).toBe("ultra");
});
