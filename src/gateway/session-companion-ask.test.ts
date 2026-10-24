import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { prepareCliRunModelAuthority } from "../agents/cli-runner/run-admission.js";
import type { RunCliAgentParams } from "../agents/cli-runner/types.js";
import { resolveBundledStaticCatalogModel } from "../agents/embedded-agent-runner/model.static-catalog.js";
import type { RunEmbeddedAgentInternalParams } from "../agents/embedded-agent-runner/run/internal-params.js";
import { FailoverError } from "../agents/failover-error.js";
import { ProviderAuthError } from "../agents/model-auth-runtime-shared.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
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
  return Object.assign(companion, {
    rpc: (params: Record<string, unknown>, getCommittedRuntimeConfig?: () => OpenClawConfig) =>
      invokeAsk(companion, params, "conn-1", cfg, getCommittedRuntimeConfig),
  });
}

function config(defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>) {
  return { agents: { defaults } } satisfies OpenClawConfig;
}
const utilityConfig = (
  models?: NonNullable<NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"]>,
) =>
  config({
    model: "test/main",
    utilityModel: { primary: "test/model-a", fallbacks: ["test/model-b"] },
    ...(models ? { models } : {}),
  });
function resolveConfiguredModel() {
  resolveSelection.mockImplementation(({ modelRef }) => ({
    provider: "test",
    modelId: modelRef?.split("/")[1] ?? "model-a",
  }));
}
function expectRpcError(respond: ReturnType<typeof vi.fn>, error: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
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

function expectAnswer(respond: ReturnType<typeof vi.fn>, answer: unknown = expect.any(String)) {
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ answer }));
}

function operatorFor(cfg: OpenClawConfig, allow: string[], deny?: string[]) {
  return createAdmittedRunOperatorAuthority({
    profileId: "companion-reader",
    scopes: ["operator.read"],
    assertCurrent() {},
    modelPolicy: prepareOperatorModelPolicy({
      cfg,
      policy: { sourceAgent: "main", allow, ...(deny ? { deny } : {}) },
      manifestPlugins: [],
    }),
  });
}

