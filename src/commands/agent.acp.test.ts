import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import "./agent-command.test-mocks.js";
import * as acpManagerModule from "../acp/control-plane/manager.js";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import { emitAcpLifecycleEnd } from "../agents/command/acp-lifecycle.js";
import type * as AttemptExecutionHelpers from "../agents/command/attempt-execution.helpers.js";
import { deliverAgentCommandResult } from "../agents/command/delivery.runtime.js";
import { persistAcpTurnTranscript } from "../agents/command/transcript-persistence.js";
import { getTranscriptMessageRole } from "../agents/embedded-agent-runner/message-visibility.js";
import * as embeddedModule from "../agents/embedded-agent.js";
import { readAgentRunTerminalOutcome } from "../channels/turn/agent-run-terminal-outcome.js";
import { writeFixtureJsonSync } from "../cli/cli-fixtures.test-support.js";
import * as configIoModule from "../config/io.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTempHomeCore as withTempHomeBase } from "../plugin-sdk/test-helpers/temp-home.js";
import {
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { agentCommand } from "./agent.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

const agentEventMocks = vi.hoisted(() => {
  type AgentEvent = { stream: string; data?: Record<string, unknown>; runId?: string };
  const handlers = new Set<(event: AgentEvent) => void>();
  return {
    assertAgentRunLifecycleGenerationCurrent: vi.fn(),
    captureAgentRunLifecycleGeneration: vi.fn(() => "test-generation"),
    clearAgentRunContext: vi.fn(),
    emitAgentEvent: vi.fn((event: AgentEvent) => {
      for (const handler of handlers) {
        handler(event);
      }
    }),
    getAgentEventLifecycleGeneration: vi.fn(() => "test-generation"),
    isAgentEventLifecycleGenerationCurrent: vi.fn(
      (generation: string) => generation === "test-generation",
    ),
    onAgentEvent: vi.fn((handler: (event: AgentEvent) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    registerAgentEventLifecycleRotationHandler: vi.fn(),
    registerAgentRunContext: vi.fn(),
    withAgentRunLifecycleGeneration: vi.fn((_generation: string, run: () => unknown) => run()),
  };
});

const attemptExecutionMocks = vi.hoisted(() => ({
  emitAcpLifecycleStart: vi.fn(),
  emitAcpLifecycleEnd: vi.fn(),
  emitAcpLifecycleError: vi.fn(),
  emitAcpPromptSubmitted: vi.fn(),
  emitAcpRuntimeEvent: vi.fn(),
  persistAcpTurnTranscript: vi.fn<typeof persistAcpTurnTranscript>(async ({ sessionEntry }) => ({
    kind: "persisted",
    sessionEntry,
  })),
}));

vi.mock("../infra/agent-events.js", () => agentEventMocks);
vi.mock("../infra/agent-run-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/agent-run-registry.js")>();
  return {
    ...actual,
    clearAgentRunContext: agentEventMocks.clearAgentRunContext,
    registerAgentRunContext: agentEventMocks.registerAgentRunContext,
  };
});

// mock-isolation: ACP routing captures delivered payloads without invoking outbound transports.
vi.mock("../agents/command/delivery.runtime.js", () => ({
  deliverAgentCommandResult: vi.fn(
    async (params: Parameters<typeof deliverAgentCommandResult>[0]) => {
      for (const payload of params.payloads ?? []) {
        if (payload.text) {
          params.runtime.log(payload.text);
        }
      }
      return { payloads: params.payloads ?? [], meta: params.result.meta };
    },
  ),
}));

// mock-isolation: ACP command routing does not execute embedded or CLI attempts.
vi.mock("../agents/command/attempt-execution.runtime.js", async () => {
  const { buildAcpResult, emitAcpAssistantDelta, resolveAcpLifecycleEndFields } =
    await vi.importActual<typeof import("../agents/command/acp-lifecycle.js")>(
      "../agents/command/acp-lifecycle.js",
    );
  const { createAcpVisibleTextAccumulator } = await vi.importActual<typeof AttemptExecutionHelpers>(
    "../agents/command/attempt-execution.helpers.js",
  );

  return {
    createAcpToolLifecycleTracker: () => ({
      active: new Map(),
      terminalToolCallIds: new Set(),
      saturated: false,
    }),
    createAcpVisibleTextAccumulator,
    ...attemptExecutionMocks,
    emitAcpAssistantDelta,
    buildAcpResult,
    resolveAcpLifecycleEndFields,
  };
});

const loadConfigSpy = vi.spyOn(configIoModule, "loadConfig");
const runEmbeddedAgentSpy = vi.spyOn(embeddedModule, "runEmbeddedAgent");
const getAcpSessionManagerSpy = vi.spyOn(acpManagerModule, "getAcpSessionManager");
const runtime = createThrowingTestRuntime();
const runCommand = (opts: Partial<Parameters<typeof agentCommand>[0]> = {}) =>
  agentCommand({ message: "ping", sessionKey: "agent:codex:acp:test", ...opts }, runtime);

type AcpConfig = Partial<NonNullable<OpenClawConfig["acp"]>>;
function mockConfig(home: string, storePath: string, acpOverrides: AcpConfig = {}) {
  const cfg: OpenClawConfig = {
    acp: {
      enabled: true,
      backend: "acpx",
      allowedAgents: ["codex", "kimi"],
      dispatch: { enabled: true },
      ...acpOverrides,
    },
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.5" },
        models: { "openai/gpt-5.5": {} },
        workspace: path.join(home, "openclaw"),
      },
    },
    session: { store: storePath, mainKey: "main" },
  };
  loadConfigSpy.mockReturnValue(cfg);
  configIoModule.setRuntimeConfigSnapshot(cfg, cfg);
}

