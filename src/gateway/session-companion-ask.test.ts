import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { prepareCliRunModelAuthority } from "../agents/cli-runner/run-admission.js";
import type { RunCliAgentParams } from "../agents/cli-runner/types.js";
import { resolveBundledStaticCatalogModel } from "../agents/embedded-agent-runner/model.static-catalog.js";
import type { RunEmbeddedAgentInternalParams } from "../agents/embedded-agent-runner/run/internal-params.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../agents/harness/tool-surface-bridge.js";
import { ProviderAuthError } from "../agents/model-auth-runtime-shared.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { createStubTool } from "../agents/test-helpers/agent-tool-stubs.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { sessionCompanionHandlers } from "./session-companion-rpc.js";
import { createSessionCompanion } from "./session-companion.js";

const runEmbeddedAgent = vi.hoisted(() =>
  vi.fn<
    (params: RunEmbeddedAgentInternalParams) => Promise<{
      meta: { durationMs: number; finalAssistantVisibleText: string };
    }>
  >(),
);

const resolveModelAsync = vi.hoisted(() => vi.fn());
const resolveApiKeyForProviderCore = vi.hoisted(() => vi.fn());
const resolveSelection = vi.hoisted(() =>
  vi.fn(() => ({ provider: "test", modelId: "model-a" }) as { provider: string; modelId: string }),
);
const { prepareCliRunContext, executePreparedCliRun } = vi.hoisted(() => ({
  prepareCliRunContext: vi.fn(async (params: RunCliAgentParams) => ({
    params,
    preparedBackend: {},
  })),
  executePreparedCliRun: vi.fn(async () => ({ text: "The session is fixing a bug." })),
}));

const { appendMessage, admitWrite, loadEntry, removeSession } = vi.hoisted(() => ({
  appendMessage: vi.fn<(message: unknown) => void>(),
  admitWrite: vi.fn<(manager: unknown, write: () => void) => Promise<void>>(),
  loadEntry: vi.fn<() => { entry: InternalSessionEntry } | undefined>(),
  removeSession:
    vi.fn<
      (
        target: unknown,
        expectedOwner?: Pick<InternalSessionEntry, "lifecycleRevision" | "activeWriterRunId">,
      ) => Promise<void>
    >(),
}));

const preparedTarget = {
  agentId: "main",
  sessionId: "companion-run",
  sessionKey: "agent:main:internal:companion-run",
  storePath: "/synthetic/companion/openclaw-agent.sqlite",
  sessionEntry: {
    sessionId: "companion-run",
    updatedAt: 0,
    lifecycleRevision: "companion-lifecycle",
    activeWriterRunId: undefined,
  },
};

vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));
vi.mock("../agents/embedded-agent-runner/model.js", () => ({ resolveModelAsync }));
vi.mock("../agents/sessions/session-manager-write-admission.js", () => ({
  withSessionManagerWrite: admitWrite,
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  loadExactSessionEntry: loadEntry,
  loadExactSessionEntryCandidates: () => [],
}));
vi.mock("../agents/internal-session-effects.js", () => ({
  prepareInternalSessionEffectsSession: async () => preparedTarget,
  removeInternalSessionEffectsSession: removeSession,
}));
vi.mock("../agents/sessions/index.js", () => ({
  SessionManager: {
    openAsync: async () => ({ appendMessage, getSessionTarget: () => preparedTarget }),
  },
}));
vi.mock("../agents/simple-completion-runtime.js", () => ({
  resolveSimpleCompletionSelectionForAgent: resolveSelection,
}));
vi.mock("../agents/cli-runner/prepare.runtime.js", () => ({ prepareCliRunContext }));
vi.mock("../agents/cli-runner/execute.runtime.js", () => ({ executePreparedCliRun }));
vi.mock("../agents/model-auth-provider.js", () => ({ resolveApiKeyForProviderCore }));

function createCompanion(cfg: OpenClawConfig = {}) {
  return createSessionCompanion({
    scheduler: createTestGatewayScheduler(),
    getConfig: () => cfg,
    contextReader: {
      currentSessionId: () => "session-1",
      read: async () => ({
        kind: "ready",
        context: { empty: true, messages: [], sessionId: "session-1" },
      }),
    },
    sessionObserver: { getCompanionSnapshot: () => ({ agentId: "main", notes: [] }) },
    resolveUtilityModelRef: () => "test/model-a",
  });
}

const imageBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=";

const question = {
  agentId: "main",
  sessionKey: "agent:main:main",
  question: "What is it doing?",
  connId: "conn-1",
};

describe("session companion embedded invocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveApiKeyForProviderCore
      .mockReset()
      .mockRejectedValue(
        new ProviderAuthError("missing-provider-auth", "anthropic", "No API key found"),
      );
    resolveModelAsync.mockReset().mockResolvedValue({ model: { input: ["text", "image"] } });
    appendMessage.mockReset();
    admitWrite.mockReset().mockImplementation(async (_manager, write) => write());
    loadEntry.mockReturnValue({ entry: { ...preparedTarget.sessionEntry } });
    removeSession.mockResolvedValue(undefined);
    runEmbeddedAgent.mockReset().mockResolvedValue({
      meta: { durationMs: 1, finalAssistantVisibleText: "The session is reading a file." },
    });
  });

  it.each([0, 2_000_001])(
    "delivers an image with %i padding bytes from the registered RPC to the read-only model run",
    async (padding) => {
      const companion = createCompanion();
      const respond = vi.fn();
      const data = Buffer.concat([
        Buffer.from(imageBase64, "base64"),
        Buffer.alloc(padding),
      ]).toString("base64");
      try {
        await sessionCompanionHandlers["sessions.companion.ask"]!({
          params: {
            sessionKey: question.sessionKey,
            question: "What does this show?",
            attachments: [{ mimeType: "image/png", fileName: "proof.png", content: data }],
          },
          client: { connId: "image-connection" },
          context: { sessionCompanion: companion, getRuntimeConfig: () => ({}) },
          respond,
        } as never);
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ answer: expect.any(String) }),
        );
        expect(runEmbeddedAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: "What does this show?",
            images: [expect.objectContaining({ type: "image", mimeType: "image/png", data })],
            disableMessageTool: true,
            requireWorkspaceOnly: true,
            toolsAllow: ["read", "sessions_history", "sessions_search"],
          }),
        );
      } finally {
        companion.dispose();
      }
    },
  );

  it.each(["catalog-only", "dynamic-discovery"])(
    "uses the already prepared image model for %s without an extra resolution",
    async (route) => {
      const model = resolveBundledStaticCatalogModel({
        provider: "mistral",
        modelId: "mistral-medium-3-5",
        cfg: { plugins: { entries: { mistral: { enabled: true } } } },
        includeRuntimeDiscovery: true,
      });
      expect(model?.input).toContain("image");
      if (!model) {
        throw new Error("Expected the real bundled Mistral catalog row");
      }
      if (route === "catalog-only") {
        resolveModelAsync.mockResolvedValue({ error: "Unknown model without bundled fallback" });
      } else {
        resolveModelAsync.mockRejectedValue(new Error("Unexpected additional dynamic discovery"));
      }
      const modelIo = vi.fn();
      runEmbeddedAgent.mockImplementationOnce(async (params) => {
        params.assertModelInput?.(model);
        modelIo();
        return { meta: { durationMs: 1, finalAssistantVisibleText: "The image is visible." } };
      });
      const companion = createCompanion();
      const respond = vi.fn();
      try {
        await sessionCompanionHandlers["sessions.companion.ask"]!({
          params: {
            sessionKey: question.sessionKey,
            question: "What does this show?",
            attachments: [{ mimeType: "image/png", content: imageBase64 }],
          },
          client: { connId: "catalog-image-connection" },
          context: { sessionCompanion: companion, getRuntimeConfig: () => ({}) },
          respond,
        } as never);
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ answer: "The image is visible." }),
        );
        expect(modelIo).toHaveBeenCalledOnce();
        expect(resolveModelAsync).not.toHaveBeenCalled();
      } finally {
        companion.dispose();
      }
    },
  );

  it("rejects an image before model I/O when the selected Side chat model is text-only", async () => {
    const modelIo = vi.fn();
    runEmbeddedAgent.mockImplementationOnce(async (params) => {
      params.assertModelInput?.({ input: ["text"] });
      modelIo();
      return {
        meta: { durationMs: 1, finalAssistantVisibleText: "Must not answer an unseen image." },
      };
    });
    const companion = createCompanion();
    const respond = vi.fn();
    try {
      await sessionCompanionHandlers["sessions.companion.ask"]!({
        params: {
          sessionKey: question.sessionKey,
          question: "What does this show?",
          attachments: [{ mimeType: "image/png", content: imageBase64 }],
        },
        client: { connId: "image-connection" },
        context: { sessionCompanion: companion, getRuntimeConfig: () => ({}) },
        respond,
      } as never);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringContaining("does not support image input"),
          details: { reason: "image-input-unsupported" },
          retryable: false,
        }),
      );
      expect(modelIo).not.toHaveBeenCalled();
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      expect(resolveModelAsync).not.toHaveBeenCalled();
      await expect(companion.ask(question)).resolves.toMatchObject({ answer: expect.any(String) });
      expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
      expect(runEmbeddedAgent.mock.calls[1]?.[0].assertModelInput).toBeUndefined();
      expect(resolveModelAsync).not.toHaveBeenCalled();
    } finally {
      companion.dispose();
    }
  });

  it("keeps read-only tools direct when the selected agent model opts into Code Mode", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: "/tmp/companion-test",
          models: { "test/model-a": { codeMode: true } },
        },
        entries: {
          main: {
            models: { "test/model-a": { codeMode: true } },
            tools: { codeMode: true },
          },
        },
      },
      tools: { toolSearch: true, codeMode: { enabled: true, maxOutputBytes: 4096 } },
    };
    runEmbeddedAgent.mockResolvedValueOnce({
      meta: { durationMs: 1, finalAssistantVisibleText: "The session is reading a file." },
    });
    const companion = createCompanion(cfg);

    try {
      await expect(
        companion.ask({
          agentId: "main",
          sessionKey: "agent:main:main",
          question: "What is it doing?",
          connId: "conn-1",
        }),
      ).resolves.toMatchObject({ answer: "The session is reading a file." });
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      const invocation = runEmbeddedAgent.mock.calls[0]?.[0];
      if (!invocation) {
        throw new Error("Expected the companion embedded invocation");
      }
      expect(invocation.config?.tools?.codeMode).toEqual(cfg.tools?.codeMode);
      const surface = createAgentHarnessToolSurfaceRuntimeCore({
        config: invocation.config,
        agentId: invocation.agentId,
        modelProvider: invocation.provider,
        modelId: invocation.model,
        model: { compat: { codeMode: "preferred" } },
        codeModeOverride: invocation.codeModeOverride,
        disableToolSearch: invocation.disableToolSearch,
        toolsAllow: invocation.toolsAllow,
        modelToolsEnabled: true,
        executeTool: async () => ({ content: [], details: {} }),
      });
      try {
        const tools = ["read", "sessions_history", "sessions_search"].map(createStubTool);
        expect(surface.compactTools(tools).tools.map((tool) => tool.name)).toEqual([
          "read",
          "sessions_history",
          "sessions_search",
        ]);
      } finally {
        surface.cleanup();
      }
    } finally {
      companion.dispose();
    }
  });

  it("answers through the primary model's CLI runtime when no provider API key exists", async () => {
    // Subscription-only install: the primary runs on claude-cli and the
    // automatic utility model is derived from the same provider.
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: "/tmp/companion-test",
          model: "anthropic/claude-opus-4-6",
          models: { "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } } },
        },
      },
    };
    resolveSelection.mockReturnValueOnce({ provider: "anthropic", modelId: "claude-haiku-4-5" });
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
      ],
    });
    const companion = createCompanion(cfg);
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "companion-reader",
      scopes: ["operator.read"],
      assertCurrent: () => {},
      modelPolicy: prepareOperatorModelPolicy({
        cfg,
        policy: { sourceAgent: "main", allow: ["anthropic/claude-haiku-4-5"] },
        manifestPlugins: [],
      }),
    });
    prepareCliRunContext.mockImplementationOnce(async (params) => ({
      params: prepareCliRunModelAuthority(params),
      preparedBackend: {},
    }));
    try {
      await expect(companion.ask({ ...question, operatorAuthority })).resolves.toMatchObject({
        answer: "The session is fixing a bug.",
      });
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      expect(appendMessage).not.toHaveBeenCalled();
      expect(prepareCliRunContext).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "claude-cli",
          model: "claude-haiku-4-5",
          requesterModel: { provider: "anthropic", model: "claude-haiku-4-5" },
          executionMode: "side-question",
          disableTools: true,
          sessionKey: preparedTarget.sessionKey,
          prompt: expect.stringContaining("What is it doing?"),
          extraSystemPrompt: expect.stringContaining("read-only Side chat assistant"),
        }),
      );
      expect(executePreparedCliRun).toHaveBeenCalledOnce();
      resolveApiKeyForProviderCore.mockResolvedValue({ apiKey: "synthetic-key", mode: "api-key" });
      resolveSelection.mockReturnValueOnce({ provider: "anthropic", modelId: "claude-haiku-4-5" });
      await expect(
        companion.ask({
          ...question,
          attachments: [{ mimeType: "image/png", content: imageBase64 }],
        }),
      ).resolves.toMatchObject({ answer: "The session is reading a file." });
      expect(runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          images: [expect.objectContaining({ type: "image" })],
          toolsAllow: ["read", "sessions_history", "sessions_search"],
        }),
      );
      expect(removeSession).toHaveBeenCalledWith(preparedTarget, undefined);
    } finally {
      cliBackendsTesting.resetDepsForTest();
      companion.dispose();
    }
  });

  it("waits for admitted history persistence before starting the companion run", async () => {
    const queued = createDeferredCore();
    const resume = createDeferredCore();
    admitWrite.mockImplementationOnce(async (_manager, write) => {
      queued.resolve();
      await resume.promise;
      write();
    });
    const companion = createCompanion();
    const pending = companion.ask(question);
    try {
      await vi.waitFor(() => expect(admitWrite).toHaveBeenCalledOnce());
      await queued.promise;
      expect(appendMessage).not.toHaveBeenCalled();
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      expect(removeSession).not.toHaveBeenCalled();
      resume.resolve();
      await expect(pending).resolves.toMatchObject({ answer: "The session is reading a file." });
      expect(appendMessage).toHaveBeenCalledOnce();
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      expect(removeSession).toHaveBeenCalledWith(preparedTarget, undefined);
    } finally {
      resume.resolve();
      await pending.catch(() => undefined);
      companion.dispose();
    }
  });

  it.each([
    { name: "missing", entry: undefined },
    { name: "replaced", entry: { ...preparedTarget.sessionEntry, sessionId: "replacement" } },
    {
      name: "reset with the same id",
      entry: { ...preparedTarget.sessionEntry, lifecycleRevision: "replacement-lifecycle" },
    },
    {
      name: "claimed by another writer",
      entry: { ...preparedTarget.sessionEntry, activeWriterRunId: "replacement-writer" },
    },
  ])("does not seed a session that is $name before admission", async ({ entry }) => {
    admitWrite.mockImplementationOnce(async (_manager, write) => {
      loadEntry.mockReturnValue(entry ? { entry } : undefined);
      write();
    });
    const companion = createCompanion();
    try {
      await expect(companion.ask(question)).rejects.toThrow();
      expect(appendMessage).not.toHaveBeenCalled();
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      expect(removeSession).toHaveBeenCalledWith(preparedTarget, {
        lifecycleRevision: preparedTarget.sessionEntry.lifecycleRevision,
        activeWriterRunId: preparedTarget.sessionEntry.activeWriterRunId,
      });
    } finally {
      companion.dispose();
    }
  });

  it("settles queued seeding after cancellation without writing or starting a run", async () => {
    const queued = createDeferredCore();
    const resume = createDeferredCore();
    admitWrite.mockImplementationOnce(async (_manager, write) => {
      queued.resolve();
      await resume.promise;
      write();
    });
    const companion = createCompanion();
    const controller = new AbortController();
    const pending = companion.ask({ ...question, signal: controller.signal });
    try {
      await vi.waitFor(() => expect(admitWrite).toHaveBeenCalledOnce());
      await queued.promise;
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(removeSession).not.toHaveBeenCalled();
      resume.resolve();
      await vi.waitFor(() =>
        expect(removeSession).toHaveBeenCalledWith(preparedTarget, {
          lifecycleRevision: preparedTarget.sessionEntry.lifecycleRevision,
          activeWriterRunId: preparedTarget.sessionEntry.activeWriterRunId,
        }),
      );
      expect(appendMessage).not.toHaveBeenCalled();
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await pending.catch(() => undefined);
      companion.dispose();
    }
  });
});
