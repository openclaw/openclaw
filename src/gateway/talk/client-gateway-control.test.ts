import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  activate,
  controlOptions,
  createControlFixture as rawFixture,
  type ControlOwner,
} from "./client-control-fixture.test-support.js";
import {
  closeTalkClientGatewayControlSession,
  createTalkClientGatewayControlOwner as createRawOwner,
} from "./client-gateway-control.js";
import {
  sessionTarget,
  controlContext,
  controlBridge,
} from "./client-gateway-control.test-support.js";
import { createTalkRealtimeRunControlOwner as createRawRunControl } from "./realtime-run-control.js";
import { cleanupTalkConnection } from "./session-registry.js";
import {
  registerTalkVoiceSession,
  requestTalkVoiceChange,
  resolveTalkVoiceSession,
} from "./voice-selection.js";

// Release blocked work before closing its owner, including when an assertion fails.
const releases: Array<() => void> = [];
const owners: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  const results = await Promise.allSettled(owners.splice(0).map((owner) => owner.close()));
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") {
    throw failed.reason;
  }
});
function deferred<T>(fallback: T) {
  const result = createDeferred<T>();
  releases.push(() => result.resolve(fallback));
  return result;
}
function gate() {
  const result = createDeferred();
  releases.push(() => result.resolve());
  return result;
}
function own<T extends { close: () => Promise<void> }>(owner: T): T {
  owners.push(owner);
  return owner;
}
function createTalkClientGatewayControlOwner(options: Parameters<typeof createRawOwner>[0]) {
  return own(createRawOwner(options));
}
function createTalkRealtimeRunControlOwner(options: Parameters<typeof createRawRunControl>[0]) {
  return own(createRawRunControl(options));
}
function createOwner(options: Parameters<typeof controlOptions>[0]) {
  return createTalkClientGatewayControlOwner(controlOptions(options));
}
function createControlFixture<T extends Parameters<typeof controlOptions>[0]>(options: T) {
  const fixture = rawFixture(options);
  own(fixture.owner);
  return fixture;
}

type ConsultRunner = Parameters<typeof createTalkClientGatewayControlOwner>[0]["runAgentConsult"];

function consult(owner: ControlOwner, id: string, question: string) {
  owner.control.onToolCall?.({
    itemId: `item-${id}`,
    callId: `call-${id}`,
    name: "openclaw_agent_consult",
    args: { question },
  });
}

function beginConsult(
  owner: ControlOwner,
  entry: string,
  id: string,
  prompt: string,
  signal?: AbortSignal,
) {
  if (entry === "tool") {
    consult(owner, id, prompt);
    return undefined;
  }
  return owner.runAgentConsult({ prompt, signal }).catch((error: unknown) => error);
}

async function replaceOwner(options: Parameters<typeof createRawOwner>[0]) {
  const owner = createTalkClientGatewayControlOwner(options);
  await activate(owner);
}

function readinessRunner(backend: () => Promise<{ text: string }>) {
  const registered = deferred(false);
  let installed = false;
  const backendSteer = vi.fn(async () => ({ text: "" }));
  const steer = vi.fn(async () => {
    if (!installed || !(await registered.promise)) {
      throw new Error("The active Talk consult is no longer current");
    }
    return await backendSteer();
  });
  const runAgentConsult = Object.assign(
    vi.fn<ConsultRunner>(async (_args, _signal, ready) => {
      installed = true;
      try {
        await ready?.();
        registered.resolve(true);
        return await backend();
      } catch (error) {
        registered.resolve(false);
        throw error;
      }
    }),
    { steer },
  );
  return { runAgentConsult, backendSteer, steer };
}

function responseEvent(owner: ControlOwner, type: string, responseId: string) {
  owner.control.onEvent?.({ direction: "server", type, responseId });
}

async function waitForCalls(mock: unknown, count = 1) {
  await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(count));
}

async function waitForResult(
  bridge: ReturnType<typeof controlBridge>,
  id: string,
  result: unknown,
) {
  await vi.waitFor(() => expect(bridge.submitToolResult).toHaveBeenCalledWith(id, result));
}

