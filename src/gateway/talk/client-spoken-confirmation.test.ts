import { setImmediate } from "node:timers/promises";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapToolWithBeforeToolCallHook } from "../../agents/agent-tools.before-tool-call.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { ReplyBackendMessageInjectionV2 } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  authorizeObservedClientVoiceConfirmation,
  checkClientVoiceToolConfirmationPolicy,
} from "../../talk/client-voice-confirmation.js";
import { resetClientVoiceConfirmationStateForTest } from "../../talk/client-voice-confirmation.test-support.js";
import {
  appendClientVoiceTranscript,
  createOrResumeClientVoiceSession,
  flushClientVoiceSessionWrites,
} from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";

const mocks = vi.hoisted(() => ({
  runEmbeddedAgent: vi.fn(),
  beforeAppend: vi.fn(async () => {}),
}));
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.runEmbeddedAgent }));
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    appendTranscriptMessage: async (...args: Parameters<typeof actual.appendTranscriptMessage>) => {
      await mocks.beforeAppend();
      return actual.appendTranscriptMessage(...args);
    },
  };
});

import { createTalkClientAgentConsultRunner } from "./client-agent-consult.js";
import { createTalkClientGatewayControlOwner } from "./client-gateway-control.js";
import { controlBridge, controlContext } from "./client-gateway-control.test-support.js";

type Action = {
  toolName: "sessions_spawn" | "read";
  task: string;
  label: string;
  confirmationId?: string;
};
const sessionAction = (label = "helper"): Action => ({
  toolName: "sessions_spawn",
  task: `Create the requested ${label} session`,
  label,
});
const MODEL_SUCCESS = "I have created the requested sessions.";