type ReadySession = Extract<acpManagerModule.AcpSessionResolution, { kind: "ready" }>;
function resolveReadySession(sessionKey: string): ReadySession {
  return {
    kind: "ready",
    sessionKey,
    agentId: "codex",
    meta: {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: sessionKey,
      mode: "oneshot",
      state: "idle",
      lastActivityAt: Date.now(),
    },
  };
}

function mockAcpManager(params: {
  runTurn: acpManagerModule.AcpSessionManager["runTurn"];
  resolveSessionAsync?: acpManagerModule.AcpSessionManager["resolveSessionAsync"];
}) {
  getAcpSessionManagerSpy.mockReturnValue({
    runTurn: params.runTurn,
    resolveSessionAsync:
      params.resolveSessionAsync ??
      (async (input: { sessionKey: string }) => resolveReadySession(input.sessionKey)),
  } as unknown as ReturnType<typeof acpManagerModule.getAcpSessionManager>);
}

async function withAcpSession(
  fn: () => Promise<void>,
  acpOverrides: AcpConfig = {},
  stale = false,
) {
  await withTempHomeBase(
    async (home) => {
      const storePath = path.join(home, "sessions.json");
      const sessionKey = stale ? "agent:codex:acp:stale" : "agent:codex:acp:test";
      writeFixtureJsonSync(storePath, {
        [sessionKey]: {
          sessionId: stale ? "stale-1" : "acp-session-1",
          updatedAt: Date.now(),
          ...(!stale && { acp: resolveReadySession(sessionKey).meta }),
        },
      });
      mockConfig(home, storePath, acpOverrides);
      await fn();
    },
    {
      prefix: "openclaw-agent-acp-",
      // ACP fixtures own plugin selection.
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    },
  );
}

async function runAcpTurn(chunks: string[]) {
  const assistantEvents: Array<{ text?: string; delta?: string; itemId?: string }> = [];
  const stop = agentEventMocks.onAgentEvent((evt) => {
    if (evt.stream !== "assistant") {
      return;
    }
    assistantEvents.push({
      itemId: typeof evt.data?.itemId === "string" ? evt.data.itemId : undefined,
      text: typeof evt.data?.text === "string" ? evt.data.text : undefined,
      delta: typeof evt.data?.delta === "string" ? evt.data.delta : undefined,
    });
  });
  mockAcpManager({
    runTurn: vi.fn(async (params: acpManagerModule.AcpRunTurnInput) => {
      for (const text of chunks) {
        await params.onEvent?.({ type: "text_delta", text });
      }
      await params.onEvent?.({ type: "done", stopReason: "stop" });
    }),
  });
  try {
    vi.mocked(runtime.log).mockClear();
    await runCommand();
  } finally {
    stop();
  }
  const logLines = vi.mocked(runtime.log).mock.calls.map(([first]) => String(first));
  return { assistantEvents, logLines };
}

