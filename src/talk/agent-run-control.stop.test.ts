import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  detachActiveEmbeddedRun as detachEmbeddedRun,
  attachActiveEmbeddedRun as attachEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../agents/embedded-agent-runner/runs.test-support.js";
import { registerChatAbortController } from "../gateway/chat-abort.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { testing as replyTesting } from "../sessions/session-controller.test-support.js";
import {
  controlRealtimeVoiceAgentRun as controlRun,
  controlTalkAgentRun,
} from "./agent-run-control.js";

const sessionKey = "agent:main:discord-voice";
const turn = { sessionKey, sessionId: "voice-session", agentId: "main", storePath: "/tmp/talk" };
const { sessionId, agentId } = turn;
type ControlParams = Parameters<typeof controlRun>[0];
const control = (params: Omit<ControlParams, "sessionKey">) =>
  controlRun({ sessionKey, ...params });
function target(runId: string, signal: AbortSignal, current = () => !signal.aborted) {
  return {
    runId,
    signal,
    isCurrent: (id?: string) => current() && (id === undefined || id === sessionId),
  };
}

function attachRun(op: ReplyOperation, handle: Parameters<typeof attachEmbeddedRun>[1]) {
  const attachment = attachEmbeddedRun(sessionId, handle, sessionKey, undefined, agentId, op);
  return () => detachEmbeddedRun(sessionId, handle, undefined, undefined, undefined, attachment);
}

function withVoiceTurn(run: (op: ReplyOperation) => Promise<void>, storePath = turn.storePath) {
  return withSessionTurn({ ...turn, storePath }, async (op) => {
    if (!op) {
      throw new Error("expected an admitted voice turn");
    }
    await run(op);
  });
}

afterEach(() => {
  replyTesting.resetSessionControllerForTest();
});

it.each(["current", "aborted", "revoked"] as const)(
  "controls an exact native run with a separate caller lifetime (%s)",
  (lifetime) =>
    withVoiceTurn(async (op) => {
      const cancel = vi.fn();
      const handle = {
        ...createEmbeddedRunHandle({ runId: "native" }),
        kind: "embedded" as const,
        cancel,
      };
      const detach = attachRun(op, handle);
      const caller = new AbortController();
      if (lifetime === "aborted") {
        caller.abort();
      }
      const runTarget = target(handle.runId!, caller.signal, () => lifetime !== "revoked");
      const active = lifetime === "current";
      try {
        const statusResult = await control({ runTarget, text: "status" });
        expect(statusResult).toMatchObject({ ok: true, mode: "status", active });
        const cancelled = await control({ runTarget, text: "cancel" });
        expect(cancelled).toMatchObject({ ok: active, mode: "cancel", active, aborted: active });
        expect(cancel.mock.calls).toEqual(active ? [["user_abort"]] : []);
        expect(op.abortSignal.aborted).toBe(active);
      } finally {
        detach();
      }
    }),
);

it("does not redirect an unclaimed RPC source to a matching native run ID", () =>
  withVoiceTurn(async (op) => {
    const runId = "rpc";
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId, abort });
    const detach = attachRun(op, handle);
    const registration = registerChatAbortController({
      ...turn,
      runId,
      target: captureSessionTarget({
        storeScope: `${turn.storePath}.source`,
        sessionKey,
        agentId,
        incarnation: sessionId,
      }),
      timeoutMs: 60_000,
    });
    try {
      expect(registration.registered).toBe(true);
      expect(
        await control({
          text: "cancel",
          runTarget: { runId, signal: registration.controller.signal, isCurrent: () => true },
        }),
      ).toMatchObject({ ok: false, active: false, aborted: false, reason: "no_active_run" });
      expect(abort).not.toHaveBeenCalled();
      expect(op.abortSignal.aborted).toBe(false);
    } finally {
      registration.cleanup();
      detach();
    }
  }));

it.each(["owner fallback", "callback refusal"] as const)(
  "cancels an exact built-in owner through %s",
  async (route) => {
    const started = createDeferred<AbortSignal>();
    const finish = createDeferred();
    const active = withVoiceTurn(async (op) => {
      started.resolve(op.abortSignal);
      await finish.promise;
    });
    const signal = await started.promise;
    const cancelRun = route === "callback refusal" ? vi.fn(async () => false) : undefined;
    try {
      const result = await control({
        text: "stop",
        mode: "cancel",
        runTarget: target("exact", signal),
        cancelRun,
      });

      const cancelled = route === "owner fallback";
      expect(result).toMatchObject({
        ok: cancelled,
        mode: "cancel",
        sessionId,
        aborted: cancelled,
      });
      expect(signal.aborted).toBe(cancelled);
      if (cancelRun) {
        expect(cancelRun).toHaveBeenCalledExactlyOnceWith("exact");
        expect(result.reason).toBe("abort_rejected");
      }
    } finally {
      finish.resolve();
      await active;
    }
  },
);