// Only model inference and the final session-creation effect are synthetic.
// Admission, transcript persistence, voice binding and the tool gate are real.
describe("native Talk spoken confirmation handoff", () => {
  let state: OpenClawTestState;
  let controls: Array<ReturnType<typeof createTalkClientGatewayControlOwner>>;
  let hostTimeOffsetMs: number;

  beforeEach(async () => {
    hostTimeOffsetMs = 0;
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + hostTimeOffsetMs);
    state = await createOpenClawTestState({ label: "native-voice-confirmation", applyEnv: true });
    mocks.runEmbeddedAgent.mockReset();
    mocks.beforeAppend.mockReset().mockResolvedValue(undefined);
    controls = [];
  });

  afterEach(async () => {
    for (const control of controls) {
      await control.close();
    }
    clientVoiceSessionTesting.reset();
    resetClientVoiceConfirmationStateForTest();
    vi.restoreAllMocks();
    await state.cleanup();
  });

  async function createHarness() {
    const advanceSpeechTime = () => {
      // Preserve strict host-time freshness without changing asynchronous scheduling.
      hostTimeOffsetMs += 1;
    };
    const sessionKey = "agent:main:spoken-confirmation";
    const sessionId = "spoken-confirmation-session";
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      { sessionId, updatedAt: Date.now() },
    );
    const sessionTarget = { agentId: "main", sessionKey, canonicalKey: sessionKey, storePath };
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
      transcriptCapable: true,
    });
    const createdSessions: string[] = [];
    const toolResults: unknown[] = [];
    const actions = [sessionAction()];
    const modelRuns: RunEmbeddedAgentParams[] = [];
    let connected = true;
    let afterTools: () => void = () => {};
    let retryAfterSteer = false;
    const firstActions = createDeferredCore();
    const steeringQueued = createDeferredCore();
    const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
      async (_text, _options, assertCurrent) => {
        assertCurrent();
        steeringQueued.resolve();
      },
    );
    mocks.runEmbeddedAgent.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      modelRuns.push(params);
      const handle = createEmbeddedRunHandle({
        runId: params.runId,
        toolAuthorityFingerprint: "authority",
      });
      handle.messageInjectionV2 = { version: 2, isAvailable: () => true, queueMessage };
      const operationalRunInstance = params.preparedRunAdmission?.operationalRunInstance;
      if (!operationalRunInstance) {
        throw new Error("expected admitted Talk run");
      }
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey,
          operationalRunInstance,
          embeddedRunToolAuthorityBinding: () => ({
            source: "attempt",
            project: () => "authority",
            assertActive: () => {},
          }),
        },
        () => setActiveEmbeddedRun(sessionId, handle, sessionKey),
      );
      try {
        for (let pass = 0; pass < (retryAfterSteer ? 2 : 1); pass += 1) {
          for (const [index, action] of actions.entries()) {
            const tool = wrapToolWithBeforeToolCallHook(
              {
                name: action.toolName,
                label: "Session action",
                description: "Synthetic session action",
                parameters: Type.Object({ task: Type.String(), label: Type.String() }),
                execute: async () => {
                  if (action.toolName === "sessions_spawn") {
                    createdSessions.push(action.label);
                  }
                  return { content: [{ type: "text", text: "Done." }], details: {} };
                },
              },
              { agentId: "main", sessionKey, runId: params.runId },
            );
            const result = await tool.execute(`action:${params.runId}:${pass}:${index}`, {
              task: action.task,
              label: action.label,
              ...(action.confirmationId ? { confirmationId: action.confirmationId } : {}),
            });
            toolResults.push(result.details);
          }
          if (pass === 0) {
            firstActions.resolve();
            if (retryAfterSteer) {
              await steeringQueued.promise;
            }
          }
        }
        afterTools();
        return {
          payloads: [
            {
              text: actions.every((action) => action.toolName === "read")
                ? "Read result."
                : MODEL_SUCCESS,
            },
          ],
          meta: {},
        };
      } finally {
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
        emitTrustedDiagnosticEvent({
          type: "run.completed",
          runId: params.runId,
          durationMs: 1,
          outcome: "completed",
        });
        await waitForDiagnosticEventsDrained();
      }
    });
    const context = controlContext();
    const runner = createTalkClientAgentConsultRunner({
      config: {},
      context,
      sessionTarget,
      ownerConnId: "confirmation-client",
      authority: { senderIsOwner: true },
      getVoiceSessionId: () => voiceSessionId,
      initialItems: [],
    });
    const bridge = controlBridge();
    const steer = vi.spyOn(runner.runOwnedArgs, "steer");
    const appendTranscript = vi.fn<
      Parameters<typeof createTalkClientGatewayControlOwner>[0]["appendTranscript"]
    >((entry) =>
      appendClientVoiceTranscript({
        agentId: "main",
        sessionKey,
        sessionTarget: { sessionKey, storePath },
        voiceSessionId,
        ...entry,
      }),
    );
    const flushTranscript = vi.fn(() =>
      flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId }),
    );
    const owner = createTalkClientGatewayControlOwner({
      voiceSessionId,
      sessionTarget,
      connId: "confirmation-client",
      context,
      controlSource: "delegation",
      assertConnectionOpen: () => {
        if (!connected) {
          throw new Error("client disconnected");
        }
      },
      runToolAgentConsult: runner.runArgs,
      runAgentConsult: runner.runOwnedArgs,
      appendTranscript,
      flushTranscript,
      closeLogicalSession: async () => {},
    });
    owner.control.bindBridge(bridge);
    await owner.adoptProvider(async () => {});
    owner.activate();
    owner.runAgentConsult.adoptCompletionClaims?.();
    controls.push(owner);
    return {
      owner,
      bridge,
      createdSessions,
      toolResults,
      actions,
      appendTranscript,
      flushTranscript,
      firstActions: firstActions.promise,
      persistUser: (text: string) => {
        advanceSpeechTime();
        return appendTranscript({ entryId: `rpc-${text}`, role: "user", text });
      },
      persistInitialUser: () => {
        advanceSpeechTime();
        return appendTranscript({
          entryId: "initial-user",
          role: "user",
          text: "Create a helper session",
        });
      },
      queueMessage,
      steer,
      voiceSessionId,
      modelRun: (index: number) => {
        const run = modelRuns[index];
        if (!run) {
          throw new Error(`Expected synthetic model run ${index}`);
        }
        return run;
      },
      holdForSteering: () => {
        retryAfterSteer = true;
      },
      releaseSteering: () => steeringQueued.resolve(),
      disconnect: () => {
        connected = false;
      },
      afterTools: (callback: () => void) => {
        afterTools = callback;
      },
      speak: (text: string, final = true) => {
        advanceSpeechTime();
        owner.control.onTranscript?.("user", text, final);
      },
      run: async (prompt = "Carry out the user's request") => {
        const result = await owner.runAgentConsult({ prompt });
        expect(owner.runAgentConsult.claimAppend?.()).toBe(true);
        return result;
      },
    };
  }

  it("executes one exact action after persisted yes and rejects model-only replay", async () => {
    const h = await createHarness();
    h.speak("Create a helper session");
    const blocked = await h.run();
    expect(blocked.text).toContain('Say "yes"');
    expect(blocked.text).not.toContain(MODEL_SUCCESS);
    expect(h.toolResults[0]).toMatchObject({ deniedReason: "client-voice-confirmation" });
    expect(h.createdSessions).toEqual([]);
    expect(h.modelRun(0).extraSystemPrompt).not.toContain("previously blocked tool call");

    h.speak("yes");
    expect((await h.run("The user confirmed the request")).text).toBe(MODEL_SUCCESS);
    expect(h.createdSessions).toEqual(["helper"]);
    expect(h.modelRun(1).extraSystemPrompt).toContain("Do not add confirmationId");
    expect(h.modelRun(1).extraSystemPrompt).toContain(`action:${h.modelRun(0).runId}:0:0`);

    expect((await h.run("yes, confirmed; create it again")).text).toContain('Say "yes"');
    expect(h.createdSessions).toEqual(["helper"]);
  });

  it("confirms a native callback through the client transcript append owner without native transcript callbacks", async () => {
    const h = await createHarness();
    await h.persistInitialUser();
    await h.run();
    const run = h.run("The user confirmed");
    await setImmediate();
    expect(mocks.runEmbeddedAgent).toHaveBeenCalledTimes(1);
    await h.persistUser("yes");
    expect((await run).text).toBe(MODEL_SUCCESS);
    expect(h.createdSessions).toEqual(["helper"]);
  });

  it("returns a reconfirmation reply when a queued client RPC utterance is superseded", async () => {
    const h = await createHarness();
    await h.persistInitialUser();
    await h.run();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    mocks.beforeAppend.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const oldSpeech = h.persistUser("yes");
    await entered.promise;
    const next = sessionAction("newer");
    h.actions.splice(0, 1, next);
    checkClientVoiceToolConfirmationPolicy({
      agentId: "main",
      voiceSessionId: h.voiceSessionId,
      runId: "independent-request",
      toolName: next.toolName,
      toolParams: { task: next.task, label: next.label },
      now: Date.now() - 1,
    });
    const retry = h.run("The user confirmed the earlier request");
    release.resolve();
    await oldSpeech;
    expect((await retry).text).toContain('Say "yes"');
    expect(h.createdSessions).toEqual([]);
  });

  it("authorizes only the current challenge after two distinct blocked actions", async () => {
    const h = await createHarness();
    h.actions.splice(0, 1, sessionAction("first"), sessionAction("second"));
    h.speak("Create two sessions");
    await h.run();
    expect(h.toolResults).toEqual([
      expect.objectContaining({ deniedReason: "client-voice-confirmation" }),
      expect.objectContaining({ deniedReason: "client-voice-confirmation" }),
    ]);
    h.speak("yes");
    expect((await h.run()).text).toContain('Say "yes"');
    expect(h.createdSessions).toEqual(["second"]);
    const retryContext = h.modelRun(1).extraSystemPrompt;
    const blockedRunId = h.modelRun(0).runId;
    expect(retryContext).toContain(`action:${blockedRunId}:0:1`);
    expect(retryContext).not.toContain(`action:${blockedRunId}:0:0`);

    h.actions.splice(0, 2, sessionAction("first"));
    h.speak("yes");
    expect((await h.run()).text).toBe(MODEL_SUCCESS);
    expect(h.createdSessions).toEqual(["second", "first"]);
  });

  it("does not hide changed action arguments behind native confirmation", async () => {
    const h = await createHarness();
    h.speak("Create a helper session");
    await h.run();
    h.speak("yes");
    h.actions.splice(0, 1, { ...sessionAction(), confirmationId: "synthetic-model-metadata" });
    expect((await h.run()).text).toContain('Say "yes"');
    expect(h.createdSessions).toEqual([]);
  });

  it.each(["before final", "during persistence", "before any challenge"])(
    "does not arm a new challenge from an older utterance: %s",
    async (phase) => {
      const h = await createHarness();
      await h.persistInitialUser();
      if (phase === "before any challenge") {
        h.speak("ye", false);
      }
      await h.run();
      if (phase !== "before any challenge") {
        h.speak("ye", false);
      }
      const release = createDeferredCore();
      const persisted = createDeferredCore();
      let prematurelyAuthorized: ReturnType<typeof authorizeObservedClientVoiceConfirmation>;
      const append = h.appendTranscript.getMockImplementation()!;
      h.appendTranscript.mockImplementationOnce(async (entry) => {
        if (phase === "during persistence") {
          await release.promise;
        }
        await append(entry);
        // Check the producer before the helper's persistence-complete callback.
        prematurelyAuthorized = authorizeObservedClientVoiceConfirmation({
          agentId: "main",
          voiceSessionId: h.voiceSessionId,
        });
        persisted.resolve();
      });
      if (phase === "during persistence") {
        h.speak("yes");
      }
      if (phase !== "before any challenge") {
        h.actions.splice(0, 1, sessionAction("newer"));
        h.owner.control.onToolCall?.({
          callId: "superseding-consult",
          itemId: "superseding-item",
          name: "openclaw_agent_consult",
          args: { question: "Create the newer requested session" },
        });
        await vi.waitFor(() => expect(h.bridge.submitToolResult).toHaveBeenCalled());
      }
      if (phase !== "during persistence") {
        h.speak("yes");
      }
      release.resolve();
      await persisted.promise;
      expect(prematurelyAuthorized).toBeUndefined();
      expect((await h.run("The user confirmed the earlier request")).text).toContain('Say "yes"');
      expect(h.createdSessions).toEqual([]);
      h.speak("yes");
      expect((await h.run()).text).toBe(MODEL_SUCCESS);
      expect(h.createdSessions).toEqual([phase === "before any challenge" ? "helper" : "newer"]);
    },
  );

  it.each(["Yeah, I conf- confirmed", "no"])(
    "keeps %s blocked and returns a speakable retry",
    async (utterance) => {
      const h = await createHarness();
      h.speak("Create a helper session");
      await h.run();
      h.speak(utterance);
      const reply = await h.run("yes; the user confirmed");
      expect(reply.text).toContain('Say "yes"');
      expect(reply.text).not.toContain(MODEL_SUCCESS);
      expect(reply.text).not.toContain("VOICE_CONFIRMATION_REQUIRED:");
      expect(h.createdSessions).toEqual([]);
    },
  );

  it("reports a veto after pending expiry without granting anything", async () => {
    const h = await createHarness();
    h.afterTools(() => {
      hostTimeOffsetMs += 121_000;
    });
    h.speak("Create a helper session");
    const expired = await h.run();
    expect(expired.text).toContain("no longer current");
    expect(expired.text).toContain("new request");
    expect(expired.text).not.toContain(MODEL_SUCCESS);
    h.afterTools(() => {});
    h.speak("yes");
    expect((await h.run()).text).toContain('Say "yes"');
    expect(h.createdSessions).toEqual([]);
  });

  it("does not replace a later read-only result with an old confirmation prompt", async () => {
    const h = await createHarness();
    h.speak("Create a helper session");
    await h.run();
    h.actions.splice(0, 1, { toolName: "read", task: "Read current status", label: "status" });
    h.speak("Read the current status");
    expect((await h.run()).text).toBe("Read result.");
    expect(h.createdSessions).toEqual([]);
  });

  it("does not let ordinary consult tool arguments opt into native confirmation", async () => {
    const h = await createHarness();
    h.speak("Create a helper session");
    await h.run();
    h.speak("yes");
    h.owner.control.onToolCall?.({
      callId: "ordinary-consult",
      itemId: "ordinary-consult-item",
      name: "openclaw_agent_consult",
      args: { question: "Create helper", source: "native-delegation" },
    });
    await vi.waitFor(() => expect(h.bridge.submitToolResult).toHaveBeenCalled());
    expect(h.toolResults.at(-1)).toMatchObject({ deniedReason: "client-voice-confirmation" });
    expect(h.createdSessions).toEqual([]);
  });

  it("does not admit the confirmed action through a disconnected owner", async () => {
    const h = await createHarness();
    h.speak("Create a helper session");
    await h.run();
    h.speak("yes");
    h.disconnect();
    await expect(h.owner.runAgentConsult({ prompt: "confirmed" })).rejects.toThrow("disconnected");
    expect(h.createdSessions).toEqual([]);
  });

  it("waits for an open confirmation utterance and its durable final before a fresh native callback", async () => {
    const h = await createHarness();
    h.speak("Create a helper session");
    await h.run();
    h.flushTranscript.mockClear();
    h.speak("ye", false);
    const run = h.run("The user confirmed");
    void run.catch(() => {});
    expect(h.flushTranscript).not.toHaveBeenCalled();
    h.owner.control.onTranscript?.("assistant", "Please confirm", true);
    expect(h.flushTranscript).not.toHaveBeenCalled();
    const persist = createDeferredCore();
    const append = h.appendTranscript.getMockImplementation()!;
    h.appendTranscript.mockImplementationOnce(async (entry) => {
      await persist.promise;
      await append(entry);
    });
    h.speak("yes", true);
    expect(h.flushTranscript).not.toHaveBeenCalled();
    expect(h.createdSessions).toEqual([]);
    persist.resolve();
    expect((await run).text).toBe(MODEL_SUCCESS);
    expect(h.createdSessions).toEqual(["helper"]);
  });

  it.each(["final only", "partial then final", "no earlier callback"])(
    "waits when a fresh native callback precedes all confirmation transcript callbacks: %s",
    async (mode) => {
      const h = await createHarness();
      if (mode === "no earlier callback") {
        await h.persistInitialUser();
      } else {
        h.speak("Create a helper session");
      }
      await h.run();
      h.flushTranscript.mockClear();
      const run = h.run("The user confirmed");
      void run.catch(() => {});
      await setImmediate();
      expect(h.flushTranscript).not.toHaveBeenCalled();
      h.owner.control.onTranscript?.("assistant", "Please confirm", true);
      await setImmediate();
      expect(h.flushTranscript).not.toHaveBeenCalled();
      if (mode === "partial then final") {
        h.speak("ye", false);
        await setImmediate();
        expect(h.flushTranscript).not.toHaveBeenCalled();
      }
      const persist = createDeferredCore();
      const append = h.appendTranscript.getMockImplementation()!;
      h.appendTranscript.mockImplementationOnce(async (entry) => {
        await persist.promise;
        await append(entry);
      });
      h.speak("yes");
      await setImmediate();
      expect(h.flushTranscript).not.toHaveBeenCalled();
      persist.resolve();
      expect((await run).text).toBe(MODEL_SUCCESS);
      expect(h.createdSessions).toEqual(["helper"]);
    },
  );

  it.each(["final only", "partial then final"])(
    "waits when active steering precedes all confirmation transcript callbacks: %s",
    async (mode) => {
      const h = await createHarness();
      h.holdForSteering();
      h.speak("Create a helper session");
      const run = h.owner.runAgentConsult({ prompt: "Create helper" });
      try {
        await h.firstActions;
        const steering = h.owner.runAgentConsult.steer!({ prompt: "The user confirms" });
        void steering.catch(() => {});
        await setImmediate();
        expect(h.steer).not.toHaveBeenCalled();
        if (mode === "partial then final") {
          h.speak("ye", false);
          await setImmediate();
          expect(h.steer).not.toHaveBeenCalled();
        }
        h.speak("yes");
        await steering;
        expect((await run).text).toBe(MODEL_SUCCESS);
        expect(h.createdSessions).toEqual(["helper"]);
        expect(h.owner.runAgentConsult.claimAppend?.()).toBe(true);
      } finally {
        h.releaseSteering();
        await run.catch(() => {});
      }
    },
  );

  it("does not wait for an open user final when no confirmation challenge exists", async () => {
    const h = await createHarness();
    h.actions.splice(0, 1, { toolName: "read", task: "Read status", label: "status" });
    h.speak("Read the", false);
    expect((await h.run("Read status")).text).toBe("Read result.");
    expect(h.flushTranscript).toHaveBeenCalled();
  });

  it.each(["persistence", "flush"])(
    "waits for a newer user utterance arriving during an older final's %s",
    async (phase) => {
      const h = await createHarness();
      h.speak("Create a helper session");
      await h.run();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      if (phase === "persistence") {
        const append = h.appendTranscript.getMockImplementation()!;
        h.appendTranscript.mockImplementationOnce(async (entry) => {
          entered.resolve();
          await release.promise;
          await append(entry);
        });
      } else {
        const flush = h.flushTranscript.getMockImplementation()!;
        h.flushTranscript.mockImplementationOnce(async () => {
          await flush();
          entered.resolve();
          await release.promise;
        });
      }
      h.speak("ye", false);
      const run = h.run("The user confirms");
      h.speak("yes");
      await entered.promise;
      h.speak("wait", false);
      release.resolve();
      await setImmediate();
      expect(mocks.runEmbeddedAgent).toHaveBeenCalledTimes(1);
      h.speak("no");
      expect((await run).text).toContain('Say "yes"');
      expect(h.createdSessions).toEqual([]);
    },
  );

  it("settles an empty user final without reusing an older yes", async () => {
    const h = await createHarness();
    h.speak("Create a helper session");
    await h.run();
    h.speak("yes");
    await h.flushTranscript();
    h.speak("uh", false);
    const run = h.run("yes");
    h.speak("", true);
    expect((await run).text).toContain('Say "yes"');
    expect(h.createdSessions).toEqual([]);
  });

  it.each([false, true])(
    "rejects failed user-final persistence with earlier partial=%s",
    async (partial) => {
      const h = await createHarness();
      h.speak("Create a helper session");
      await h.run();
      if (partial) {
        h.speak("ye", false);
      }
      const run = h.owner.runAgentConsult({ prompt: "yes" });
      const rejected = expect(run).rejects.toThrow("synthetic persistence failure");
      h.appendTranscript.mockRejectedValueOnce(new Error("synthetic persistence failure"));
      h.speak("yes");
      await rejected;
      expect(h.owner.runAgentConsult.claimFailureAppend?.()).toBe(true);
      expect(h.createdSessions).toEqual([]);
    },
  );

  it.each([false, true])(
    "aborts user-final wait on close with earlier partial=%s",
    async (partial) => {
      const h = await createHarness();
      h.speak("Create a helper session");
      await h.run();
      if (partial) {
        h.speak("ye", false);
      }
      const run = h.owner.runAgentConsult({ prompt: "yes" });
      const rejected = expect(run).rejects.toMatchObject({ name: "AbortError" });
      await h.owner.close();
      await rejected;
      expect(h.createdSessions).toEqual([]);
    },
  );

  it("aborts a delegation before any confirmation transcript callback", async () => {
    const h = await createHarness();
    h.speak("Create a helper session");
    await h.run();
    const controller = new AbortController();
    const run = h.owner.runAgentConsult({ prompt: "yes", signal: controller.signal });
    const rejected = expect(run).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(h.createdSessions).toEqual([]);
  });

  it("waits for the final yes before steering the same live run's blocked action", async () => {
    const h = await createHarness();
    h.holdForSteering();
    h.speak("Create a helper session");
    const run = h.owner.runAgentConsult({ prompt: "Create helper" });
    try {
      await h.firstActions;
      h.speak("ye", false);
      const steering = h.owner.runAgentConsult.steer!({ prompt: "The user confirms" });
      void steering.catch(() => {});
      expect(h.steer).not.toHaveBeenCalled();
      expect(h.queueMessage).not.toHaveBeenCalled();
      h.owner.control.onTranscript?.("assistant", "Please confirm", true);
      expect(h.steer).not.toHaveBeenCalled();
      expect(h.queueMessage).not.toHaveBeenCalled();
      const persist = createDeferredCore();
      const append = h.appendTranscript.getMockImplementation()!;
      h.appendTranscript.mockImplementationOnce(async (entry) => {
        await persist.promise;
        await append(entry);
      });
      h.speak("yes", true);
      expect(h.steer).not.toHaveBeenCalled();
      persist.resolve();
      await steering;
      expect(h.queueMessage.mock.calls.at(0)?.[0]).toContain("Do not add confirmationId");
      expect(h.queueMessage.mock.calls.at(0)?.[0]).toContain(`action:${h.modelRun(0).runId}:0:0`);
      expect((await run).text).toBe(MODEL_SUCCESS);
      expect(h.createdSessions).toEqual(["helper"]);
      expect(h.owner.runAgentConsult.claimAppend?.()).toBe(true);
    } finally {
      h.releaseSteering();
      await run.catch(() => {});
    }
  });
});
