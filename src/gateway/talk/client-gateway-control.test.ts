import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  closeTalkClientGatewayControlSession,
  createTalkClientGatewayControlOwner,
} from "./client-gateway-control.js";
import {
  sessionTarget,
  controlContext,
  controlBridge,
} from "./client-gateway-control.test-support.js";
import { createTalkRealtimeRunControlOwner } from "./realtime-run-control.js";
import { cleanupTalkConnection } from "./session-registry.js";
import {
  registerTalkVoiceSession,
  requestTalkVoiceChange,
  resolveTalkVoiceSession,
} from "./voice-selection.js";

type ControlOptions = Parameters<typeof createTalkClientGatewayControlOwner>[0];

function controlOptions(
  overrides: Pick<ControlOptions, "voiceSessionId" | "connId"> & Partial<ControlOptions>,
) {
  return {
    sessionTarget,
    context: controlContext(),
    runToolAgentConsult: vi.fn(async () => ({ text: "done" })),
    runAgentConsult: vi.fn(async () => ({ text: "done" })),
    appendTranscript: vi.fn(async () => undefined),
    flushTranscript: vi.fn(async () => undefined),
    closeLogicalSession: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("Talk client Gateway control owner", () => {
  it.each(["failed", "incomplete"] as const)(
    "keeps Gateway-controlled browser Talk reusable after a %s response",
    async (status) => {
      const warn = vi.fn();
      const closeProvider = vi.fn(async () => undefined);
      const closeLogicalSession = vi.fn(async () => undefined);
      const talkEvents: Array<{ type: string; payload: unknown }> = [];
      const owner = createTalkClientGatewayControlOwner(
        controlOptions({
          voiceSessionId: `voice-${status}`,
          providerId: "openai",
          connId: "conn-gateway",
          context: controlContext(warn, (event) => talkEvents.push(event)),
          closeLogicalSession,
        }),
      );
      await owner.adoptProvider(closeProvider);
      owner.activate();
      owner.control.onEvent?.({
        direction: "server",
        type: "response.created",
        responseId: "response-1",
      });
      const firstOutcome = {
        status,
        responseId: "response-1",
        message: `provider ${status}`,
      } as const;
      owner.control.onResponseDone?.(firstOutcome);
      owner.control.onEvent?.({
        direction: "server",
        type: "response.done",
        responseId: "response-1",
      });
      owner.control.onEvent?.({
        direction: "server",
        type: "response.created",
        responseId: "response-2",
      });
      owner.control.onResponseDone?.({ status: "completed", responseId: "response-2" });
      owner.control.onEvent?.({
        direction: "server",
        type: "response.done",
        responseId: "response-2",
      });

      expect(talkEvents.filter((event) => event.type === "session.error")).toHaveLength(1);
      expect(talkEvents.filter((event) => event.type === "turn.ended")).toHaveLength(2);
      expect(warn).toHaveBeenCalledWith(`talk Gateway control provider ${status}`);
      expect(closeProvider).not.toHaveBeenCalled();
      expect(closeLogicalSession).not.toHaveBeenCalled();

      await owner.close();
    },
  );

  it("carries provider item and response ids on sideband transcript events", async () => {
    const talkEvents: Array<{ type: string; itemId?: string; parentId?: string }> = [];
    const owner = createTalkClientGatewayControlOwner({
      voiceSessionId: "voice-transcript-ids",
      providerId: "openai",
      sessionTarget,
      connId: "conn-gateway",
      context: controlContext(vi.fn(), (event) => talkEvents.push(event)),
      runToolAgentConsult: vi.fn(async () => ({ text: "done" })),
      runAgentConsult: vi.fn(async () => ({ text: "done" })),
      appendTranscript: vi.fn(async () => undefined),
      flushTranscript: vi.fn(async () => undefined),
      closeLogicalSession: vi.fn(async () => undefined),
    });
    await owner.adoptProvider(vi.fn(async () => undefined));
    owner.activate();

    owner.control.onTranscript?.("user", "what time is it", true, { itemId: "item_user" });
    owner.control.onTranscript?.("assistant", "It is noon.", true, {
      itemId: "item_assistant",
      responseId: "resp_1",
    });

    expect(
      talkEvents
        .filter((event) => event.type === "transcript.done" || event.type === "output.text.done")
        .map(({ type, itemId, parentId }) => ({ type, itemId, parentId })),
    ).toEqual([
      { type: "transcript.done", itemId: "item_user", parentId: undefined },
      { type: "output.text.done", itemId: "item_assistant", parentId: "resp_1" },
    ]);

    await owner.close();
  });

  it.each(["completed", "cancelled"] as const)(
    "persists sideband transcripts, settles a %s consult, and closes idempotently",
    async (outcome) => {
      const consultResult = createDeferred<{ text: string }>();
      const cancelled = {
        ok: true,
        mode: "cancel" as const,
        sessionKey: sessionTarget.canonicalKey,
        active: true,
        aborted: true,
        message: "Cancelled the active OpenClaw run.",
        speak: true,
        show: true,
        suppress: false,
      };
      const controlAgentRun = vi
        .fn(async () => ({
          ...cancelled,
          ok: false,
          active: false,
          aborted: false,
          message: "There is no active OpenClaw run to cancel.",
        }))
        .mockResolvedValueOnce(cancelled);
      const runAgentConsult = vi.fn(async (_args: unknown, signal: AbortSignal) => {
        const result = await consultResult.promise;
        if (outcome === "cancelled") {
          expect(signal.aborted).toBe(true);
          throw new DOMException("Host cancelled the consult", "AbortError");
        }
        return result;
      });
      const appendTranscript = vi.fn(
        async (_entry: { entryId: string; role: "user" | "assistant"; text: string }) => undefined,
      );
      const closeLogicalSession = vi.fn(async () => undefined);
      const closeProvider = vi.fn(async () => undefined);
      const bridge = controlBridge();
      const owner = createTalkClientGatewayControlOwner(
        controlOptions({
          voiceSessionId: "voice-gateway",
          supportsToolCalls: true,
          connId: "conn-gateway",
          runToolAgentConsult: runAgentConsult,
          runAgentConsult,
          controlAgentRun,
          appendTranscript,
          closeLogicalSession,
        }),
      );
      owner.control.bindBridge(bridge);
      await owner.adoptProvider(closeProvider);
      owner.activate();

      owner.control.onTranscript?.("user", "check the repository", true);
      owner.control.onToolCall?.({
        itemId: "item-consult",
        callId: "call-consult",
        name: "openclaw_agent_consult",
        args: { question: "check the repository" },
      });
      await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
      const cancelToolCall = (callId: string) =>
        owner.control.onToolCall?.({
          itemId: callId,
          callId,
          name: "openclaw_agent_control",
          args: { text: "cancel", mode: "cancel" },
        });
      if (outcome === "cancelled") {
        cancelToolCall("call-cancel");
        await vi.waitFor(() =>
          expect(bridge.submitToolResult).toHaveBeenCalledWith("call-cancel", cancelled),
        );
      }
      consultResult.resolve({ text: "The repository is clean." });
      const expectedResult =
        outcome === "cancelled"
          ? expect.objectContaining({ status: "cancelled" })
          : { result: "The repository is clean." };
      await vi.waitFor(() =>
        expect(bridge.submitToolResult).toHaveBeenCalledWith("call-consult", expectedResult),
      );
      expect(appendTranscript).toHaveBeenCalledWith({
        entryId: expect.stringMatching(/^gateway-[0-9a-f-]+-1$/),
        role: "user",
        text: "check the repository",
      });
      if (outcome === "cancelled") {
        await nextEventLoopTurn();
        owner.control.onTranscript?.("user", "cancel", true);
        // A later explicit tool call drains the same control FIFO after the late ASR event.
        cancelToolCall("call-next-cancel");
        await vi.waitFor(() =>
          expect(bridge.submitToolResult).toHaveBeenCalledWith(
            "call-next-cancel",
            expect.objectContaining({ active: false }),
          ),
        );
        expect(controlAgentRun).toHaveBeenCalledTimes(2);
        expect(bridge.sendUserMessage).not.toHaveBeenCalled();
      }

      const closeParams = {
        voiceSessionId: "voice-gateway",
        sessionKey: sessionTarget.sessionKey,
        connId: "conn-gateway",
      };
      await expect(
        closeTalkClientGatewayControlSession({ ...closeParams, connId: "conn-other" }),
      ).rejects.toThrow("not owned by this client");
      await expect(closeTalkClientGatewayControlSession(closeParams)).resolves.toBe(true);
      await expect(closeTalkClientGatewayControlSession(closeParams)).resolves.toBe(false);
      expect(closeProvider).toHaveBeenCalledOnce();
      expect(closeLogicalSession).toHaveBeenCalledOnce();
    },
  );

  it("routes control tool results without starting another consult", async () => {
    const bridge = controlBridge();
    const runAgentConsult = vi.fn(async () => ({ text: "unexpected" }));
    const owner = createTalkClientGatewayControlOwner(
      controlOptions({
        voiceSessionId: "voice-control",
        connId: "conn-control",
        runToolAgentConsult: runAgentConsult,
        runAgentConsult,
      }),
    );
    owner.control.bindBridge(bridge);
    await owner.adoptProvider(vi.fn(async () => undefined));
    owner.activate();
    owner.control.onToolCall?.({
      itemId: "item-status",
      callId: "call-status",
      name: "openclaw_agent_control",
      args: { text: "status", mode: "status" },
    });

    await vi.waitFor(() =>
      expect(bridge.submitToolResult).toHaveBeenCalledWith(
        "call-status",
        expect.objectContaining({ mode: "status", speak: true }),
      ),
    );
    expect(runAgentConsult).not.toHaveBeenCalled();
    await owner.close();
  });

  it.each(["tool", "delegation"] as const)(
    "handles spoken status, steering, and cancellation during a %s consult",
    async (entry) => {
      const controlAgentRun = vi.fn(async ({ text }: { text: string }) => ({
        ok: true,
        mode:
          text === "cancel"
            ? ("cancel" as const)
            : text === "status"
              ? ("status" as const)
              : ("steer" as const),
        sessionKey: sessionTarget.canonicalKey,
        active: true,
        ...(text === "cancel" ? { aborted: true } : { queued: text !== "status" }),
        message: `${text} accepted`,
        speak: true,
        show: true,
        suppress: false,
      }));
      const runStarted = createDeferred();
      const runAgentConsult = vi.fn(
        async (_args: unknown, signal: AbortSignal) =>
          await new Promise<{ text: string }>((_resolve, reject) => {
            runStarted.resolve();
            signal.addEventListener(
              "abort",
              () =>
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error("Realtime voice consult aborted"),
                ),
              { once: true },
            );
          }),
      );
      const bridge = controlBridge();
      const owner = createTalkClientGatewayControlOwner(
        controlOptions({
          voiceSessionId: `voice-spoken-control-${entry}`,
          connId: `conn-spoken-control-${entry}`,
          runToolAgentConsult: runAgentConsult,
          runAgentConsult,
          controlAgentRun,
        }),
      );
      if (entry === "delegation") {
        owner.control.bindControl?.({ sendUserMessage: bridge.sendUserMessage });
      } else {
        owner.control.bindBridge(bridge);
      }
      await owner.adoptProvider(vi.fn(async () => undefined));
      owner.activate();
      const delegationController = new AbortController();
      const delegation =
        entry === "delegation"
          ? owner
              .runAgentConsult({ prompt: "long task", signal: delegationController.signal })
              .catch((error: unknown) => error)
          : undefined;
      if (entry === "tool") {
        owner.control.onToolCall?.({
          itemId: "item-long",
          callId: "call-long",
          name: "openclaw_agent_consult",
          args: { question: "long task" },
        });
      }
      try {
        await runStarted.promise;
        for (const text of ["status", "use the release branch instead", "cancel"]) {
          owner.control.onTranscript?.("user", text, true);
          await vi.waitFor(() =>
            expect(controlAgentRun).toHaveBeenCalledTimes(
              text === "status" ? 1 : text === "cancel" ? 3 : 2,
            ),
          );
        }
        expect(controlAgentRun.mock.calls.map(([input]) => input.text)).toEqual([
          "status",
          "use the release branch instead",
          "cancel",
        ]);
        expect(bridge.sendUserMessage).toHaveBeenCalledTimes(3);
        if (delegation) {
          await expect(delegation).resolves.toBeInstanceOf(Error);
          expect(bridge.submitToolResult).not.toHaveBeenCalled();
        } else {
          await vi.waitFor(() =>
            expect(bridge.submitToolResult).toHaveBeenCalledWith(
              "call-long",
              expect.objectContaining({ status: "cancelled" }),
            ),
          );
        }
      } finally {
        delegationController.abort(new Error("test cleanup"));
        await owner.close();
        await delegation;
      }
    },
  );

  it.each([
    { entry: "tool", transition: "close" },
    { entry: "tool", transition: "replace" },
    { entry: "delegation", transition: "close" },
    { entry: "delegation", transition: "replace" },
  ] as const)(
    "fences $entry admission when $transition occurs during transcript flush",
    async ({ entry, transition }) => {
      const flush = createDeferred();
      const flushTranscript = vi.fn(() => flush.promise);
      const registration = createDeferred<boolean>();
      const backend = vi.fn(async () => ({ text: "must not run" }));
      const backendSteer = vi.fn(async () => ({ text: "" }));
      let ownerInstalled = false;
      const runAgentConsult = Object.assign(
        vi.fn(async (_args: unknown, _signal: AbortSignal, ready?: () => Promise<void>) => {
          ownerInstalled = true;
          try {
            await ready?.();
            registration.resolve(true);
            return await backend();
          } catch (error) {
            registration.resolve(false);
            throw error;
          }
        }),
        {
          steer: vi.fn(async () => {
            if (!ownerInstalled || !(await registration.promise)) {
              throw new Error("The active Talk consult is no longer current");
            }
            return await backendSteer();
          }),
        },
      );
      const common = controlOptions({
        voiceSessionId: `voice-flush-${entry}-${transition}`,
        connId: `conn-flush-${entry}-${transition}`,
        runToolAgentConsult: backend,
        runAgentConsult,
      });
      const owner = createTalkClientGatewayControlOwner({ ...common, flushTranscript });
      let replacement: ReturnType<typeof createTalkClientGatewayControlOwner> | undefined;
      let delegation: Promise<unknown> | undefined;
      let steering: Promise<unknown> | undefined;
      await owner.adoptProvider(vi.fn(async () => undefined));
      owner.activate();
      try {
        if (entry === "delegation") {
          delegation = owner
            .runAgentConsult({ prompt: "queued task" })
            .catch((error: unknown) => error);
        } else {
          owner.control.onToolCall?.({
            itemId: "item-flush",
            callId: "call-flush",
            name: "openclaw_agent_consult",
            args: { question: "queued task" },
          });
        }
        await vi.waitFor(() => expect(flushTranscript).toHaveBeenCalledOnce());
        if (entry === "delegation") {
          steering = owner.runAgentConsult
            .steer?.({ prompt: "latest task" })
            .catch((error: unknown) => error);
          if (!steering) {
            throw new Error("owned Talk runner did not expose steering");
          }
        }
        if (transition === "replace") {
          replacement = createTalkClientGatewayControlOwner({
            ...common,
            flushTranscript: vi.fn(async () => undefined),
          });
          await replacement.adoptProvider(vi.fn(async () => undefined));
          replacement.activate();
        } else {
          void owner.close();
        }
        if (delegation) {
          await expect(delegation).resolves.toBeInstanceOf(Error);
          await expect(steering).resolves.toBeInstanceOf(Error);
        }
        expect(backend).not.toHaveBeenCalled();
        expect(backendSteer).not.toHaveBeenCalled();
        flush.resolve();
        await owner.close();
      } finally {
        flush.resolve();
        registration.resolve(false);
        await owner.close();
        await replacement?.close();
        await delegation;
        await steering;
      }
    },
  );

  it.each([{ mode: "owned" }, { mode: "reusable" }] as const)(
    "fences $mode delegated admission when replacement lands after readiness settles",
    async ({ mode }) => {
      const backend = vi.fn(async () => ({ text: "must not run" }));
      let replaceOwner = async () => {};
      const runToolAgentConsult = vi.fn(
        async (
          _args: unknown,
          _signal: AbortSignal,
          assertCurrent?: () => void,
        ): Promise<{ text: string }> => {
          await Promise.resolve();
          await replaceOwner();
          assertCurrent?.();
          return await backend();
        },
      );
      const runAgentConsult = Object.assign(
        vi.fn(
          async (
            _args: unknown,
            _signal: AbortSignal,
            ready?: () => Promise<void>,
            assertCurrent?: () => void,
          ) => {
            await ready?.();
            await replaceOwner();
            assertCurrent?.();
            return await backend();
          },
        ),
        {
          claimAppend: vi.fn(() => true),
          claimFailureAppend: vi.fn(() => true),
        },
      );
      const common = controlOptions({
        voiceSessionId: `voice-post-readiness-replacement-${mode}`,
        connId: `conn-post-readiness-replacement-${mode}`,
        runToolAgentConsult,
        runAgentConsult,
      });
      const owner = createTalkClientGatewayControlOwner(common);
      let replacement: ReturnType<typeof createTalkClientGatewayControlOwner> | undefined;
      replaceOwner = async () => {
        replacement = createTalkClientGatewayControlOwner(common);
        await replacement.adoptProvider(vi.fn(async () => undefined));
        replacement.activate();
      };
      await owner.adoptProvider(vi.fn(async () => undefined));
      owner.activate();
      if (mode === "owned") {
        owner.runAgentConsult.adoptCompletionClaims?.();
      }

      try {
        await expect(owner.runAgentConsult({ prompt: "queued task" })).rejects.toThrow(
          /closed|not active/,
        );
        expect(backend).not.toHaveBeenCalled();
      } finally {
        await owner.close();
        await replacement?.close();
      }
    },
  );

  it("revokes a replaced owner's retained final before deferred teardown", async () => {
    const claimAppend = vi.fn(() => true);
    const claimFailureAppend = vi.fn(() => true);
    const revokeRequesterFinal = vi.fn();
    const append = vi.fn(() => true);
    const requesterFinal: { append: (text: string) => boolean } = { append };
    let acceptedSignal: AbortSignal | undefined;
    let retainedRequesterFinal: typeof requesterFinal | undefined;
    const runAgentConsult = Object.assign(
      vi.fn(
        async (
          _args: unknown,
          signal: AbortSignal,
          ready?: () => Promise<void>,
          _assertCurrent?: () => void,
          receivedRequesterFinal?: typeof requesterFinal,
        ) => {
          await ready?.();
          acceptedSignal = signal;
          retainedRequesterFinal = receivedRequesterFinal;
          return { text: "delegated", yielded: true as const };
        },
      ),
      {
        claimAppend,
        claimFailureAppend,
        revokeRequesterFinal,
      },
    );
    const common = controlOptions({
      voiceSessionId: "voice-replaced-final",
      connId: "conn-replaced-final",
      runAgentConsult,
    });
    const owner = createTalkClientGatewayControlOwner(common);
    const replacement = createTalkClientGatewayControlOwner(common);
    await owner.adoptProvider(vi.fn(async () => undefined));
    owner.activate();
    owner.runAgentConsult.adoptCompletionClaims?.();
    await expect(owner.runAgentConsult({ prompt: "work", requesterFinal })).resolves.toEqual({
      text: "delegated",
      yielded: true,
    });
    await replacement.adoptProvider(vi.fn(async () => undefined));
    replacement.activate();

    try {
      expect(revokeRequesterFinal).toHaveBeenCalledOnce();
      expect(acceptedSignal?.aborted).toBe(false);
      expect(retainedRequesterFinal?.append("late final")).toBe(false);
      expect(append).not.toHaveBeenCalled();
      expect(owner.runAgentConsult.claimAppend?.()).toBe(false);
      expect(claimAppend).toHaveBeenCalledOnce();
      expect(owner.runAgentConsult.claimFailureAppend?.()).toBe(false);
      expect(claimFailureAppend).toHaveBeenCalledOnce();
    } finally {
      await owner.close();
      expect(revokeRequesterFinal).toHaveBeenCalledOnce();
      await replacement.close();
    }
    expect(acceptedSignal?.aborted).toBe(false);
  });

  it("keeps delegation steering pending until transcript admission publishes the backend", async () => {
    const flush = createDeferred();
    const finish = createDeferred<{ text: string }>();
    const registered = createDeferred();
    const flushTranscript = vi.fn(() => flush.promise);
    let ownerInstalled = false;
    let steeringOutcome: "pending" | "resolved" | "rejected" = "pending";
    const backendStarted = vi.fn();
    const steer = vi.fn(async () => {
      if (!ownerInstalled) {
        throw new Error("No active Talk consult is available to steer");
      }
      await registered.promise;
      return { text: "" };
    });
    const runAgentConsult = Object.assign(
      vi.fn(
        async (
          _args: unknown,
          _signal: AbortSignal,
          ready?: () => Promise<void>,
        ): Promise<{ text: string }> => {
          ownerInstalled = true;
          await ready?.();
          backendStarted();
          registered.resolve();
          return await finish.promise;
        },
      ),
      { steer },
    );
    const owner = createTalkClientGatewayControlOwner(
      controlOptions({
        voiceSessionId: "voice-flush-steering",
        connId: "conn-flush-steering",
        runToolAgentConsult: vi.fn(async () => ({ text: "unused" })),
        runAgentConsult,
        flushTranscript,
      }),
    );
    await owner.adoptProvider(vi.fn(async () => undefined));
    owner.activate();
    owner.runAgentConsult.adoptCompletionClaims?.();

    const first = owner.runAgentConsult({ prompt: "first task" });
    await vi.waitFor(() => expect(flushTranscript).toHaveBeenCalledOnce());
    const steering = owner.runAgentConsult.steer?.({ prompt: "latest task" }).then(
      () => {
        steeringOutcome = "resolved";
      },
      () => {
        steeringOutcome = "rejected";
      },
    );
    if (!steering) {
      throw new Error("owned Talk runner did not expose steering");
    }

    try {
      await Promise.resolve();
      expect(steeringOutcome).toBe("pending");
      expect(backendStarted).not.toHaveBeenCalled();
      flush.resolve();
      await steering;
      expect(steeringOutcome).toBe("resolved");
      expect(steer).toHaveBeenCalledOnce();
      expect(backendStarted).toHaveBeenCalledOnce();
      finish.resolve({ text: "done" });
      await expect(first).resolves.toEqual({ text: "done" });
    } finally {
      flush.resolve();
      registered.resolve();
      finish.resolve({ text: "cleanup" });
      await steering;
      await first.catch(() => undefined);
      await owner.close();
    }
  });

  it.each(["tool", "delegation"] as const)(
    "never admits a %s consult after flush completion schedules closure",
    async (entry) => {
      const flush = createDeferred();
      const transitioned = createDeferred();
      const admissionsAfterClose: boolean[] = [];
      let closed = false;
      const flushTranscript = vi.fn(() => flush.promise);
      const backend = vi.fn(async () => {
        admissionsAfterClose.push(closed);
        return { text: "accepted while open" };
      });
      const runAgentConsult = vi.fn(
        async (_args: unknown, _signal: AbortSignal, ready?: () => Promise<void>) => {
          await ready?.();
          return await backend();
        },
      );
      const owner = createTalkClientGatewayControlOwner(
        controlOptions({
          voiceSessionId: `voice-flush-completion-${entry}`,
          connId: `conn-flush-completion-${entry}`,
          runToolAgentConsult: backend,
          runAgentConsult,
          flushTranscript,
        }),
      );
      // Another completion observer may close the owner between an async
      // preparation helper returning and its caller admitting the actual run.
      void flush.promise.then(() => {
        queueMicrotask(() => {
          closed = true;
          void owner.close();
          transitioned.resolve();
        });
      });
      await owner.adoptProvider(vi.fn(async () => undefined));
      owner.activate();
      let delegation: Promise<unknown> | undefined;
      try {
        if (entry === "delegation") {
          delegation = owner.runAgentConsult({ prompt: "queued task" }).catch(() => undefined);
        } else {
          owner.control.onToolCall?.({
            itemId: "item-flush-completion",
            callId: "call-flush-completion",
            name: "openclaw_agent_consult",
            args: { question: "queued task" },
          });
        }
        await vi.waitFor(() => expect(flushTranscript).toHaveBeenCalledOnce());
        flush.resolve();
        await transitioned.promise;
        await owner.close();
        await delegation;
        expect(admissionsAfterClose).not.toContain(true);
      } finally {
        flush.resolve();
        await owner.close();
        await delegation;
      }
    },
  );
});

const statusResult = {
  ok: true,
  mode: "status" as const,
  sessionKey: sessionTarget.canonicalKey,
  active: false,
  message: "No active request.",
  speak: true,
  show: true,
  suppress: false,
};

describe("native Talk control admission", () => {
  it("answers an execution failure once without disclosing private details", async () => {
    const execute = vi.fn(async () => {
      throw new Error("private execution failure");
    });
    const respond = vi.fn();
    const owner = createTalkRealtimeRunControlOwner({
      controlSource: "delegation",
      hasActiveRun: () => false,
      prepare: () => execute,
      speak: vi.fn(),
      warn: vi.fn(),
    });
    expect(owner.handleDelegationInput?.("status", respond)).toBe("control");
    await owner.close();
    expect(respond).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Please try again."));
    expect(respond.mock.calls[0]?.[0]).not.toContain("private");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not acquire readiness for task fallthrough or saturated controls and does not retry a throwing result sink", async () => {
    const release = createDeferred();
    const ready = vi.fn(() => release.promise);
    const execute = vi.fn(async () => statusResult);
    const warn = vi.fn();
    const owner = createTalkRealtimeRunControlOwner({
      controlSource: "delegation",
      hasActiveRun: () => false,
      prepare: () => execute,
      speak: vi.fn(),
      warn,
    });
    const overflowReply = vi.fn();
    const throwingReply = vi.fn(() => {
      throw new Error("send failed");
    });
    try {
      expect(owner.handleDelegationInput?.("Check the weather.", vi.fn(), ready)).toBe("consult");
      expect(ready).not.toHaveBeenCalled();
      for (let index = 0; index < 9; index += 1) {
        owner.handleDelegationInput?.("status", index === 0 ? throwingReply : vi.fn(), ready);
      }
      owner.handleDelegationInput?.("cancel", overflowReply, ready);
      expect(ready).toHaveBeenCalledOnce();
      expect(overflowReply).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("queue is full"),
      );
      release.resolve();
      await owner.close();
      expect(ready).toHaveBeenCalledTimes(9);
      expect(execute).toHaveBeenCalledTimes(9);
      expect(throwingReply).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("send failed"));
    } finally {
      release.resolve();
      await owner.close();
    }
  });

  it.each(["replace", "disconnect"] as const)(
    "fences retained native input and awaited replies after %s",
    async (ending) => {
      const result = createDeferred<typeof statusResult>();
      const controlAgentRun = vi.fn(async () => await result.promise);
      let connected = true;
      const common = controlOptions({
        voiceSessionId: `native-fence-${ending}`,
        connId: `native-fence-${ending}`,
        controlSource: "delegation" as const,
        assertConnectionOpen: () => {
          if (!connected) {
            throw new Error("disconnected");
          }
        },
        runToolAgentConsult: vi.fn(async () => ({ text: "unexpected task" })),
        runAgentConsult: vi.fn(async () => ({ text: "unexpected task" })),
        controlAgentRun,
      });
      const owner = createTalkClientGatewayControlOwner(common);
      const bridge = controlBridge();
      owner.control.bindBridge(bridge);
      await owner.adoptProvider(vi.fn(async () => undefined));
      owner.activate();
      let replacement: ReturnType<typeof createTalkClientGatewayControlOwner> | undefined;
      const respond = vi.fn();
      const handleInput = owner.control.handleDelegationInput!;
      try {
        owner.control.onTranscript?.("user", "status", true);
        expect(common.appendTranscript).toHaveBeenCalledOnce();
        expect(controlAgentRun).not.toHaveBeenCalled();
        expect(handleInput("status", respond)).toBe("control");
        await vi.waitFor(() => expect(controlAgentRun).toHaveBeenCalledOnce());
        if (ending === "replace") {
          replacement = createTalkClientGatewayControlOwner(common);
          await replacement.adoptProvider(vi.fn(async () => undefined));
          replacement.activate();
        } else if (ending === "disconnect") {
          connected = false;
        }
        expect(() => handleInput("Check the weather.", respond)).toThrow(/closed|disconnected/);
        result.resolve(statusResult);
        await owner.close();
        expect(controlAgentRun).toHaveBeenCalledOnce();
        expect(respond).not.toHaveBeenCalled();
        expect(bridge.sendUserMessage).not.toHaveBeenCalled();
        expect(common.runAgentConsult).not.toHaveBeenCalled();
      } finally {
        result.resolve(statusResult);
        await owner.close();
        await replacement?.close();
      }
    },
  );
});

