import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createReplyOperation,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import {
  beginSessionWorkAdmission,
  isCompetingSessionWorkAdmissionActive,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-lifecycle-admission.js";
import { runWithChatAbortExecution } from "../chat-abort-lifecycle-internal.js";
import { registerChatAbortController, type ChatAbortControllerEntry } from "../chat-abort.js";
import { waitForTerminalSessionRunSettlement } from "./session-run-settlement.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture() {
  const context = { chatAbortControllers: new Map<string, ChatAbortControllerEntry>() };
  const target = {
    context,
    storePath: "terminal-session-store",
    requestedKey: "global",
    canonicalKey: "global",
    sessionId: "terminal-session",
    agentId: "main",
    defaultAgentId: "main",
  };
  const register = (options?: {
    runId?: string;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    terminal?: boolean;
    kind?: "agent";
  }) => {
    const registration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: options?.runId ?? "terminal-run",
      sessionId: options?.sessionId ?? target.sessionId,
      sessionKey: options?.sessionKey ?? target.canonicalKey,
      agentId: options?.agentId ?? target.agentId,
      timeoutMs: 60_000,
      kind: options?.kind,
    });
    if (!registration.entry) {
      throw new Error("Missing registered run");
    }
    if (options?.terminal !== false) {
      registration.entry.projectSessionTerminalObservedAt = Date.now();
    }
    return registration;
  };
  const admit = () =>
    beginSessionWorkAdmission({
      scope: target.storePath,
      identities: [target.canonicalKey, target.sessionId],
      assertAllowed: () => {},
    });
  return { target, register, admit };
}

it.each([
  { label: "live run", terminal: false },
  { label: "another agent's terminal", agentId: "research" },
  { label: "another session's terminal", sessionKey: "other", sessionId: "other-session" },
])("leaves $label to the existing active-work gate", async (options) => {
  const { target, register, admit } = fixture();
  const registration = register(options);
  const admission = await admit();
  try {
    expect(await waitForTerminalSessionRunSettlement(target)).toBe(false);
    expect(isCompetingSessionWorkAdmissionActive(target.storePath, [target.sessionId])).toBe(true);
    expect(target.context.chatAbortControllers.size).toBe(1);
    expect(registration.controller.signal.aborted).toBe(false);
  } finally {
    registration.cleanup();
    admission.release();
  }
});

it("joins captured terminal owners without waiting for its caller or a successor admission", async () => {
  const { target, register, admit } = fixture();
  const registration = register();
  const caller = await admit();
  const reply = createReplyOperation({
    sessionKey: target.canonicalKey,
    sessionId: target.sessionId,
    agentId: target.agentId,
    resetTriggered: false,
  });
  reply.freezeAbort();
  let successor: Awaited<ReturnType<typeof admit>> | undefined;
  let settled = false;
  const waiting = caller.run(() => waitForTerminalSessionRunSettlement(target));
  void waiting.then(() => {
    settled = true;
  });
  try {
    successor = await admit();
    registration.cleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    reply.complete();
    expect(await waiting).toBe(true);
    expect(caller.isActive()).toBe(true);
    expect(successor.isActive()).toBe(true);
    expect(isCompetingSessionWorkAdmissionActive(target.storePath, [target.sessionId])).toBe(true);
  } finally {
    registration.cleanup();
    reply.complete();
    caller.release();
    successor?.release();
    await waiting;
  }
});

it.each(["timeout", "cancel"] as const)(
  "bounds terminal settlement on %s without cancelling the run",
  async (ending) => {
    const { target, register } = fixture();
    const registration = register();
    const controller = new AbortController();
    const waiting = waitForTerminalSessionRunSettlement({ ...target, signal: controller.signal });
    try {
      if (ending === "cancel") {
        const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
        controller.abort();
        await rejected;
      } else {
        await vi.advanceTimersByTimeAsync(SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS);
        expect(await waiting).toBe(false);
      }
      expect(registration.controller.signal.aborted).toBe(false);
    } finally {
      registration.cleanup();
      await waiting.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
    }
  },
);

it.each(["none", "chat", "reply"] as const)(
  "excludes only the in-band execution while joining another %s writer",
  async (otherOwner) => {
    const { target, register, admit } = fixture();
    const caller = register({ kind: "agent", runId: "caller-run" });
    const admission = await admit();
    const other = otherOwner === "chat" ? register() : undefined;
    const reply = createReplyOperation({
      sessionKey: target.canonicalKey,
      sessionId: target.sessionId,
      agentId: target.agentId,
      resetTriggered: false,
    });
    if (otherOwner !== "reply") {
      replyRunRegistry.bindSourceTurnId(reply, "caller-run");
    }
    reply.freezeAbort();
    let settled = false;
    const waiting = admission.run(() =>
      runWithChatAbortExecution(
        caller.entry,
        async () => {
          expect(await waitForTerminalSessionRunSettlement(target)).toBe(true);
          settled = true;
        },
        caller.cleanup,
      ),
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(otherOwner === "none");
      other?.cleanup();
      if (otherOwner === "reply") {
        reply.complete();
      }
      await waiting;
      expect(settled).toBe(true);
      expect(admission.isActive()).toBe(true);
    } finally {
      other?.cleanup();
      reply.complete();
      admission.release();
      await waiting;
      caller.cleanup();
    }
  },
);

it("refuses an acquired live admission without waiting for an older terminal owner", async () => {
  const { target, register, admit } = fixture();
  const terminal = register();
  const live = await admit();
  let result: boolean | undefined;
  const waiting = waitForTerminalSessionRunSettlement(target).then((value) => {
    result = value;
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe(false);
    expect(live.isActive()).toBe(true);
    expect(target.context.chatAbortControllers.size).toBe(1);
  } finally {
    terminal.cleanup();
    live.release();
    await waiting;
  }
});
