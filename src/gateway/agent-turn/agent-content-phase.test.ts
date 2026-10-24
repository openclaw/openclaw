import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as sessionEntryReads from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { prepareAgentContentPhase } from "./agent-content-phase.js";
import type { AgentTurnContext } from "./types.js";

const SYNTHETIC_PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let state: OpenClawTestState | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await state?.cleanup();
});

async function contentFixture(agentId: string, primary = "main-vision", global = false) {
  const testState = await createOpenClawTestState({
    label: global ? "agent-content-owner" : "agent-content-offload",
  });
  state = testState;
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: global
        ? { main: { model: "mock-openai/main-vision" }, work: { model: "mock-openai/work-vision" } }
        : { main: { model: `mock-openai/${primary}` } },
      defaults: { workspace: testState.workspaceDir },
    },
    plugins: { enabled: false },
    ...(global ? { session: { scope: "global" as const } } : {}),
  };
  await testState.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  const loadGatewayModelCatalogSnapshot = vi.fn<
    AgentTurnContext["loadGatewayModelCatalogSnapshot"]
  >(async (params) => ({
    agentId: global ? (params?.agentId ?? agentId) : agentId,
    agentDir: testState.stateDir,
    workspaceDir: testState.workspaceDir,
    catalogComplete: true,
    config: cfg,
    entries: [
      { id: "text-only", name: "Synthetic text model", provider: "mock-openai", input: ["text"] },
      {
        id: `${global ? params?.agentId : agentId}-vision`,
        name: "Synthetic vision model",
        provider: "mock-openai",
        input: ["text", "image"],
      },
    ] satisfies ModelCatalogEntry[],
    routeVariants: [],
  }));
  const context = createDirectChatContext({
    deps: {},
    getRuntimeConfig: () => cfg,
    trackExecution: async (work) => await work(),
    loadGatewayModelCatalog: vi.fn(async () => []),
    loadGatewayModelCatalogSnapshot,
    logGateway: createSubsystemLogger("test/agent-content"),
    removeChatRun: vi.fn(() => undefined),
  });
  return {
    testState,
    cfg,
    context,
    respond: vi.fn(),
    isRawModelRun: false,
    agentId,
    normalizedAttachments: [
      { type: "file", mimeType: "image/png", fileName: "pixel.png", content: SYNTHETIC_PIXEL },
    ],
  };
}

it.each([
  { name: "main", agentId: "main", replaceDuringRead: false, targetAccepted: true },
  { name: "work", agentId: "work", replaceDuringRead: false, targetAccepted: true },
  { name: "replacement work", agentId: "work", replaceDuringRead: true, targetAccepted: true },
  { name: "declined work", agentId: "work", replaceDuringRead: false, targetAccepted: false },
])(
  "resolves image admission using the explicit $name global session owner",
  async ({ agentId, replaceDuringRead, targetAccepted }) => {
    const fixture = await contentFixture(agentId, "main-vision", true);
    if (replaceDuringRead) {
      const scope = { agentId, sessionKey: "global", env: fixture.testState.env };
      await replaceSessionEntry(scope, {
        sessionId: "previous-text-session",
        lifecycleRevision: "previous-lifecycle",
        updatedAt: 1,
        providerOverride: "mock-openai",
        modelOverride: "text-only",
      });
      const read = sessionEntryReads.withSessionEntryReadOnlyInWorker;
      vi.spyOn(sessionEntryReads, "withSessionEntryReadOnlyInWorker").mockImplementationOnce(
        async (...args) => {
          await replaceSessionEntry(scope, {
            sessionId: "replacement-vision-session",
            lifecycleRevision: "replacement-lifecycle",
            updatedAt: 2,
            providerOverride: "mock-openai",
            modelOverride: `${agentId}-vision`,
          });
          return await read(...args);
        },
      );
    }
    const {
      respond,
      context: { loadGatewayModelCatalogSnapshot },
    } = fixture;
    const targetEntered = createDeferred();
    const targetResolution = createDeferred<boolean>();
    const onTargetResolved = vi.fn(async () => {
      targetEntered.resolve();
      return await targetResolution.promise;
    });
    const preparation = prepareAgentContentPhase({
      ...fixture,
      request: {
        message: "Inspect this synthetic pixel",
        agentId,
        sessionKey: "global",
        idempotencyKey: `image-${agentId}`,
      },
      requestedSessionKeyRaw: "global",
      requestedSessionKey: "global",
      knownAgents: ["main", "work"],
      onTargetResolved,
    });
    await targetEntered.promise;
    try {
      expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
    } finally {
      targetResolution.resolve(targetAccepted);
    }
    const result = await preparation;
    expect(onTargetResolved).toHaveBeenCalledExactlyOnceWith({ sessionKey: "global", agentId });
    expect(respond).not.toHaveBeenCalled();
    if (!targetAccepted) {
      expect(result).toBeUndefined();
      expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
      return;
    }
    expect(result).toMatchObject({
      agentId,
      requestedSessionKey: "global",
      images: [expect.objectContaining({ mimeType: "image/png" })],
    });
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledExactlyOnceWith({
      agentId,
      readOnly: true,
    });
  },
);

it.each<[string, string, boolean, { persistedModel?: string; modelOverride?: string }]>([
  ["text primary without a session", "text-only", true, {}],
  ["stored text override", "main-vision", true, { persistedModel: "text-only" }],
  ["explicit text override", "main-vision", true, { modelOverride: "mock-openai/text-only" }],
  ["explicit vision override", "text-only", false, { modelOverride: "mock-openai/main-vision" }],
])(
  "prepares image input for %s",
  async (_name, primary, offload, { persistedModel, modelOverride }) => {
    const fixture = await contentFixture("main", primary);
    const requestedSessionKey = persistedModel ? "agent:main:main" : undefined;
    if (requestedSessionKey && persistedModel) {
      await replaceSessionEntry(
        { agentId: "main", sessionKey: requestedSessionKey, env: fixture.testState.env },
        {
          sessionId: "selected-session",
          updatedAt: 1,
          providerOverride: "mock-openai",
          modelOverride: persistedModel,
        },
      );
    }
    const result = await prepareAgentContentPhase({
      ...fixture,
      request: {
        message: "Inspect this synthetic pixel",
        agentId: "main",
        model: modelOverride,
        idempotencyKey: "image-offload",
      },
      requestedSessionKey,
      modelOverride,
      knownAgents: ["main"],
    });
    expect(fixture.respond).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      agentId: "main",
      effectiveTranscriptInputText: "Inspect this synthetic pixel",
      requestedSessionKey,
      ...(offload
        ? {
            needsImageUnderstanding: true,
            images: [],
            imageOrder: ["offloaded"],
            media: [expect.objectContaining({ contentType: "image/png" })],
            offloadedRefs: [expect.objectContaining({ mimeType: "image/png" })],
          }
        : {
            images: [expect.objectContaining({ mimeType: "image/png", data: SYNTHETIC_PIXEL })],
            imageOrder: ["inline"],
            media: [],
            offloadedRefs: [],
          }),
    });
    if (!offload) {
      expect(result).not.toMatchObject({ needsImageUnderstanding: true });
    }
  },
);
