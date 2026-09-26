// Repro/regression for https://github.com/openclaw/openclaw/issues/128041:
// after restart recovery resumes a turn, chat.startup reports the session as
// running with hasActiveRun=true but publishes no in-flight run snapshot, so a
// reconnecting Control UI has nothing to adopt the live run with. Recovery
// resumes register abort controllers with kind "agent"; the snapshot resolver
// must adopt the flagged, started, current-generation ones. The snapshot is an
// adoption anchor (run identity for timer and Stop routing); pre-restart text
// is not recoverable, so live commentary resumes through post-reconnect events.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { EmbeddedAgentQueueHandle } from "../agents/embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { registerChatAbortController } from "./chat-abort.js";
import {
  createDirectChatContext,
  createTextTranscriptEvent,
} from "./server-chat.agent-events.test-helpers.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { captureChatResponse } from "./server.chat-response.test-support.js";
import {
  createDirectChatSessionStoreFixture,
  writeMainChatSessionTranscript,
} from "./server.chat-session-store.test-support.js";
import { testState, writeSessionStore } from "./test-helpers.js";

const autoCleanupTempDirs = createTempDirTracker();
const sessionStoreFixture = createDirectChatSessionStoreFixture(autoCleanupTempDirs);

const RECOVERY_RUN_IDS = ["run-recovery", "run-background-agent"];

beforeAll(() => {
  sessionStoreFixture.prepare();
});

afterEach(async () => {
  for (const runId of RECOVERY_RUN_IDS) {
    clearAgentRunContext(runId);
  }
  testState.sessionStorePath = undefined;
  resetConfigRuntimeState();
  autoCleanupTempDirs.cleanup();
});

afterAll(async () => {
  await sessionStoreFixture.dispose();
});

async function readStartupPayload(context: GatewayRequestContext) {
  await initializeSessionReadContext(context);
  const { coreGatewayHandlers } = await import("./server-methods.js");
  const handler = coreGatewayHandlers["chat.startup"];
  if (!handler) {
    throw new Error("chat.startup handler missing in test invariant");
  }
  const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  await handler({
    id: "startup-recovery-repro",
    params: { sessionKey: "main" },
    req: {
      type: "req",
      id: "startup-recovery-repro",
      method: "chat.startup",
      params: { sessionKey: "main" },
    },
    client: null,
    isWebchatConnect: () => false,
    respond: captureChatResponse(responses),
    context,
  } as never);
  expect(responses).toHaveLength(1);
  expect(responses[0]?.ok, JSON.stringify(responses[0]?.error)).toBe(true);
  return responses[0]?.payload as
    | {
        sessionInfo?: { status?: unknown; hasActiveRun?: unknown };
        inFlightRun?: unknown;
        messages?: Array<{ role?: unknown; content?: Array<{ text?: unknown }> }>;
      }
    | undefined;
}

function registerAgentKindRun(context: GatewayRequestContext, runId: string) {
  return registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId,
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    agentId: "main",
    timeoutMs: 60_000,
    kind: "agent",
  });
}

