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
import { createChatRunState } from "../server-chat-state.js";
import { prepareAgentContentPhase } from "./agent-content-phase.js";
import type { AgentTurnContext } from "./types.js";

const SYNTHETIC_PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let state: OpenClawTestState | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await state?.cleanup();
});

it.each([
  { name: "main", agentId: "main", replaceDuringRead: false, targetAccepted: true },
  { name: "work", agentId: "work", replaceDuringRead: false, targetAccepted: true },
  { name: "replacement work", agentId: "work", replaceDuringRead: true, targetAccepted: true },
  { name: "declined work", agentId: "work", replaceDuringRead: false, targetAccepted: false },
])(
  "resolves image admission using the explicit $name global session owner",
  async ({ agentId, replaceDuringRead, targetAccepted }) => {
    state = await createOpenClawTestState({ label: "agent-content-owner" });
    const { stateDir, workspaceDir } = state;
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          main: { model: "mock-openai/main-vision" },
          work: { model: "mock-openai/work-vision" },
        },
        defaults: { workspace: state.workspaceDir },
      },
      plugins: { enabled: false },
      session: { scope: "global" },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    if (replaceDuringRead) {
      const scope = { agentId, sessionKey: "global", env: state.env };
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
    const loadGatewayModelCatalogSnapshot = vi.fn<
      AgentTurnContext["loadGatewayModelCatalogSnapshot"]
    >(async (params) => ({
      agentId: params?.agentId ?? agentId,
      agentDir: stateDir,
      workspaceDir,
      catalogComplete: true,
      config: cfg,
      entries: [
        {
          id: "text-only",
          name: "Synthetic text model",
          provider: "mock-openai",
          input: ["text"],
        } satisfies ModelCatalogEntry,
        {
          id: `${params?.agentId}-vision`,
          name: "Synthetic vision model",
          provider: "mock-openai",
          input: ["text", "image"],
        } satisfies ModelCatalogEntry,
      ],
      routeVariants: [],
    }));
    const context: AgentTurnContext = {
      addChatRun: vi.fn(),
      agentRunSeq: new Map(),
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),

      chatRunState: createChatRunState(),
      dedupe: new Map(),
      deps: {},
      getRuntimeConfig: () => cfg,
      trackExecution: async (work) => await work(),
      getSessionEventSubscriberConnIds: () => new Set(),
      loadGatewayModelCatalog: vi.fn(async () => []),
      loadGatewayModelCatalogSnapshot,
      logGateway: createSubsystemLogger("test/agent-content"),
      nodeSendToSession: vi.fn(),
      removeChatRun: vi.fn(() => undefined),
    };
    const respond = vi.fn();
    const targetEntered = createDeferred();
    const targetResolution = createDeferred<boolean>();
    const onTargetResolved = vi.fn(async () => {
      targetEntered.resolve();
      return await targetResolution.promise;
    });
    const preparation = prepareAgentContentPhase({
      request: {
        message: "Inspect this synthetic pixel",
        agentId,
        sessionKey: "global",
        idempotencyKey: `image-${agentId}`,
      },
      cfg,
      context,
      respond,
      isRawModelRun: false,
      requestedSessionKeyRaw: "global",
      requestedSessionKey: "global",
      agentId,
      knownAgents: ["main", "work"],
      onTargetResolved,
      normalizedAttachments: [
        {
          type: "file",
          mimeType: "image/png",
          fileName: "pixel.png",
          content: SYNTHETIC_PIXEL,
        },
      ],
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

const modelSelectionCases: Array<{
  name: string;
  primary: string;
  requestedSessionKey?: string;
  persistedModel?: string;
  modelOverride?: string;
  offload: boolean;
}> = [
  {
    name: "configured text primary without a session target",
    primary: "text-only",
    offload: true,
  },
  {
    name: "stored text override for a keyless request's resolved session",
    primary: "main-vision",
    requestedSessionKey: "agent:main:main",
    persistedModel: "text-only",
    offload: true,
  },
  {
    name: "qualified text override over a vision primary",
    primary: "main-vision",
    modelOverride: "mock-openai/text-only",
    offload: true,
  },
  {
    name: "qualified vision override over a text primary",
    primary: "text-only",
    modelOverride: "mock-openai/main-vision",
    offload: false,
  },
];

it.each(modelSelectionCases)(
  "prepares image input for the $name",
  async ({ primary, requestedSessionKey, persistedModel, modelOverride, offload }) => {
    const testState = await createOpenClawTestState({ label: "agent-content-offload" });
    state = testState;
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { main: { model: `mock-openai/${primary}` } },
        defaults: { workspace: testState.workspaceDir },
      },
      plugins: { enabled: false },
    };
    await testState.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    if (requestedSessionKey && persistedModel) {
      await replaceSessionEntry(
        { agentId: "main", sessionKey: requestedSessionKey, env: testState.env },
        {
          sessionId: "selected-session",
          updatedAt: 1,
          providerOverride: "mock-openai",
          modelOverride: persistedModel,
        },
      );
    }
    const context: AgentTurnContext = {
      addChatRun: vi.fn(),
      agentRunSeq: new Map(),
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      chatRunState: createChatRunState(),
      dedupe: new Map(),
      deps: {},
      getRuntimeConfig: () => cfg,
      trackExecution: async (work) => await work(),
      getSessionEventSubscriberConnIds: () => new Set(),
      loadGatewayModelCatalog: vi.fn(async () => []),
      loadGatewayModelCatalogSnapshot: vi.fn(async () => ({
        agentId: "main",
        agentDir: testState.stateDir,
        workspaceDir: testState.workspaceDir,
        catalogComplete: true,
        config: cfg,
        entries: [
          {
            id: "text-only",
            name: "Synthetic text model",
            provider: "mock-openai",
            input: ["text"],
          } satisfies ModelCatalogEntry,
          {
            id: "main-vision",
            name: "Synthetic vision model",
            provider: "mock-openai",
            input: ["text", "image"],
          } satisfies ModelCatalogEntry,
        ],
        routeVariants: [],
      })),
      logGateway: createSubsystemLogger("test/agent-content"),
      nodeSendToSession: vi.fn(),
      removeChatRun: vi.fn(() => undefined),
    };
    const respond = vi.fn();
    const result = await prepareAgentContentPhase({
      request: {
        message: "Inspect this synthetic pixel",
        agentId: "main",
        model: modelOverride,
        idempotencyKey: "image-offload",
      },
      cfg,
      context,
      respond,
      isRawModelRun: false,
      requestedSessionKey,
      modelOverride,
      agentId: "main",
      knownAgents: ["main"],
      normalizedAttachments: [
        {
          type: "file",
          mimeType: "image/png",
          fileName: "pixel.png",
          content: SYNTHETIC_PIXEL,
        },
      ],
    });
    expect(respond).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      agentId: "main",
      effectiveTranscriptInputText: "Inspect this synthetic pixel",
      requestedSessionKey,
    });
    if (offload) {
      expect(result).toMatchObject({
        needsImageUnderstanding: true,
        images: [],
        imageOrder: ["offloaded"],
        media: [expect.objectContaining({ contentType: "image/png" })],
        offloadedRefs: [expect.objectContaining({ mimeType: "image/png" })],
      });
    } else {
      expect(result).toMatchObject({
        images: [expect.objectContaining({ mimeType: "image/png", data: SYNTHETIC_PIXEL })],
        imageOrder: ["inline"],
        media: [],
        offloadedRefs: [],
      });
      expect(result).not.toMatchObject({ needsImageUnderstanding: true });
    }
  },
);
