// Agent ACP tests cover ACP runtime integration, embedded agent dispatch, and agent command behavior.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./agent-command.test-mocks.js";
import * as acpManagerModule from "../acp/control-plane/manager.js";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import { deliverAgentCommandResult } from "../agents/command/delivery.runtime.js";
import { persistAcpTurnTranscript } from "../agents/command/transcript-persistence.js";
import { getTranscriptMessageRole } from "../agents/embedded-agent-runner/message-visibility.js";
import * as embeddedModule from "../agents/embedded-agent.js";
import { readAgentRunTerminalOutcome } from "../channels/turn/agent-run-terminal-outcome.js";
import * as configIoModule from "../config/io.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTempHomeCore as withTempHomeBase } from "../plugin-sdk/test-helpers/temp-home.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
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
  persistAcpTurnTranscript: vi.fn<
    typeof import("../agents/command/transcript-persistence.js").persistAcpTurnTranscript
  >(async ({ sessionEntry }) => ({ kind: "persisted", sessionEntry })),
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

vi.mock("../agents/command/delivery.runtime.js", () => ({
  deliverAgentCommandResult: vi.fn(
    async (params: {
      runtime: RuntimeEnv;
      payloads?: Array<{ text?: string }>;
      result: { meta: object };
    }) => {
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
  const createAcpVisibleTextAccumulator = () => {
    let text = "";
    let silent = false;
    return {
      consume(chunk: string) {
        if (!chunk || chunk === "NO_REPLY") {
          silent ||= chunk === "NO_REPLY";
          return null;
        }
        text += chunk;
        return { text, delta: chunk };
      },
      finalize: () => text.trim(),
      finalizeRaw: () => text,
      finalizeReplySnapshot: () =>
        text
          ? { disposition: "visible" as const, text }
          : silent
            ? { disposition: "silent" as const }
            : { disposition: "empty" as const },
    };
  };

  return {
    createAcpToolLifecycleTracker: () => ({
      active: new Map(),
      terminalToolCallIds: new Set(),
      saturated: false,
    }),
    createAcpVisibleTextAccumulator,
    emitAcpLifecycleStart: attemptExecutionMocks.emitAcpLifecycleStart,
    emitAcpLifecycleEnd: attemptExecutionMocks.emitAcpLifecycleEnd,
    emitAcpLifecycleError: attemptExecutionMocks.emitAcpLifecycleError,
    emitAcpPromptSubmitted: attemptExecutionMocks.emitAcpPromptSubmitted,
    emitAcpRuntimeEvent: attemptExecutionMocks.emitAcpRuntimeEvent,
    emitAcpAssistantDelta,
    buildAcpResult,
    resolveAcpLifecycleEndFields,
    persistAcpTurnTranscript: attemptExecutionMocks.persistAcpTurnTranscript,
  };
});

const loadConfigSpy = vi.spyOn(configIoModule, "loadConfig");
const runEmbeddedAgentSpy = vi.spyOn(embeddedModule, "runEmbeddedAgent");
const getAcpSessionManagerSpy = vi.spyOn(acpManagerModule, "getAcpSessionManager");

const runtime = createThrowingTestRuntime();

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, {
    prefix: "openclaw-agent-acp-",
    // The ACP/runtime fixtures already own plugin selection.
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
}

function createAcpEnabledConfig(home: string, storePath: string): OpenClawConfig {
  return {
    acp: {
      enabled: true,
      backend: "acpx",
      allowedAgents: ["codex", "kimi"],
      dispatch: { enabled: true },
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
}

function mockConfig(home: string, storePath: string) {
  const cfg = createAcpEnabledConfig(home, storePath);
  loadConfigSpy.mockReturnValue(cfg);
  configIoModule.setRuntimeConfigSnapshot(cfg, cfg);
}

function mockConfigWithAcpOverrides(
  home: string,
  storePath: string,
  acpOverrides: Partial<NonNullable<OpenClawConfig["acp"]>>,
) {
  const cfg = createAcpEnabledConfig(home, storePath);
  cfg.acp = {
    ...cfg.acp,
    ...acpOverrides,
  };
  loadConfigSpy.mockReturnValue(cfg);
  configIoModule.setRuntimeConfigSnapshot(cfg, cfg);
}

function writeAcpSessionStore(storePath: string, agent = "codex") {
  const sessionKey = `agent:${agent}:acp:test`;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      [sessionKey]: {
        sessionId: "acp-session-1",
        updatedAt: Date.now(),
        acp: {
          backend: "acpx",
          agent,
          runtimeSessionName: sessionKey,
          mode: "oneshot",
          state: "idle",
          lastActivityAt: Date.now(),
        },
      },
    }),
  );
}

function resolveReadySession(
  sessionKey: string,
  agent = "codex",
): Awaited<
  ReturnType<ReturnType<typeof acpManagerModule.getAcpSessionManager>["resolveSessionAsync"]>
> {
  const owner = parseAgentSessionKey(sessionKey);
  if (!owner) {
    throw new Error("Expected an owner-qualified ACP fixture key");
  }
  return {
    kind: "ready",
    sessionKey,
    agentId: owner.agentId,
    meta: {
      backend: "acpx",
      agent,
      runtimeSessionName: sessionKey,
      mode: "oneshot",
      state: "idle",
      lastActivityAt: Date.now(),
    },
  };
}

function mockAcpManager(params: {
  runTurn: (params: unknown) => Promise<void>;
  resolveSessionAsync?: ReturnType<
    typeof acpManagerModule.getAcpSessionManager
  >["resolveSessionAsync"];
}) {
  getAcpSessionManagerSpy.mockReturnValue({
    runTurn: params.runTurn,
    resolveSessionAsync:
      params.resolveSessionAsync ??
      (async (input: { sessionKey: string }) => resolveReadySession(input.sessionKey)),
  } as unknown as ReturnType<typeof acpManagerModule.getAcpSessionManager>);
}

async function withAcpSessionEnv(fn: () => Promise<void>) {
  await withTempHome(async (home) => {
    const storePath = path.join(home, "sessions.json");
    writeAcpSessionStore(storePath);
    mockConfig(home, storePath);
    await fn();
  });
}

function createRunTurnFromTextDeltas(chunks: string[]) {
  return vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as {
      onEvent?: (event: { type: string; text?: string; stopReason?: string }) => Promise<void>;
    };
    for (const text of chunks) {
      await params.onEvent?.({ type: "text_delta", text });
    }
    await params.onEvent?.({ type: "done", stopReason: "stop" });
  });
}