beforeEach(() => {
  vi.clearAllMocks();
  runEmbeddedAgentSpy.mockResolvedValue({
    payloads: [{ text: "embedded" }],
    meta: { durationMs: 5 },
  } as never);
});

it.each([
  ["completed stop", "completed", undefined, "completed"],
  ["cancelled result", "cancelled", undefined, "failed"],
  ["runtime timeout", "completed", "timeout", "failed"],
  ["transcript cancellation", "completed", "transcript", "failed"],
  ["late cancellation", "completed", "delivery", "failed"],
] as const)(
  "hands off the terminal outcome after real ACP projection: %s",
  (_name, status, abort, outcome) =>
    withAcpSession(async () => {
      const controller = new AbortController();
      let transcriptTarget: Parameters<typeof loadTranscriptEvents>[0] | undefined;
      const runTurn = vi.fn(async (params: acpManagerModule.AcpRunTurnInput) => {
        await params.onEvent?.({ type: "text_delta", text: "  ACP reply\n" });
        if (abort === "timeout") {
          controller.abort(new DOMException("deadline", "TimeoutError"));
        }
        await params.onEvent?.({ type: "done", status, stopReason: "stop" });
      });
      mockAcpManager({ runTurn });
      if (abort === "transcript") {
        attemptExecutionMocks.emitAcpLifecycleEnd.mockImplementationOnce(emitAcpLifecycleEnd);
        attemptExecutionMocks.persistAcpTurnTranscript.mockImplementationOnce(
          async (transcript) => {
            await Promise.resolve();
            controller.abort();
            transcriptTarget = {
              agentId: transcript.sessionAgentId,
              sessionId: transcript.sessionId,
              sessionKey: transcript.sessionKey,
              storePath: transcript.storePath,
            };
            const persisted = await persistAcpTurnTranscript(transcript);
            return { kind: "persisted", sessionEntry: persisted.sessionEntry };
          },
        );
      }
      const actualDelivery = await vi.importActual<typeof import("../agents/command/delivery.js")>(
        "../agents/command/delivery.js",
      );
      vi.mocked(deliverAgentCommandResult).mockImplementationOnce(async (params) => {
        const projected = await actualDelivery.deliverAgentCommandResult(params);
        if (abort === "delivery") {
          controller.abort();
        }
        return projected;
      });
      const result = await runCommand({
        message: "  probe\n",
        json: true,
        abortSignal: controller.signal,
      });
      expect(attemptExecutionMocks.persistAcpTurnTranscript.mock.calls.at(-1)?.[0]).toMatchObject({
        body: "  probe\n",
        finalText: "  ACP reply\n",
      });
      expect(result?.payloads).toEqual([{ text: "  ACP reply", mediaUrl: null }]);
      expect(result?.meta.aborted).toBe(
        status === "cancelled" || (abort !== undefined && abort !== "delivery"),
      );
      expect(readAgentRunTerminalOutcome(result)).toBe(outcome);
      if (abort === "transcript") {
        if (!transcriptTarget) {
          throw new Error("Expected the runtime-owned transcript identity");
        }
        const transcript = await loadTranscriptEvents(transcriptTarget);
        expect(transcript).toContainEqual(
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              role: "assistant",
              content: [{ type: "text", text: "  ACP reply\n" }],
              stopReason: "stop",
            }),
          }),
        );
        expect(attemptExecutionMocks.emitAcpLifecycleEnd.mock.results.at(-1)?.value).toMatchObject({
          reason: "completed",
          status: "ok",
        });
      }
    }),
);