describe("chat.startup after restart recovery", () => {
  test("publishes a visible in-flight snapshot for the resumed recovery run", async () => {
    sessionStoreFixture.open({ fresh: true });
    try {
      await writeSessionStore({
        entries: {
          main: { sessionId: "sess-main", updatedAt: Date.now() },
        },
      });
      // Post-recovery shape: the canonical transcript holds only the synthetic
      // restart-recovery notices, the resumed turn owns a kind-"agent" abort
      // entry and a flagged registry context, and the fresh process holds no
      // chat run state for it.
      await writeMainChatSessionTranscript([
        createTextTranscriptEvent("user", "Gateway restarted. Recovery in progress.", {
          timestamp: Date.now() - 60_000,
        }),
        createTextTranscriptEvent("user", "Recovery resumed the active turn.", {
          timestamp: Date.now() - 30_000,
        }),
      ]);
      registerAgentRunContext("run-recovery", {
        sessionKey: "agent:main:main",
        sessionId: "sess-main",
        agentId: "main",
        projectSessionActive: true,
        mainSessionRestartRecovery: true,
      });
      const context = createDirectChatContext();
      const abortRegistration = registerAgentKindRun(context, "run-recovery");
      expect(abortRegistration.markExecutionStarted()).toBe(true);
      // The live process keeps buffering the resumed run's commentary and
      // tool activity under its run id; the adopted snapshot must surface it.
      Object.assign(context.chatRunState.getOrCreate("run-recovery"), {
        rawBuffer: "Resumed progress is streaming.",
      });
      context.chatRunState.recordProgressEvent("run-recovery", {
        runId: "run-recovery",
        seq: 1,
        stream: "tool",
        ts: Date.now(),
        sessionKey: "agent:main:main",
        data: { phase: "start", toolCallId: "tool-recovery", name: "read" },
      });
      try {
        const payload = await readStartupPayload(context);
        expect(payload?.sessionInfo).toMatchObject({ status: "running", hasActiveRun: true });
        expect(payload?.inFlightRun).toMatchObject({
          runId: "run-recovery",
          text: "Resumed progress is streaming.",
          sessionAbortable: true,
        });
        expect(
          (payload?.inFlightRun as { events?: unknown[] } | undefined)?.events ?? [],
        ).not.toHaveLength(0);
        expect(
          (payload?.messages ?? []).flatMap((message) =>
            (message.content ?? []).map((part) => part.text),
          ),
        ).toEqual([
          "Gateway restarted. Recovery in progress.",
          "Recovery resumed the active turn.",
        ]);
      } finally {
        abortRegistration.cleanup();
      }
    } finally {
      await sessionStoreFixture.reset();
    }
  });

  test("keeps aborted recovery entries out of the chat snapshot", async () => {
    sessionStoreFixture.open({ fresh: true });
    try {
      await writeSessionStore({
        entries: {
          main: { sessionId: "sess-main", updatedAt: Date.now() },
        },
      });
      registerAgentRunContext("run-recovery", {
        sessionKey: "agent:main:main",
        sessionId: "sess-main",
        agentId: "main",
        projectSessionActive: true,
        mainSessionRestartRecovery: true,
      });
      const context = createDirectChatContext();
      const abortRegistration = registerAgentKindRun(context, "run-recovery");
      expect(abortRegistration.markExecutionStarted()).toBe(true);
      abortRegistration.controller.abort();
      try {
        const payload = await readStartupPayload(context);
        expect(payload).not.toHaveProperty("inFlightRun");
      } finally {
        abortRegistration.cleanup();
      }
    } finally {
      await sessionStoreFixture.reset();
    }
  });

  test("keeps Stop session-scoped when an embedded recovery owner coexists", async () => {
    sessionStoreFixture.open({ fresh: true });
    const embeddedHandle: EmbeddedAgentQueueHandle = {
      abort: () => undefined,
      isAborted: () => false,
      isCompacting: () => false,
      isStreaming: () => true,
      queueMessage: async () => undefined,
      runId: "run-embedded",
    };
    try {
      await writeSessionStore({
        entries: {
          main: { sessionId: "sess-main", updatedAt: Date.now() },
        },
      });
      registerAgentRunContext("run-recovery", {
        sessionKey: "agent:main:main",
        sessionId: "sess-main",
        agentId: "main",
        projectSessionActive: true,
        mainSessionRestartRecovery: true,
      });
      setActiveEmbeddedRun("sess-main", embeddedHandle, "agent:main:main");
      const context = createDirectChatContext();
      const abortRegistration = registerAgentKindRun(context, "run-recovery");
      expect(abortRegistration.markExecutionStarted()).toBe(true);
      try {
        const payload = await readStartupPayload(context);
        expect(payload?.sessionInfo).toMatchObject({ status: "running", hasActiveRun: true });
        // Either owner may win the snapshot, but Stop must stay session-scoped.
        expect(payload?.inFlightRun).toMatchObject({ sessionAbortable: true });
      } finally {
        abortRegistration.cleanup();
      }
    } finally {
      clearActiveEmbeddedRun("sess-main", embeddedHandle, "agent:main:main");
      clearAgentRunContext("run-recovery");
      await sessionStoreFixture.reset();
    }
  });

  test("keeps unflagged agent-kind runs out of the chat snapshot", async () => {
    sessionStoreFixture.open({ fresh: true });
    try {
      await writeSessionStore({
        entries: {
          main: { sessionId: "sess-main", updatedAt: Date.now() },
        },
      });
      const context = createDirectChatContext();
      const abortRegistration = registerAgentKindRun(context, "run-background-agent");
      try {
        const payload = await readStartupPayload(context);
        expect(payload).not.toHaveProperty("inFlightRun");
      } finally {
        abortRegistration.cleanup();
      }
    } finally {
      await sessionStoreFixture.reset();
    }
  });
});
