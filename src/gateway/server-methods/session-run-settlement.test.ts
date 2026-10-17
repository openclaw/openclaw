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

const identity = { sessionId: "terminal-session", sessionKey: "global", agentId: "main" };
const target = {
  ...identity,
  context: { chatAbortControllers: new Map<string, ChatAbortControllerEntry>() },
  storePath: "terminal-session-store",
  requestedKey: "global",
  canonicalKey: "global",
  defaultAgentId: "main",
};
const releases: Array<() => void> = [];
const pending: Promise<boolean>[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  try {
    for (const release of releases.splice(0)) {
      release();
    }
    await Promise.allSettled(pending.splice(0));
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    target.context.chatAbortControllers.clear();
    vi.useRealTimers();
  }
});

function register(options: { runId?: string; kind?: "agent" } = {}) {
  const registration = registerChatAbortController({
    chatAbortControllers: target.context.chatAbortControllers,
    runId: "terminal-run",
    ...identity,
    timeoutMs: 60_000,
    ...options,
  });
  if (!registration.entry) {
    throw new Error("Missing registered run");
  }
  registration.entry.projectSessionTerminalObservedAt = Date.now();
  releases.push(registration.cleanup);
  return registration;
}

async function admit() {
  const admission = await beginSessionWorkAdmission({
    scope: target.storePath,
    identities: [target.canonicalKey, target.sessionId],
    assertAllowed: () => {},
  });
  releases.push(() => admission.release());
  return admission;
}

function frozenReply(sourceTurnId?: string) {
  const reply = createReplyOperation({ ...identity, resetTriggered: false });
  if (sourceTurnId) {
    replyRunRegistry.bindSourceTurnId(reply, sourceTurnId);
  }
  reply.freezeAbort();
  releases.push(() => reply.complete());
  return reply;
}

function settle(signal?: AbortSignal) {
  const waiting = waitForTerminalSessionRunSettlement({ ...target, signal });
  pending.push(waiting);
  return waiting;
}

it("refuses a live admission before inspecting an older terminal owner", async () => {
  const registration = register();
  const admission = await admit();
  let result: boolean | undefined;
  const waiting = settle().then((value) => {
    result = value;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(result).toBe(false);
  expect(admission.isActive()).toBe(true);
  expect(isCompetingSessionWorkAdmissionActive(target.storePath, [target.sessionId])).toBe(true);
  expect(target.context.chatAbortControllers.size).toBe(1);
  expect(registration.controller.signal.aborted).toBe(false);
  await waiting;
});

it("joins captured terminal owners without waiting for its caller or a successor admission", async () => {
  const registration = register();
  const caller = await admit();
  const reply = frozenReply();
  let settled = false;
  const waiting = caller.run(settle);
  void waiting.then(() => {
    settled = true;
  });
  const successor = await admit();
  registration.cleanup();
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  reply.complete();
  expect(await waiting).toBe(true);
  expect(caller.isActive()).toBe(true);
  expect(successor.isActive()).toBe(true);
  expect(isCompetingSessionWorkAdmissionActive(target.storePath, [target.sessionId])).toBe(true);
});

it.each(["timeout", "cancel"])("bounds %s without cancelling the run", async (ending) => {
  const registration = register();
  const controller = new AbortController();
  const waiting = settle(controller.signal);
  if (ending === "cancel") {
    const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
  } else {
    await vi.advanceTimersByTimeAsync(SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS);
    expect(await waiting).toBe(false);
  }
  expect(registration.controller.signal.aborted).toBe(false);
});

it.each(["none", "chat", "reply"])("joins %s but excludes the caller", async (otherOwner) => {
  const caller = register({ kind: "agent", runId: "caller-run" });
  const admission = await admit();
  const other = otherOwner === "chat" ? register() : undefined;
  const reply = frozenReply(otherOwner !== "reply" ? "caller-run" : undefined);
  let settled = false;
  const finish = async () => {
    settled = await settle();
  };
  const waiting = admission.run(() =>
    runWithChatAbortExecution(caller.entry, finish, caller.cleanup),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(otherOwner === "none");
  other?.cleanup();
  if (otherOwner === "reply") {
    reply.complete();
  }
  await waiting;
  expect(settled).toBe(true);
  expect(admission.isActive()).toBe(true);
});