function controlResult<Mode extends "status" | "cancel" | "steer">(
  mode: Mode,
  message: string,
  active = true,
) {
  return {
    ok: true,
    mode,
    sessionKey: sessionTarget.canonicalKey,
    active,
    message,
    speak: true,
    show: true,
    suppress: false,
  };
}

describe("Talk client Gateway control owner", () => {
  it.each(["failed", "incomplete"] as const)(
    "keeps Gateway-controlled browser Talk reusable after a %s response",
    async (status) => {
      const warn = vi.fn();
      const talkEvents: Array<{ type: string; payload: unknown }> = [];
      const { owner, closeProvider, closeLogicalSession } = createControlFixture({
        voiceSessionId: `voice-${status}`,
        providerId: "openai",
        connId: "conn-gateway",
        context: controlContext(warn, (event) => talkEvents.push(event)),
      });
      await activate(owner, closeProvider);
      responseEvent(owner, "response.created", "response-1");
      const firstOutcome = {
        status,
        responseId: "response-1",
        message: `provider ${status}`,
      } as const;
      owner.control.onResponseDone?.(firstOutcome);
      responseEvent(owner, "response.done", "response-1");
      responseEvent(owner, "response.created", "response-2");
      owner.control.onResponseDone?.({ status: "completed", responseId: "response-2" });
      responseEvent(owner, "response.done", "response-2");

      expect(talkEvents.filter((event) => event.type === "session.error")).toHaveLength(1);
      expect(talkEvents.filter((event) => event.type === "turn.ended")).toHaveLength(2);
      expect(warn).toHaveBeenCalledWith(`talk Gateway control provider ${status}`);
      expect(closeProvider).not.toHaveBeenCalled();
      expect(closeLogicalSession).not.toHaveBeenCalled();

      await owner.close();
    },
  );

  it.each(["completed", "cancelled"] as const)(
    "persists sideband transcripts, settles a %s consult, and closes idempotently",
    async (outcome) => {
      const consultResult = deferred({ text: "test cleanup" });
      const cancelled = {
        ...controlResult("cancel", "Cancelled the active OpenClaw run."),
        aborted: true,
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
      const { owner, bridge, closeProvider, appendTranscript, closeLogicalSession } =
        createControlFixture({
          voiceSessionId: "voice-gateway",
          supportsToolCalls: true,
          connId: "conn-gateway",
          runToolAgentConsult: runAgentConsult,
          runAgentConsult,
          controlAgentRun,
        });
      owner.control.bindBridge(bridge);
      await activate(owner, closeProvider);

      owner.control.onTranscript?.("user", "check the repository", true);
      consult(owner, "consult", "check the repository");
      await waitForCalls(runAgentConsult);
      const cancelToolCall = (callId: string) =>
        owner.control.onToolCall?.({
          itemId: callId,
          callId,
          name: "openclaw_agent_control",
          args: { text: "cancel", mode: "cancel" },
        });
      if (outcome === "cancelled") {
        cancelToolCall("call-cancel");
        await waitForResult(bridge, "call-cancel", cancelled);
      }
      consultResult.resolve({ text: "The repository is clean." });
      const expectedResult =
        outcome === "cancelled"
          ? expect.objectContaining({ status: "cancelled" })
          : { result: "The repository is clean." };
      await waitForResult(bridge, "call-consult", expectedResult);
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
        await waitForResult(bridge, "call-next-cancel", expect.objectContaining({ active: false }));
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

  it.each(["tool", "delegation"] as const)(
    "handles spoken status, steering, and cancellation during a %s consult",
    async (entry) => {
      const controlAgentRun = vi.fn(async ({ text }: { text: string }) => ({
        ...controlResult(
          text === "cancel" ? "cancel" : text === "status" ? "status" : "steer",
          `${text} accepted`,
        ),
        ...(text === "cancel" ? { aborted: true } : { queued: text !== "status" }),
      }));
      const runStarted = gate();
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
      const { owner, bridge } = createControlFixture({
        voiceSessionId: `voice-spoken-control-${entry}`,
        connId: `conn-spoken-control-${entry}`,
        runToolAgentConsult: runAgentConsult,
        runAgentConsult,
        controlAgentRun,
      });
      if (entry === "delegation") {
        owner.control.bindControl?.({ sendUserMessage: bridge.sendUserMessage });
      } else {
        owner.control.bindBridge(bridge);
      }
      await activate(owner);
      const delegationController = new AbortController();
      releases.push(() => delegationController.abort(new Error("test cleanup")));
      const delegation = beginConsult(
        owner,
        entry,
        "long",
        "long task",
        delegationController.signal,
      );
      await runStarted.promise;
      for (const text of ["status", "use the release branch instead", "cancel"]) {
        owner.control.onTranscript?.("user", text, true);
        await waitForCalls(controlAgentRun, text === "status" ? 1 : text === "cancel" ? 3 : 2);
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
        await waitForResult(bridge, "call-long", expect.objectContaining({ status: "cancelled" }));
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
      const flush = gate();
      const flushTranscript = vi.fn(() => flush.promise);
      const backend = vi.fn(async () => ({ text: "must not run" }));
      const { runAgentConsult, backendSteer } = readinessRunner(backend);
      const common = controlOptions({
        voiceSessionId: `voice-flush-${entry}-${transition}`,
        connId: `conn-flush-${entry}-${transition}`,
        runToolAgentConsult: backend,
        runAgentConsult,
      });
      const owner = createTalkClientGatewayControlOwner({ ...common, flushTranscript });
      let steering: Promise<unknown> | undefined;
      await activate(owner);
      const delegation = beginConsult(owner, entry, "flush", "queued task");
      await waitForCalls(flushTranscript);
      if (entry === "delegation") {
        steering = owner.runAgentConsult
          .steer?.({ prompt: "latest task" })
          .catch((error: unknown) => error);
        if (!steering) {
          throw new Error("owned Talk runner did not expose steering");
        }
      }
      if (transition === "replace") {
        await replaceOwner({
          ...common,
          flushTranscript: vi.fn(async () => undefined),
        });
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
    },
  );

  it.each(["owned", "reusable"] as const)(
    "fences %s delegated admission when replacement lands after readiness settles",
    async (mode) => {
      const backend = vi.fn(async () => ({ text: "must not run" }));
      let replace = async () => {};
      const runToolAgentConsult = vi.fn<
        Parameters<typeof createTalkClientGatewayControlOwner>[0]["runToolAgentConsult"]
      >(async (_args, _signal, assertCurrent) => {
        await Promise.resolve();
        await replace();
        assertCurrent?.();
        return await backend();
      });
      const runAgentConsult = Object.assign(
        vi.fn<ConsultRunner>(async (_args, _signal, ready, assertCurrent) => {
          await ready?.();
          await replace();
          assertCurrent?.();
          return await backend();
        }),
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
      replace = async () => {
        await replaceOwner(common);
      };
      await activate(owner);
      if (mode === "owned") {
        owner.runAgentConsult.adoptCompletionClaims?.();
      }

      await expect(owner.runAgentConsult({ prompt: "queued task" })).rejects.toThrow(
        /closed|not active/,
      );
      expect(backend).not.toHaveBeenCalled();
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
      vi.fn<ConsultRunner>(async (_args, signal, ready, _assertCurrent, receivedRequesterFinal) => {
        await ready?.();
        acceptedSignal = signal;
        retainedRequesterFinal = receivedRequesterFinal;
        return { text: "delegated", yielded: true as const };
      }),
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
    await activate(owner);
    owner.runAgentConsult.adoptCompletionClaims?.();
    await expect(owner.runAgentConsult({ prompt: "work", requesterFinal })).resolves.toEqual({
      text: "delegated",
      yielded: true,
    });
    await activate(replacement);

    expect(revokeRequesterFinal).toHaveBeenCalledOnce();
    expect(acceptedSignal?.aborted).toBe(false);
    expect(retainedRequesterFinal?.append("late final")).toBe(false);
    expect(append).not.toHaveBeenCalled();
    expect(owner.runAgentConsult.claimAppend?.()).toBe(false);
    expect(claimAppend).toHaveBeenCalledOnce();
    expect(owner.runAgentConsult.claimFailureAppend?.()).toBe(false);
    expect(claimFailureAppend).toHaveBeenCalledOnce();
    await owner.close();
    expect(revokeRequesterFinal).toHaveBeenCalledOnce();
    await replacement.close();
    expect(acceptedSignal?.aborted).toBe(false);
  });

  it("keeps delegation steering pending until transcript admission publishes the backend", async () => {
    const flush = gate();
    const finish = deferred({ text: "test cleanup" });
    const flushTranscript = vi.fn(() => flush.promise);
    let steeringOutcome: "pending" | "resolved" | "rejected" = "pending";
    const backendStarted = vi.fn();
    const { runAgentConsult, steer } = readinessRunner(async () => {
      backendStarted();
      return await finish.promise;
    });
    const owner = createOwner({
      voiceSessionId: "voice-flush-steering",
      connId: "conn-flush-steering",
      runToolAgentConsult: vi.fn(async () => ({ text: "unused" })),
      runAgentConsult,
      flushTranscript,
    });
    await activate(owner);
    owner.runAgentConsult.adoptCompletionClaims?.();

    const first = owner.runAgentConsult({ prompt: "first task" });
    void first.catch(() => undefined);
    await waitForCalls(flushTranscript);
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
  });

  it.each(["tool", "delegation"] as const)(
    "never admits a %s consult after flush completion schedules closure",
    async (entry) => {
      const flush = gate();
      const transitioned = gate();
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
      const owner = createOwner({
        voiceSessionId: `voice-flush-completion-${entry}`,
        connId: `conn-flush-completion-${entry}`,
        runToolAgentConsult: backend,
        runAgentConsult,
        flushTranscript,
      });
      // Another completion observer may close the owner between an async
      // preparation helper returning and its caller admitting the actual run.
      void flush.promise.then(() => {
        queueMicrotask(() => {
          closed = true;
          void owner.close();
          transitioned.resolve();
        });
      });
      await activate(owner);
      const delegation = beginConsult(owner, entry, "flush-completion", "queued task");
      await waitForCalls(flushTranscript);
      flush.resolve();
      await transitioned.promise;
      await owner.close();
      await delegation;
      expect(admissionsAfterClose).not.toContain(true);
    },
  );
});

const statusResult = controlResult("status", "No active request.", false);

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
    const release = gate();
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
    expect(owner.handleDelegationInput?.("Check the weather.", vi.fn(), ready)).toBe("consult");
    expect(ready).not.toHaveBeenCalled();
    for (let index = 0; index < 9; index += 1) {
      owner.handleDelegationInput?.("status", index === 0 ? throwingReply : vi.fn(), ready);
    }
    owner.handleDelegationInput?.("cancel", overflowReply, ready);
    expect(ready).toHaveBeenCalledOnce();
    expect(overflowReply).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("queue is full"));
    release.resolve();
    await owner.close();
    expect(ready).toHaveBeenCalledTimes(9);
    expect(execute).toHaveBeenCalledTimes(9);
    expect(throwingReply).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("send failed"));
  });

  it.each(["replace", "disconnect"] as const)(
    "fences retained native input and awaited replies after %s",
    async (ending) => {
      const result = deferred(statusResult);
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
      await activate(owner);
      const respond = vi.fn();
      const handleInput = owner.control.handleDelegationInput!;
      owner.control.onTranscript?.("user", "status", true);
      expect(common.appendTranscript).toHaveBeenCalledOnce();
      expect(controlAgentRun).not.toHaveBeenCalled();
      expect(handleInput("status", respond)).toBe("control");
      await waitForCalls(controlAgentRun);
      if (ending === "replace") {
        await replaceOwner(common);
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
      const finish = deferred({ text: "test cleanup" });
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
      const owner = createOwner({
        voiceSessionId,
        connId,
        supportsToolCalls: true,
        runToolAgentConsult,
        runAgentConsult,
      });
      const bridge = controlBridge();
      owner.control.bindBridge(bridge);
      await activate(owner, closeProvider);
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
        consult(owner, "voice-change", "Change your voice and keep working");
        await waitForCalls(runToolAgentConsult);
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

describe("Talk client Gateway control teardown", () => {
  it("detaches accepted provider consultations without extending admission", async () => {
    const result = deferred({ text: "test cleanup" });
    const started = gate();
    const providerController = new AbortController();
    let acceptedSignal: AbortSignal | undefined;
    const runAgentConsult = vi.fn(async (_args: unknown, signal: AbortSignal) => {
      acceptedSignal = signal;
      started.resolve();
      return await result.promise;
    });
    const { owner } = createControlFixture({
      voiceSessionId: "voice-delegation-detach",
      connId: "conn-delegation-detach",
      runToolAgentConsult: runAgentConsult,
      runAgentConsult,
    });
    await activate(owner);
    const accepted = owner.runAgentConsult({
      prompt: "accepted task",
      signal: providerController.signal,
    });
    try {
      await started.promise;
      await owner.close();
      expect(acceptedSignal?.aborted).toBe(false);
      await expect(owner.runAgentConsult({ prompt: "late task" })).rejects.toThrow("closed");
      expect(runAgentConsult).toHaveBeenCalledOnce();
      providerController.abort(new Error("provider cancelled accepted work"));
      expect(acceptedSignal?.aborted).toBe(true);
      result.resolve({ text: "accepted task finished" });
      await expect(accepted).resolves.toEqual({ text: "accepted task finished" });
    } finally {
      result.resolve({ text: "test cleanup" });
      await accepted;
      await owner.close();
    }
  });

  it.each([
    { transition: "disconnect", rejectProvider: false },
    { transition: "disconnect", rejectProvider: true },
    { transition: "close", rejectProvider: false },
    { transition: "replacement", rejectProvider: false },
  ] as const)(
    "joins $transition teardown (provider rejects: $rejectProvider)",
    async ({ transition, rejectProvider }) => {
      const providerStarted = gate();
      const finishProvider = gate();
      const writeStarted = gate();
      const finishWrite = gate();
      const failure = new Error("provider close failed");
      const closeProvider = vi.fn(async () => {
        providerStarted.resolve();
        await finishProvider.promise;
        if (rejectProvider) {
          throw failure;
        }
      });
      const ownerWarn = vi.fn();
      const log = { warn: vi.fn() };
      const common = controlOptions({
        voiceSessionId: "voice-disconnect",
        connId: "conn-disconnect",
        context: controlContext(ownerWarn),
      });
      // This case reconciles its intentionally rejected close in the local finally.
      const owner = createRawOwner({
        ...common,
        flushTranscript: async () => {
          writeStarted.resolve();
          if (transition !== "disconnect") {
            await finishWrite.promise;
          }
        },
      });
      await activate(owner, closeProvider);
      let replacement: ControlOwner | undefined;
      if (transition === "replacement") {
        replacement = createRawOwner(common);
        await activate(replacement);
      } else if (transition === "close") {
        void owner.close();
      }
      if (transition !== "disconnect") {
        await providerStarted.promise;
      }
      cleanupTalkConnection(common.connId, log);
      await providerStarted.promise;
      let drained = false;
      const draining = drainGlobalSingletonLifecycleState("restart").then(() => {
        drained = true;
      });
      try {
        expect(() => owner.assertOpen()).toThrow("closed");
        await expect(owner.runAgentConsult({ prompt: "late task" })).rejects.toThrow("closed");
        await nextEventLoopTurn();
        expect(drained).toBe(false);
        if (transition === "disconnect") {
          expect(common.closeLogicalSession).not.toHaveBeenCalled();
        }
        finishProvider.resolve();
        await writeStarted.promise;
        if (transition !== "disconnect") {
          await nextEventLoopTurn();
          expect(drained).toBe(false);
          finishWrite.resolve();
        }
        await draining;
        expect(common.closeLogicalSession).toHaveBeenCalledOnce();
        expect(common.runToolAgentConsult).not.toHaveBeenCalled();
        expect(closeProvider).toHaveBeenCalledOnce();
        if (rejectProvider) {
          expect(ownerWarn).toHaveBeenCalledWith(
            "talk disconnected Gateway control close failed: provider close failed",
          );
          await expect(owner.close()).rejects.toBe(failure);
        } else {
          expect(ownerWarn).not.toHaveBeenCalled();
        }
        expect(log.warn).not.toHaveBeenCalled();
        cleanupTalkConnection(common.connId, log);
        await nextEventLoopTurn();
        expect(closeProvider).toHaveBeenCalledOnce();
        await expect(
          closeTalkClientGatewayControlSession({
            voiceSessionId: common.voiceSessionId,
            sessionKey: sessionTarget.sessionKey,
            connId: common.connId,
          }),
        ).resolves.toBe(false);
      } finally {
        finishProvider.resolve();
        finishWrite.resolve();
        await Promise.allSettled([owner.close(), replacement?.close(), draining]);
      }
    },
  );

  it("replaces only the physical transport while preserving the logical owner and run", async () => {
    const finish = deferred({ text: "test cleanup" });
    const runStarted = gate();
    let runSignal: AbortSignal | undefined;
    const runAgentConsult = vi.fn(async (_args: unknown, signal: AbortSignal) => {
      runSignal = signal;
      runStarted.resolve();
      return await finish.promise;
    });
    const {
      owner: first,
      bridge: firstBridge,
      closeProvider: closeFirst,
      options: common,
      appendTranscript,
      closeLogicalSession,
    } = createControlFixture({
      voiceSessionId: "voice-replacement",
      connId: "conn-replacement",
      runToolAgentConsult: runAgentConsult,
      runAgentConsult,
    });
    const secondBridge = { ...firstBridge, submitToolResult: vi.fn() };
    const closeSecond = vi.fn(async () => undefined);
    first.control.bindBridge(firstBridge);
    await activate(first, closeFirst);
    first.control.onTranscript?.("user", "first transport", true);
    consult(first, "replacement", "keep running");
    await runStarted.promise;

    const second = createTalkClientGatewayControlOwner(common);
    second.control.bindBridge(secondBridge);
    await activate(second, closeSecond);
    await vi.waitFor(() => expect(closeFirst).toHaveBeenCalledOnce());
    expect(() => first.control.bindControl?.({ sendUserMessage: vi.fn() })).toThrow("closed");
    first.control.onClose?.("completed");
    first.control.onTranscript?.("user", "stale transport", true);
    second.control.onTranscript?.("user", "second transport", true);

    expect(runSignal?.aborted).toBe(false);
    expect(closeLogicalSession).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(appendTranscript).toHaveBeenCalledTimes(2));
    const entryIds = appendTranscript.mock.calls.map(([entry]) => entry.entryId);
    expect(entryIds).toEqual([
      expect.stringMatching(/^gateway-[0-9a-f-]+-1$/),
      expect.stringMatching(/^gateway-[0-9a-f-]+-1$/),
    ]);
    expect(entryIds[0]).not.toBe(entryIds[1]);

    finish.resolve({ text: "done" });
    await vi.waitFor(() => expect(closeFirst).toHaveBeenCalledOnce());
    expect(firstBridge.submitToolResult).not.toHaveBeenCalled();
    await second.close();
    expect(() => second.control.bindBridge(secondBridge)).toThrow("closed");
    expect(closeSecond).toHaveBeenCalledOnce();
    expect(closeLogicalSession).toHaveBeenCalledOnce();
  });
});