function subscribeAssistantEvents() {
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
  return { assistantEvents, stop };
}

async function runAcpTurnWithAssistantEvents(chunks: string[]) {
  const { assistantEvents, stop } = subscribeAssistantEvents();
  const runTurn = createRunTurnFromTextDeltas(chunks);

  mockAcpManager({
    runTurn: (params: unknown) => runTurn(params),
  });

  try {
    vi.mocked(runtime.log).mockClear();
    await agentCommand({ message: "ping", sessionKey: "agent:codex:acp:test" }, runtime);
  } finally {
    stop();
  }

  const logLines = vi.mocked(runtime.log).mock.calls.map(([first]) => String(first));
  return { assistantEvents, logLines };
}

async function runAcpSessionWithPolicyOverridesAndExpectBlocked(params: {
  acpOverrides: Partial<NonNullable<OpenClawConfig["acp"]>>;
  resolveSessionAsync?: Parameters<typeof mockAcpManager>[0]["resolveSessionAsync"];
}) {
  await withTempHome(async (home) => {
    const storePath = path.join(home, "sessions.json");
    writeAcpSessionStore(storePath);
    mockConfigWithAcpOverrides(home, storePath, params.acpOverrides);

    const runTurn = vi.fn(async (_params: unknown) => {});
    mockAcpManager({
      runTurn: (input: unknown) => runTurn(input),
      ...(params.resolveSessionAsync ? { resolveSessionAsync: params.resolveSessionAsync } : {}),
    });

    await expectAcpCommandRejects("agent:codex:acp:test", "ACP_DISPATCH_DISABLED");
    expect(runTurn).not.toHaveBeenCalled();
    expect(runEmbeddedAgentSpy).not.toHaveBeenCalled();
  });
}

