import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentInternalParams } from "../agents/embedded-agent-runner/run/internal-params.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../agents/harness/tool-surface-bridge.js";
import { createStubTool } from "../agents/test-helpers/agent-tool-stubs.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createSessionCompanion } from "./session-companion.js";

const runEmbeddedAgent = vi.hoisted(() =>
  vi.fn<
    (params: RunEmbeddedAgentInternalParams) => Promise<{
      meta: { durationMs: number; finalAssistantVisibleText: string };
    }>
  >(),
);

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
vi.mock("../agents/sessions/session-manager-write-admission.js", () => ({
  withSessionManagerWrite: admitWrite,
}));
vi.mock("../config/sessions/session-accessor.js", () => ({ loadExactSessionEntry: loadEntry }));
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
  resolveSimpleCompletionSelectionForAgent: () => ({ provider: "test", modelId: "model-a" }),
}));

function createCompanion(cfg: OpenClawConfig = {}) {
  return createSessionCompanion({
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

const question = {
  agentId: "main",
  sessionKey: "agent:main:main",
  question: "What is it doing?",
  connId: "conn-1",
};

describe("session companion embedded invocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appendMessage.mockReset();
    admitWrite.mockReset().mockImplementation(async (_manager, write) => write());
    loadEntry.mockReturnValue({ entry: { ...preparedTarget.sessionEntry } });
    removeSession.mockResolvedValue(undefined);
    runEmbeddedAgent.mockResolvedValue({
      meta: { durationMs: 1, finalAssistantVisibleText: "The session is reading a file." },
    });
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
