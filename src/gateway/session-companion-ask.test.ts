import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { prepareCliRunModelAuthority } from "../agents/cli-runner/run-admission.js";
import type { RunCliAgentParams } from "../agents/cli-runner/types.js";
import { resolveBundledStaticCatalogModel } from "../agents/embedded-agent-runner/model.static-catalog.js";
import type { RunEmbeddedAgentInternalParams } from "../agents/embedded-agent-runner/run/internal-params.js";
import { FailoverError } from "../agents/failover-error.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../agents/harness/tool-surface-bridge.js";
import { ProviderAuthError } from "../agents/model-auth-runtime-shared.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { createStubTool } from "../agents/test-helpers/agent-tool-stubs.js";
import "../agents/model-fallback-runner.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as attachmentProcessor from "../media/attachment-processor.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
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
  vi.fn(
    (_params: { modelRef?: string }) =>
      ({ provider: "test", modelId: "model-a" }) as { provider: string; modelId: string },
  ),
);
const { prepareCliRunContext, executePreparedCliRun } = vi.hoisted(() => ({
  prepareCliRunContext: vi.fn(async (params: RunCliAgentParams) => ({
    params,
    preparedBackend: {},
  })),
  executePreparedCliRun: vi.fn(async () => ({ text: "The session is fixing a bug." })),
}));