describe("Talk client reusable Gateway consults", () => {
  it.each([
    { ending: "provider-close", preserveRuns: undefined },
    { ending: "explicit-close", preserveRuns: false },
  ] as const)(
    "retires replacing function-tool transport after $ending (preserveRuns=$preserveRuns)",
    async ({ ending, preserveRuns }) => {
      const finish = createDeferred<{ text: string }>();
      const runToolAgentConsult = vi.fn(
        async (_args: unknown, _signal: AbortSignal) => finish.promise,
      );
      const revokeRequesterFinal = vi.fn();
      const runAgentConsult = Object.assign(
        vi.fn(async () => ({ text: "unused" })),
        {
          claimAppend: vi.fn(() => true),
          revokeRequesterFinal,
        },
      );
      const voiceSessionId = `voice-function-tool-${ending}-${preserveRuns}`;
      const connId = `conn-${voiceSessionId}`;
      const closeProvider = vi.fn(async () => undefined);
      const owner = createTalkClientGatewayControlOwner(
        controlOptions({
          voiceSessionId,
          connId,
          supportsToolCalls: true,
          runToolAgentConsult,
          runAgentConsult,
        }),
      );
      const bridge = controlBridge();
      owner.control.bindBridge(bridge);
      await owner.adoptProvider(closeProvider);
      owner.activate();
      const unregister = registerTalkVoiceSession({
        voiceSessionId,
        connId,
        sessionTarget,
        selection: {
          provider: "openai",
          voice: "marin",
          voices: ["marin", "cedar"],
          canChange: true,
        },
        launch: { provider: "openai", model: "gpt-realtime-2.1" },
        providerReady: true,
      });
      let changing: ReturnType<typeof requestTalkVoiceChange> | undefined;
      let authorityCurrent = true;
      try {
        owner.control.onToolCall?.({
          itemId: "item-voice-change",
          callId: "call-voice-change",
          name: "openclaw_agent_consult",
          args: { question: "Change your voice and keep working" },
        });
        await vi.waitFor(() => expect(runToolAgentConsult).toHaveBeenCalledOnce());
        const runSignal = runToolAgentConsult.mock.calls[0]?.[1];
        expect(runSignal?.aborted).toBe(false);
        changing = requestTalkVoiceChange({
          session: resolveTalkVoiceSession({ kind: "client", connId, voiceSessionId }),
          voice: "cedar",
          requesterConnId: connId,
          assertCurrent: () => {
            if (!authorityCurrent) {
              throw new Error("Voice requester retired");
            }
          },
          send: vi.fn(),
        });
        void changing.catch(() => {});
        if (ending === "provider-close") {
          owner.control.onClose?.("completed");
        } else {
          void owner.close({ preserveRuns });
        }
        // Close captures the current replacement before asynchronous teardown yields.
        authorityCurrent = false;
        expect(() => owner.assertOpen()).toThrow("closed");
        expect(() => owner.control.bindBridge(bridge)).toThrow("closed");
        expect(revokeRequesterFinal).toHaveBeenCalledOnce();
        expect(owner.runAgentConsult.claimAppend?.()).toBe(false);
        await nextEventLoopTurn();
        expect(runSignal?.aborted).toBe(preserveRuns === false);
        finish.resolve({ text: "Accepted work finished" });
        await owner.close();
        expect(bridge.submitToolResult).not.toHaveBeenCalled();
        expect(closeProvider).toHaveBeenCalledTimes(ending === "provider-close" ? 0 : 1);
      } finally {
        finish.resolve({ text: "Test cleanup" });
        await owner.close();
        unregister();
        cleanupTalkConnection(connId, { warn: vi.fn() });
        await changing?.catch(() => {});
      }
    },
  );
});