it("streams ACP visible text with the committed assistant occurrence identity", () =>
  withAcpSession(async () => {
    const updates: InternalSessionTranscriptUpdate[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((event) => {
      if (getTranscriptMessageRole(event.message) === "assistant") {
        updates.push(event);
      }
    });
    attemptExecutionMocks.persistAcpTurnTranscript.mockImplementationOnce(persistAcpTurnTranscript);
    try {
      const repeated = await runAcpTurn(["bo", "ok"]);
      expect(updates).toHaveLength(1);
      const committed = updates[0];
      if (!committed?.target) {
        throw new Error("Expected an inline committed ACP assistant");
      }
      expect(committed.runId).toEqual(expect.any(String));
      expect(committed.message).toMatchObject({
        idempotencyKey: committed.runId,
        __openclaw: { runId: committed.runId },
        content: [{ type: "text", text: "book" }],
      });
      expect(await loadTranscriptEvents(committed.target)).toContainEqual(
        expect.objectContaining({ type: "message", message: committed.message }),
      );
      expect(repeated.assistantEvents).toEqual([
        { itemId: committed.runId, text: "bo", delta: "bo" },
        { itemId: committed.runId, text: "book", delta: "ok" },
      ]);
      expect(repeated.logLines.join("\n")).toContain("book");
    } finally {
      unsubscribe();
    }
  }));

it.each(["", "NO_REPLY", " \tNO_REPLY\n"])(
  "fails result-required ACP completion without delivering %j",
  (text) =>
    withAcpSession(async () => {
      await expect(runAcpTurn([text])).rejects.toMatchObject({
        code: "ACP_TURN_FAILED",
        message: expect.stringContaining("empty response"),
      });
      expect(deliverAgentCommandResult).not.toHaveBeenCalled();
      expect(attemptExecutionMocks.persistAcpTurnTranscript).toHaveBeenCalledWith(
        expect.objectContaining({ finalText: text }),
      );
    }),
);

it("delivers a literal sentinel after stripping the leading control line", () =>
  withAcpSession(async () => {
    const { logLines } = await runAcpTurn(["NO_REPLY\nNO_REPLY"]);
    expect(logLines).toContain("NO_REPLY");
  }));

it("fails closed for ACP-shaped session keys missing ACP metadata", () =>
  withAcpSession(
    async () => {
      const runTurn = vi.fn(async () => {});
      mockAcpManager({
        runTurn,
        resolveSessionAsync: async ({ sessionKey }) => ({
          kind: "stale",
          sessionKey,
          agentId: "codex",
          error: new AcpRuntimeError(
            "ACP_SESSION_INIT_FAILED",
            `ACP metadata is missing for session ${sessionKey}.`,
          ),
        }),
      });
      await expect(runCommand({ sessionKey: "agent:codex:acp:stale" })).rejects.toMatchObject({
        code: "ACP_SESSION_INIT_FAILED",
        message: expect.stringContaining("ACP metadata is missing"),
      });
      expect(runTurn).not.toHaveBeenCalled();
      expect(runEmbeddedAgentSpy).not.toHaveBeenCalled();
    },
    {},
    true,
  ));

it.each([
  [{ enabled: false }, "ACP_DISPATCH_DISABLED", undefined],
  [{ dispatch: { enabled: false } }, "ACP_DISPATCH_DISABLED", undefined],
  [{ allowedAgents: ["claude"] }, "ACP_SESSION_INIT_FAILED", "not allowed by policy"],
] satisfies Array<[AcpConfig, string, string | undefined]>)(
  "blocks ACP turns under policy %j",
  (acpOverrides, code, message) =>
    withAcpSession(async () => {
      const runTurn = vi.fn(async () => {});
      mockAcpManager({ runTurn });
      await expect(runCommand()).rejects.toMatchObject({
        code,
        ...(message ? { message: expect.stringContaining(message) } : {}),
      });
      expect(runTurn).not.toHaveBeenCalled();
      expect(runEmbeddedAgentSpy).not.toHaveBeenCalled();
    }, acpOverrides),
);