const { appendMessage, admitWrite, removeSession } = vi.hoisted(() => ({
  appendMessage: vi.fn<(message: unknown) => Promise<string | undefined>>(),
  admitWrite: vi.fn<(manager: unknown, write: () => void | Promise<void>) => Promise<void>>(),
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
vi.mock("../agents/internal-session-effects.js", () => ({
  prepareInternalSessionEffectsSession: async () => preparedTarget,
  removeInternalSessionEffectsSession: removeSession,
}));
vi.mock("../agents/sessions/index.js", () => ({
  SessionManager: {
    openAsync: async () => ({
      appendMessageAsync: appendMessage,
      getSessionTarget: () => preparedTarget,
    }),
  },
}));
vi.mock("../agents/simple-completion-runtime.js", () => ({
  resolveSimpleCompletionSelectionForAgent: resolveSelection,
}));
vi.mock("../agents/cli-runner/prepare.runtime.js", () => ({ prepareCliRunContext }));
vi.mock("../agents/cli-runner/execute.runtime.js", () => ({ executePreparedCliRun }));
vi.mock("../agents/model-auth-provider.js", () => ({ resolveApiKeyForProviderCore }));

function createCompanion(
  cfg: OpenClawConfig = { agents: { defaults: { utilityModel: "test/model-a" } } },
) {
  const companion = createSessionCompanion({
    scheduler: createTestGatewayScheduler(),
    getConfig: () => cfg,
    contextReader: {
      currentSessionId: async () => "session-1",
      read: async () => ({
        kind: "ready",
        context: { empty: true, messages: [], sessionId: "session-1" },
      }),
    },
    sessionObserver: { getCompanionSnapshotAsync: async () => ({ agentId: "main", notes: [] }) },
  });
  onTestFinished(() => companion.dispose());
  return companion;
}

const imageBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=";

const completion = (text = "The session is reading a file.") => ({
  meta: { durationMs: 1, finalAssistantVisibleText: text },
});

const question = {
  agentId: "main",
  sessionKey: "agent:main:main",
  question: "What is it doing?",
  connId: "conn-1",
};

async function invokeAsk(
  companion: ReturnType<typeof createSessionCompanion>,
  params: Record<string, unknown>,
  connId: string,
  cfg: OpenClawConfig = {},
  getCommittedRuntimeConfig?: () => OpenClawConfig,
) {
  const respond = vi.fn();
  await sessionCompanionHandlers["sessions.companion.ask"]!({
    params: { sessionKey: question.sessionKey, ...params },
    client: { connId },
    context: {
      sessionCompanion: companion,
      getRuntimeConfig: () => cfg,
      getCommittedRuntimeConfig,
    },
    respond,
  } as never);
  return respond;
}

describe("session companion embedded invocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSelection.mockReset().mockReturnValue({ provider: "test", modelId: "model-a" });
    executePreparedCliRun.mockReset().mockResolvedValue({ text: "The session is fixing a bug." });
    resolveApiKeyForProviderCore
      .mockReset()
      .mockRejectedValue(
        new ProviderAuthError("missing-provider-auth", "anthropic", "No API key found"),
      );
    resolveModelAsync.mockReset().mockResolvedValue({ model: { input: ["text", "image"] } });
    appendMessage.mockReset().mockResolvedValue("seed-entry");
    admitWrite.mockReset().mockImplementation(async (_manager, write) => write());
    removeSession.mockResolvedValue(undefined);
    runEmbeddedAgent.mockReset().mockResolvedValue(completion("The session is reading a file."));
  });

  it.each(["embedded", "cli", "denied-primary", "embedded-cleanup", "cli-cleanup"] as const)(
    "preserves or recovers the utility answer across %s failure",
    async (runtime) => {
      const isCli = runtime === "cli" || runtime === "cli-cleanup";
      const cleanupFails = runtime === "embedded-cleanup" || runtime === "cli-cleanup";
      const primary = isCli
        ? { provider: "anthropic", modelId: "claude-haiku-4-5" }
        : { provider: "test", modelId: "model-a" };
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "test/main", fallbacks: ["test/main-backup"] },
            utilityModel: {
              primary: `${primary.provider}/${primary.modelId}`,
              fallbacks: ["test/model-b"],
            },
            ...(isCli
              ? {
                  models: { "anthropic/claude-haiku-4-5": { agentRuntime: { id: "claude-cli" } } },
                }
              : {}),
          },
        },
      };
      resolveSelection.mockImplementation(({ modelRef }) =>
        modelRef === "test/model-b" ? { provider: "test", modelId: "model-b" } : primary,
      );
      const failure = new FailoverError("Synthetic unavailable utility model", {
        reason: "timeout",
        provider: primary.provider,
        model: primary.modelId,
      });
      const cleanup = vi.fn(async () => {
        throw new Error("Synthetic cleanup failure");
      });
      if (isCli) {
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
        if (cleanupFails) {
          prepareCliRunContext.mockImplementationOnce(async (params) => ({
            params,
            preparedBackend: { cleanup },
          }));
        } else {
          executePreparedCliRun.mockRejectedValueOnce(failure);
        }
      } else if (runtime === "embedded") {
        runEmbeddedAgent.mockRejectedValueOnce(failure);
      } else if (runtime === "embedded-cleanup") {
        removeSession.mockImplementationOnce(cleanup);
        runEmbeddedAgent.mockResolvedValueOnce({
          meta: { durationMs: 1, finalAssistantVisibleText: "The original answer is preserved." },
        });
      }
      const operatorAuthority =
        runtime === "denied-primary"
          ? createAdmittedRunOperatorAuthority({
              profileId: "companion-reader",
              scopes: ["operator.read"],
              assertCurrent() {},
              modelPolicy: prepareOperatorModelPolicy({
                cfg,
                policy: { sourceAgent: "main", allow: ["test/*"], deny: ["test/model-a"] },
                manifestPlugins: [],
              }),
            })
          : undefined;
      const companion = createCompanion(cfg);
      const answer =
        runtime === "cli-cleanup"
          ? "The session is fixing a bug."
          : runtime === "embedded-cleanup"
            ? "The original answer is preserved."
            : "The session is reading a file.";
      try {
        await expect(companion.ask({ ...question, operatorAuthority })).resolves.toMatchObject({
          answer,
        });
        expect(runEmbeddedAgent.mock.calls.map(([params]) => params.model)).toEqual(
          cleanupFails
            ? isCli
              ? []
              : ["model-a"]
            : runtime === "embedded"
              ? ["model-a", "model-b"]
              : ["model-b"],
        );
        for (const [params] of runEmbeddedAgent.mock.calls) {
          expect(params.modelFallbacksOverride).toEqual([]);
          expect(params.toolsAllow).toEqual(["read", "sessions_history", "sessions_search"]);
          expect(params.requireWorkspaceOnly).toBe(true);
        }
        expect(executePreparedCliRun).toHaveBeenCalledTimes(isCli ? 1 : 0);
        if (cleanupFails) {
          expect(cleanup).toHaveBeenCalledOnce();
          expect(removeSession).toHaveBeenCalledOnce();
        }
        expect(companion.state(question).exchanges).toEqual([
          {
            question: question.question,
            answer,
            ts: expect.any(Number),
          },
        ]);
      } finally {
        cliBackendsTesting.resetDepsForTest();
        companion.dispose();
      }
    },
  );

  it("uses the permitted default when every configured utility candidate is denied", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "test/main",
          utilityModel: { primary: "test/model-a", fallbacks: ["test/model-b"] },
        },
      },
    };
    resolveSelection.mockImplementation(({ modelRef }) => ({
      provider: "test",
      modelId: modelRef?.split("/")[1] ?? "model-a",
    }));
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "companion-reader",
      scopes: ["operator.read"],
      assertCurrent() {},
      modelPolicy: prepareOperatorModelPolicy({
        cfg,
        policy: { sourceAgent: "main", allow: ["test/main"] },
        manifestPlugins: [],
      }),
    });
    const companion = createCompanion(cfg);
    try {
      await expect(companion.ask({ ...question, operatorAuthority })).resolves.toMatchObject({
        answer: "The session is reading a file.",
      });
      expect(runEmbeddedAgent.mock.calls.map(([params]) => params.model)).toEqual(["main"]);
      expect(companion.state(question).exchanges).toEqual([
        expect.objectContaining({
          question: question.question,
          answer: "The session is reading a file.",
        }),
      ]);
    } finally {
      companion.dispose();
    }
  });

  it("passes a selected-text comment to the model without persisting it as a file", async () => {
    const companion = createCompanion();
    const respond = await invokeAsk(
      companion,
      {
        question: "What changed?",
        selectionContext: "Selected text:\n<untrusted passage>\n\nUser comment:\nCheck this.",
      },
      "selection-connection",
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ answer: expect.any(String) }),
    );
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("&lt;untrusted passage&gt;"),
        images: undefined,
      }),
    );
    expect(runEmbeddedAgent.mock.calls[0]?.[0].prompt).toContain("User comment:\nCheck this.");
    expect(companion.state({ sessionKey: question.sessionKey, agentId: "main" }).exchanges).toEqual(
      [{ question: "What changed?", answer: expect.any(String), ts: expect.any(Number) }],
    );
    await companion.ask({ ...question, question: "What next?" });
    expect(runEmbeddedAgent.mock.calls[1]?.[0].prompt).toBe("What next?");
    expect(JSON.stringify(appendMessage.mock.calls)).not.toContain("Check this.");
  });

  it.each([0, 2_000_001])(
    "delivers an image with %i padding bytes from the registered RPC to the read-only model run",
    async (padding) => {
      const companion = createCompanion();
      const data = Buffer.concat([
        Buffer.from(imageBase64, "base64"),
        Buffer.alloc(padding),
      ]).toString("base64");
      const respond = await invokeAsk(
        companion,
        {
          question: "What does this show?",
          attachments: [{ mimeType: "image/png", fileName: "proof.png", content: data }],
        },
        "image-connection",
      );
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
    },
  );

  it.each(["preparation", "dispatch", "accepted"] as const)(
    "rechecks the original RPC image policy until model admission (%s)",
    async (phase) => {
      const cfg: OpenClawConfig = { agents: { defaults: { utilityModel: "test/model-a" } } };
      let committed: OpenClawConfig = cfg;
      const disable = () => {
        committed = { gateway: { uploads: { enabled: false } } };
      };
      const companion = createCompanion(cfg);
      const prepare = attachmentProcessor.prepareMediaAttachment;
      const preparation = vi.spyOn(attachmentProcessor, "prepareMediaAttachment");
      if (phase === "preparation") {
        preparation.mockImplementationOnce(async (...args) => {
          const result = await prepare(...args);
          disable();
          return result;
        });
      } else if (phase === "dispatch") {
        admitWrite.mockImplementationOnce(async (_manager, write) => {
          await write();
          disable();
        });
      } else {
        runEmbeddedAgent.mockImplementationOnce(async () => {
          disable();
          return completion("Accepted image answer");
        });
      }
      try {
        const respond = await invokeAsk(
          companion,
          {
            question: "Describe the image",
            attachments: [{ mimeType: "image/png", content: imageBase64 }],
          },
          "late-policy-image",
          cfg,
          () => committed,
        );
        if (phase === "accepted") {
          expect(runEmbeddedAgent).toHaveBeenCalledOnce();
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ answer: "Accepted image answer" }),
          );
        } else {
          expect(runEmbeddedAgent).not.toHaveBeenCalled();
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              code: "FORBIDDEN",
              details: { code: "UPLOADS_DISABLED" },
            }),
          );
          expect(companion.state(question).exchanges).toEqual([]);
        }
      } finally {
        preparation.mockRestore();
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
        return completion("The image is visible.");
      });
      const companion = createCompanion();
      const respond = await invokeAsk(
        companion,
        {
          question: "What does this show?",
          attachments: [{ mimeType: "image/png", content: imageBase64 }],
        },
        "catalog-image-connection",
      );
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ answer: "The image is visible." }),
      );
      expect(modelIo).toHaveBeenCalledOnce();
      expect(resolveModelAsync).not.toHaveBeenCalled();
    },
  );

  it("rejects an image before model I/O when the selected Side chat model is text-only", async () => {
    const modelIo = vi.fn();
    runEmbeddedAgent.mockImplementationOnce(async (params) => {
      params.assertModelInput?.({ input: ["text"] });
      modelIo();
      return completion("Must not answer an unseen image.");
    });
    const companion = createCompanion();
    const respond = await invokeAsk(
      companion,
      {
        question: "What does this show?",
        attachments: [{ mimeType: "image/png", content: imageBase64 }],
      },
      "image-connection",
    );
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
  });

  it("keeps read-only tools direct when the selected agent model opts into Code Mode", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: "/tmp/companion-test",
          utilityModel: "test/model-a",
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
    runEmbeddedAgent.mockResolvedValueOnce(completion("The session is reading a file."));
    const companion = createCompanion(cfg);

    await expect(companion.ask(question)).resolves.toMatchObject({
      answer: "The session is reading a file.",
    });
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
    const metadata = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "anthropic",
          modelCatalog: {
            providers: {
              anthropic: {
                defaultUtilityModel: "claude-haiku-4-5",
                models: [{ id: "claude-haiku-4-5" }],
              },
            },
          },
        },
      ],
    });
    await withPluginMetadataSnapshotScope(
      metadata,
      async () => {
        resolveSelection.mockReturnValueOnce({
          provider: "anthropic",
          modelId: "claude-haiku-4-5",
        });
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
          resolveApiKeyForProviderCore.mockResolvedValue({
            apiKey: "synthetic-key",
            mode: "api-key",
          });
          resolveSelection.mockReturnValueOnce({
            provider: "anthropic",
            modelId: "claude-haiku-4-5",
          });
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
      },
      { config: cfg, compatibleConfigs: [cfg] },
    );
  });

  it("waits for admitted history persistence before starting the companion run", async () => {
    const queued = createDeferredCore();
    const resume = createDeferredCore();
    admitWrite.mockImplementationOnce(async (_manager, write) => {
      queued.resolve();
      await resume.promise;
      await write();
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

  it("settles queued seeding after cancellation without writing or starting a run", async () => {
    const queued = createDeferredCore();
    const resume = createDeferredCore();
    admitWrite.mockImplementationOnce(async (_manager, write) => {
      queued.resolve();
      await resume.promise;
      await write();
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