function useClaudeCli() {
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
  onTestFinished(() => cliBackendsTesting.resetDepsForTest());
}

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
      loadGatewayModelCatalog: async () => [],
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
      const cfg = config({
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
      });
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
        useClaudeCli();
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
        runtime === "denied-primary" ? operatorFor(cfg, ["test/*"], ["test/model-a"]) : undefined;
      const companion = createCompanion(cfg);
      const answer =
        runtime === "cli-cleanup"
          ? "The session is fixing a bug."
          : runtime === "embedded-cleanup"
            ? "The original answer is preserved."
            : "The session is reading a file.";
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
      expect(executePreparedCliRun).toHaveBeenCalledTimes(isCli ? 1 : 0);
      for (const [params] of runEmbeddedAgent.mock.calls) {
        expect(params.modelFallbacksOverride).toEqual([]);
      }
      if (cleanupFails) {
        expect(cleanup).toHaveBeenCalledOnce();
        expect(removeSession).toHaveBeenCalledOnce();
      }
      expect(companion.state(question).exchanges).toEqual([
        { question: question.question, answer, ts: expect.any(Number) },
      ]);
    },
  );

  it("uses the permitted default when every configured utility candidate is denied", async () => {
    const cfg = utilityConfig();
    resolveConfiguredModel();
    const operatorAuthority = operatorFor(cfg, ["test/main"]);
    const companion = createCompanion(cfg);
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
  });

  it("answers with the question's chosen model, reasoning, and speed instead of the utility route", async () => {
    const cfg = utilityConfig({ "test/main": {}, "test/model-a": {}, "test/model-c": {} });
    resolveConfiguredModel();
    const companion = createCompanion(cfg);
    expect(companion.state(question).defaultModel).toBe("test/model-a");
    const chosen = await companion.rpc({
      question: "Which file?",
      model: "test/model-c",
      thinkingLevel: "high",
      fastMode: true,
    });
    expectAnswer(chosen);
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(runEmbeddedAgent.mock.calls[0]?.[0]).toMatchObject({
      model: "model-c",
      thinkLevel: "high",
      fastMode: true,
      modelFallbacksOverride: [],
    });

    const outside = await companion.rpc({ question: "Which file?", model: "test/model-z" });
    expectRpcError(outside, {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("model-z"),
    });
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  });

  it("passes a selected-text comment to the model without persisting it as a file", async () => {
    const companion = createCompanion();
    const respond = await companion.rpc({
      question: "What changed?",
      selectionContext: "Selected text:\n<untrusted passage>\n\nUser comment:\nCheck this.",
    });
    expectAnswer(respond);
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
      const respond = await companion.rpc({
        question: "What does this show?",
        attachments: [{ mimeType: "image/png", fileName: "proof.png", content: data }],
      });
      expectAnswer(respond);
      expect(runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "What does this show?",
          images: [expect.objectContaining({ type: "image", mimeType: "image/png", data })],
          disableMessageTool: true,
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
        const respond = await companion.rpc(
          {
            question: "Describe the image",
            attachments: [{ mimeType: "image/png", content: imageBase64 }],
          },
          () => committed,
        );
        if (phase === "accepted") {
          expect(runEmbeddedAgent).toHaveBeenCalledOnce();
          expectAnswer(respond, "Accepted image answer");
        } else {
          expect(runEmbeddedAgent).not.toHaveBeenCalled();
          expectRpcError(respond, {
            code: "FORBIDDEN",
            details: { code: "UPLOADS_DISABLED" },
          });
          expect(companion.state(question).exchanges).toEqual([]);
        }
      } finally {
        preparation.mockRestore();
      }
    },
  );

  it("uses the already prepared image model without extra resolution", async () => {
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
    resolveModelAsync.mockRejectedValue(new Error("Unexpected additional discovery"));
    const modelIo = vi.fn();
    runEmbeddedAgent.mockImplementationOnce(async (params) => {
      params.assertModelInput?.(model);
      modelIo();
      return completion("The image is visible.");
    });
    const companion = createCompanion();
    const respond = await companion.rpc({
      question: "What does this show?",
      attachments: [{ mimeType: "image/png", content: imageBase64 }],
    });
    expectAnswer(respond, "The image is visible.");
    expect(modelIo).toHaveBeenCalledOnce();
    expect(resolveModelAsync).not.toHaveBeenCalled();
  });

  it("rejects an image before model I/O when the selected Side chat model is text-only", async () => {
    const modelIo = vi.fn();
    runEmbeddedAgent.mockImplementationOnce(async (params) => {
      params.assertModelInput?.({ input: ["text"] });
      modelIo();
      return completion("Must not answer an unseen image.");
    });
    const companion = createCompanion();
    const respond = await companion.rpc({
      question: "What does this show?",
      attachments: [{ mimeType: "image/png", content: imageBase64 }],
    });
    expectRpcError(respond, {
      message: expect.stringContaining("does not support image input"),
      details: { reason: "image-input-unsupported" },
      retryable: false,
    });
    expect(modelIo).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(resolveModelAsync).not.toHaveBeenCalled();
    await expect(companion.ask(question)).resolves.toMatchObject({ answer: expect.any(String) });
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
    expect(runEmbeddedAgent.mock.calls[1]?.[0].assertModelInput).toBeUndefined();
    expect(resolveModelAsync).not.toHaveBeenCalled();
  });

  it("answers through the primary model's CLI runtime when no provider API key exists", async () => {
    const cfg = config({
      workspace: "/tmp/companion-test",
      model: "anthropic/claude-opus-4-6",
      models: { "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } } },
    });
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
        useClaudeCli();
        const companion = createCompanion(cfg);
        const operatorAuthority = operatorFor(cfg, ["anthropic/claude-haiku-4-5"]);
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
      const failed = expect(pending).rejects.toThrow();
      expect(removeSession).not.toHaveBeenCalled();
      resume.resolve();
      await failed;
      expect(removeSession).toHaveBeenCalledWith(preparedTarget, {
        lifecycleRevision: preparedTarget.sessionEntry.lifecycleRevision,
        activeWriterRunId: preparedTarget.sessionEntry.activeWriterRunId,
      });
      expect(appendMessage).not.toHaveBeenCalled();
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await pending.catch(() => undefined);
    }
  });
});