it("aborts the active turn, keeps waiting inputs, and fires command:stop once", async () => {
  const hook = vi.fn();
  registerInternalHook("command:stop", hook);
  const started = createDeferred();
  const active = withSessionTurn(turn, async (_operation, signal) => {
    started.resolve();
    await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("turn aborted")), { once: true });
    });
  });
  void active.catch(() => {});
  await started.promise;
  const waitingRan = vi.fn();
  const waiting = withSessionTurn(turn, async () => waitingRan());

  try {
    const result = await control({ text: "stop", mode: "cancel" });

    expect(result).toMatchObject({ ok: true, mode: "cancel", aborted: true });
    await expect(active).rejects.toBeDefined();
    await waiting;
    expect(waitingRan).toHaveBeenCalledOnce();
    expect(hook).toHaveBeenCalledOnce();
    expect(hook.mock.calls[0]?.[0]).toMatchObject({
      type: "command",
      action: "stop",
      sessionKey,
      context: { sessionId: "voice-session", commandSource: "talk" },
    });
  } finally {
    unregisterInternalHook("command:stop", hook);
  }
});

it.each(["controller signal", "native run"] as const)(
  "steers and cancels the exact %s when physical stores share a session ID",
  async (selection) => {
    const finish = createDeferred();
    const firstMessages: string[] = [];
    const secondMessages: string[] = [];
    const start = (storePath: string, runId: string, messages: string[]) => {
      const ready = createDeferred<ReplyOperation>();
      const running = withVoiceTurn(async (op) => {
        await op.bindToolAuthoritySnapshotAsync({
          fingerprint: () => "voice-policy",
          fingerprintAsync: async () => "voice-policy",
          project: () => "voice-policy",
          projectAsync: async () => "voice-policy",
        });
        await op.bindToolAuthorityRouteAsync({ provider: "synthetic", model: "test" });
        const handle = {
          ...createEmbeddedRunHandle({
            runId,
            guarded: true,
            queueMessage: async (text) => {
              messages.push(text);
            },
          }),
          kind: "embedded" as const,
          cancel: () => {},
        };
        const detach = selection === "native run" ? attachRun(op, handle) : undefined;
        if (selection === "controller signal") {
          op.attachBackend(handle);
        }
        op.setPhase("running");
        ready.resolve(op);
        try {
          await finish.promise;
        } finally {
          detach?.();
        }
      }, storePath);
      return {
        ready: awaitGateBeforeSettlement(ready.promise, running, "Turn ended before admission"),
        running,
      };
    };
    const first = start("/synthetic/first", "first", firstMessages);
    const second = start("/synthetic/second", "second", secondMessages);
    try {
      const [firstOp, secondOp] = await Promise.all([first.ready, second.ready]);
      const runTarget = {
        runId: "first",
        signal: selection === "native run" ? new AbortController().signal : firstOp.abortSignal,
        isCurrent: () => !firstOp.abortSignal.aborted,
      };
      const steered = await control({
        runTarget,
        mode: "steer",
        text: "Steer first",
        getToolAuthorityOverlay: () => ({
          senderIsOwner: true,
          disableTools: false,
          traceAuthorized: false,
        }),
      });
      expect(steered, JSON.stringify(steered)).toMatchObject({ ok: true, queued: true, sessionId });
      expect([firstMessages, secondMessages]).toEqual([["Steer first"], []]);
      await expect(control({ runTarget, mode: "cancel", text: "stop" })).resolves.toMatchObject({
        ok: true,
        aborted: true,
      });
      expect([firstOp.abortSignal.aborted, secondOp.abortSignal.aborted]).toEqual([true, false]);
    } finally {
      finish.resolve();
      await Promise.all([first.running, second.running]);
    }
  },
);

it.each(["allowed", "wrong caller", "revoked", "reassigned"] as const)(
  "rereads async caller authority for the exact run before enqueue (%s)",
  (scenario) =>
    withVoiceTurn(async (op) => {
      const project = (overlay: { senderIsOwner: boolean }) =>
        overlay.senderIsOwner ? "voice-policy" : "guest-policy";
      await op.bindToolAuthoritySnapshotAsync({
        fingerprint: () => "voice-policy",
        fingerprintAsync: async () => "voice-policy",
        project,
        projectAsync: async (overlay) => project(overlay),
      });
      await op.bindToolAuthorityRouteAsync({ provider: "synthetic", model: "test" });
      const messages: string[] = [];
      const handle = {
        ...createEmbeddedRunHandle({
          runId: "voice",
          guarded: true,
          queueMessage: async (text) => {
            messages.push(text);
          },
        }),
        kind: "embedded" as const,
        cancel: () => {},
      };
      const detach = attachRun(op, handle);
      op.setPhase("running");
      let current = true;
      let reads = 0;
      try {
        const result = await controlTalkAgentRun({
          sessionKey,
          runTarget: target("voice", op.abortSignal, () => current && !op.abortSignal.aborted),
          mode: "steer",
          text: "Use the release branch",
          getToolAuthorityOverlayAsync: async () => {
            reads += 1;
            // Selection reads current authority; the injection's own read observes the change.
            if (reads > 1 && scenario === "revoked") {
              throw new Error("Caller access changed");
            }
            if (reads > 1 && scenario === "reassigned") {
              current = false;
            }
            return {
              senderIsOwner: scenario !== "wrong caller",
              disableTools: false,
              traceAuthorized: false,
            };
          },
        });
        expect(reads).toBeGreaterThan(1);
        expect(messages).toEqual(scenario === "allowed" ? ["Use the release branch"] : []);
        expect(result).toMatchObject(
          scenario === "allowed"
            ? { ok: true, queued: true }
            : scenario === "wrong caller"
              ? { ok: false, queued: false, reason: "tool_authority_mismatch" }
              : { ok: false },
        );
      } finally {
        detach();
      }
    }),
);