async function expectAcpCommandRejects(
  sessionKey: string,
  code: string,
  messageIncludes?: string,
): Promise<void> {
  await expect(agentCommand({ message: "ping", sessionKey }, runtime)).rejects.toMatchObject({
    code,
    ...(messageIncludes ? { message: expect.stringContaining(messageIncludes) } : {}),
  });
}

describe("agentCommand ACP runtime routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runEmbeddedAgentSpy.mockResolvedValue({
      payloads: [{ text: "embedded" }],
      meta: {
        durationMs: 5,
      },
    } as never);
  });

  it.each([
    { name: "completed stop", status: "completed", outcome: "completed" },
    { name: "cancelled result", status: "cancelled", outcome: "failed" },
    { name: "runtime timeout", status: "completed", abort: "timeout", outcome: "failed" },
    {
      name: "transcript cancellation",
      status: "completed",
      abort: "transcript",
      outcome: "failed",
    },
    { name: "late cancellation", status: "completed", abort: "delivery", outcome: "failed" },
  ] as const)(
    "hands off the terminal outcome after real ACP projection: $name",
    async (scenario) => {
      await withAcpSessionEnv(async () => {
        const controller = new AbortController();
        let transcriptTarget: Parameters<typeof loadTranscriptEvents>[0] | undefined;
        const runTurn = vi.fn(async (input: unknown) => {
          const params = input as Parameters<
            ReturnType<typeof acpManagerModule.getAcpSessionManager>["runTurn"]
          >[0];
          await params.onEvent?.({ type: "text_delta", text: "  ACP reply\n" });
          if ("abort" in scenario && scenario.abort === "timeout") {
            controller.abort(new DOMException("deadline", "TimeoutError"));
          }
          await params.onEvent?.({ type: "done", status: scenario.status, stopReason: "stop" });
        });
        mockAcpManager({ runTurn });
        if ("abort" in scenario && scenario.abort === "transcript") {
          const actualExecution = await vi.importActual<
            typeof import("../agents/command/attempt-execution.runtime.js")
          >("../agents/command/attempt-execution.runtime.js");
          attemptExecutionMocks.emitAcpLifecycleEnd.mockImplementationOnce(
            actualExecution.emitAcpLifecycleEnd,
          );
          attemptExecutionMocks.persistAcpTurnTranscript.mockImplementationOnce(async (input) => {
            await Promise.resolve();
            controller.abort();
            const transcript = input as Parameters<
              typeof actualExecution.persistAcpTurnTranscript
            >[0];
            transcriptTarget = {
              agentId: transcript.sessionAgentId,
              sessionId: transcript.sessionId,
              sessionKey: transcript.sessionKey,
              storePath: transcript.storePath,
            };
            const persisted = await actualExecution.persistAcpTurnTranscript(transcript);
            return { kind: "persisted", sessionEntry: persisted.sessionEntry };
          });
        }
        const actualDelivery = await vi.importActual<
          typeof import("../agents/command/delivery.js")
        >("../agents/command/delivery.js");
        vi.mocked(deliverAgentCommandResult).mockImplementationOnce(async (params) => {
          const projected = await actualDelivery.deliverAgentCommandResult(params);
          if ("abort" in scenario && scenario.abort === "delivery") {
            controller.abort();
          }
          return projected;
        });

        const result = await agentCommand(
          {
            message: "  probe\n",
            sessionKey: "agent:codex:acp:test",
            json: true,
            abortSignal: controller.signal,
          },
          runtime,
        );

        expect(runTurn).toHaveBeenCalledOnce();
        expect(runTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey: "agent:codex:acp:test",
            text: "  probe\n",
            mode: "prompt",
          }),
        );
        expect(runEmbeddedAgentSpy).not.toHaveBeenCalled();
        expect(attemptExecutionMocks.persistAcpTurnTranscript.mock.calls.at(-1)?.[0]).toMatchObject(
          {
            body: "  probe\n",
            finalText: "  ACP reply\n",
          },
        );
        expect(result?.payloads).toEqual([{ text: "ACP reply", mediaUrl: null }]);
        expect(result?.meta.aborted).toBe(
          scenario.status === "cancelled" || ("abort" in scenario && scenario.abort !== "delivery"),
        );
        expect(vi.mocked(runtime.log).mock.calls.at(-1)?.[0]).toBe(JSON.stringify(result, null, 2));
        expect(readAgentRunTerminalOutcome(result)).toBe(scenario.outcome);
        if ("abort" in scenario && scenario.abort === "transcript") {
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
          expect(
            attemptExecutionMocks.emitAcpLifecycleEnd.mock.results.at(-1)?.value,
          ).toMatchObject({ reason: "completed", status: "ok" });
        }
      });
    },
  );

  it("streams ACP visible text with the committed assistant occurrence identity", async () => {
    await withAcpSessionEnv(async () => {
      const updates: InternalSessionTranscriptUpdate[] = [];
      const unsubscribe = onInternalSessionTranscriptUpdate((event) => {
        if (getTranscriptMessageRole(event.message) === "assistant") {
          updates.push(event);
        }
      });
      attemptExecutionMocks.persistAcpTurnTranscript.mockImplementationOnce(
        persistAcpTurnTranscript,
      );
      try {
        const repeated = await runAcpTurnWithAssistantEvents(["bo", "ok"]);
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
    });
  });

  it("keeps no-reply ACP turns silent", async () => {
    await withAcpSessionEnv(async () => {
      const { assistantEvents, logLines } = await runAcpTurnWithAssistantEvents(["NO_REPLY"]);

      expect(assistantEvents.every((event) => !event.text)).toBe(true);
      expect(logLines.join("\n")).not.toContain("NO_REPLY");
      expect(logLines).toStrictEqual([]);
    });
  });

  it("fails closed for ACP-shaped session keys missing ACP metadata", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(
        storePath,
        JSON.stringify({
          "agent:codex:acp:stale": {
            sessionId: "stale-1",
            updatedAt: Date.now(),
          },
        }),
      );
      mockConfig(home, storePath);

      const runTurn = vi.fn(async (_params: unknown) => {});
      mockAcpManager({
        runTurn: (params: unknown) => runTurn(params),
        resolveSessionAsync: async ({ sessionKey }) => {
          return {
            kind: "stale",
            sessionKey,
            agentId: "codex",
            error: new AcpRuntimeError(
              "ACP_SESSION_INIT_FAILED",
              `ACP metadata is missing for session ${sessionKey}.`,
            ),
          };
        },
      });

      await expectAcpCommandRejects(
        "agent:codex:acp:stale",
        "ACP_SESSION_INIT_FAILED",
        "ACP metadata is missing",
      );
      expect(runTurn).not.toHaveBeenCalled();
      expect(runEmbeddedAgentSpy).not.toHaveBeenCalled();
    });
  });

  it("blocks ACP turns when disabled by policy", async () => {
    for (const acpOverrides of [
      { enabled: false },
      { dispatch: { enabled: false } },
    ] satisfies Array<Partial<NonNullable<OpenClawConfig["acp"]>>>) {
      await runAcpSessionWithPolicyOverridesAndExpectBlocked({ acpOverrides });
    }
  });

  it("blocks ACP turns when ACP agent is disallowed by policy", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      writeAcpSessionStore(storePath);
      mockConfigWithAcpOverrides(home, storePath, {
        allowedAgents: ["claude"],
      });

      const runTurn = vi.fn(async (_params: unknown) => {});
      mockAcpManager({
        runTurn: (params: unknown) => runTurn(params),
        resolveSessionAsync: async ({ sessionKey }) => resolveReadySession(sessionKey, "codex"),
      });

      await expectAcpCommandRejects(
        "agent:codex:acp:test",
        "ACP_SESSION_INIT_FAILED",
        "not allowed by policy",
      );
      expect(runTurn).not.toHaveBeenCalled();
      expect(runEmbeddedAgentSpy).not.toHaveBeenCalled();
    });
  });
});
