import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionEffect,
  captureSessionTarget,
  isCompetingSessionControllerWorkActive,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
  withSessionControllerOwner,
} from "../../sessions/session-controller.lifecycle.js";
import {
  releaseSessionControllerClaim,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { getRpcSource } from "../../sessions/session-controller.rpc-sources.js";
import { registerChatAbortController } from "../chat-abort.js";
import { claimRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { waitForTerminalSessionRunSettlement } from "./session-run-settlement.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture() {
  const target = {
    context: {},
    storePath: "terminal-session-store",
    requestedKey: "global",
    canonicalKey: "global",
    sessionId: "terminal-session",
    agentId: "main",
    defaultAgentId: "main",
  };
  const controllerTarget = captureSessionTarget({
    storeScope: target.storePath,
    sessionKey: target.canonicalKey,
    incarnation: target.sessionId,
    agentId: target.agentId,
  });
  const register = (options?: {
    runId?: string;
    storePath?: string;
    terminal?: boolean;
    kind?: "agent";
  }) => {
    const registration = registerChatAbortController({
      runId: options?.runId ?? "terminal-run",
      sessionId: target.sessionId,
      sessionKey: target.canonicalKey,
      agentId: target.agentId,
      target: captureSessionTarget({
        storeScope: options?.storePath ?? target.storePath,
        sessionKey: target.canonicalKey,
        incarnation: target.sessionId,
        agentId: target.agentId,
      }),
      timeoutMs: 60_000,
      kind: options?.kind,
    });
    if (!registration.registered) {
      throw new Error("Missing registered run");
    }
    onTestFinished(async () => {
      const claim = registration.entry.input.claim;
      claim?.operation?.complete();
      if (claim) {
        releaseSessionControllerClaim(claim);
      }
      registration.cleanup();
      retireSessionControllerInput(registration.entry.input);
      await registration.entry.input.settlement.promise;
    });
    if (options?.terminal !== false) {
      registration.entry.adapter.projectSessionTerminalObservedAt = Date.now();
    }
    return registration;
  };
  const admit = () => beginSessionEffect({ target: controllerTarget, assertAllowed: () => {} });
  return { target, controllerTarget, register, admit };
}

it("leaves live runs to the existing active-work gate", async () => {
  const { target, register, admit } = fixture();
  const registration = register({ terminal: false });
  const admission = await admit();
  try {
    expect(await waitForTerminalSessionRunSettlement(target)).toBe(false);
    expect(isCompetingSessionControllerWorkActive(target.storePath, [target.sessionId])).toBe(true);
    expect(getRpcSource("terminal-run")).toBe(registration.entry);
    expect(registration.controller.signal.aborted).toBe(false);
  } finally {
    registration.cleanup();
    admission.release();
  }
});

it.each(["pending", "persistence"] as const)(
  "does not treat unclaimed terminal %s as a discardable waiting input",
  async (kind) => {
    const { target, register } = fixture();
    const registration = register({ terminal: false });
    if (kind === "pending") {
      registration.entry.adapter.projectSessionTerminalPending = true;
    } else {
      registration.entry.adapter.projectSessionTerminalPersistence = Promise.resolve();
    }
    try {
      expect(await waitForTerminalSessionRunSettlement(target)).toBe(false);
      expect(getRpcSource("terminal-run")).toBe(registration.entry);
      expect(registration.controller.signal.aborted).toBe(false);
    } finally {
      registration.entry.adapter.projectSessionTerminalPending = false;
      registration.entry.adapter.projectSessionTerminalPersistence = undefined;
      registration.cleanup();
    }
  },
);

it("joins captured terminal owners without waiting for its caller or a successor admission", async () => {
  const { target, register, admit } = fixture();
  const registration = register();
  let release: Awaited<ReturnType<typeof claimRpcSourceForTest>> | undefined;
  let caller: Awaited<ReturnType<typeof admit>> | undefined;
  let successor: Awaited<ReturnType<typeof admit>> | undefined;
  let waiting: Promise<boolean> | undefined;
  try {
    release = await claimRpcSourceForTest(registration.entry);
    const reply = registration.entry.input.claim!.operation!;
    reply.freezeAbort();
    caller = await admit();
    let settled = false;
    waiting = caller.run(() => waitForTerminalSessionRunSettlement(target));
    void waiting.then(() => {
      settled = true;
    });
    successor = await admit();
    registration.cleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    release();
    expect(await waiting).toBe(true);
    expect(caller.isActive()).toBe(true);
    expect(successor.isActive()).toBe(true);
  } finally {
    release?.();
    registration.cleanup();
    caller?.release();
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
        await vi.advanceTimersByTimeAsync(SESSION_CONTROLLER_DRAIN_TIMEOUT_MS);
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

it.each([false, true])(
  "excludes only the in-band turn while joining another terminal source (other=%s)",
  async (hasOther) => {
    const { target, register, admit } = fixture();
    const caller = register({ kind: "agent", runId: "caller-run" });
    const release = await claimRpcSourceForTest(caller.entry);
    const operation = caller.entry.input.claim!.operation!;
    const admission = await admit();
    const other = hasOther ? register() : undefined;
    let settled = false;
    const waiting = admission.run(() =>
      withSessionControllerOwner(operation, async () => {
        expect(await waitForTerminalSessionRunSettlement(target)).toBe(true);
        settled = true;
      }),
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(!hasOther);
      other?.cleanup();
      await waiting;
      expect(settled).toBe(true);
      expect(admission.isActive()).toBe(true);
    } finally {
      other?.cleanup();
      release();
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
    expect(getRpcSource("terminal-run")).toBe(terminal.entry);
  } finally {
    terminal.cleanup();
    live.release();
    await waiting;
  }
});

it.each(["store", "Gateway"] as const)(
  "ignores another %s's source with the same logical identity",
  async (dimension) => {
    const { target, register } = fixture();
    const registration = register({
      terminal: false,
      storePath: dimension === "store" ? "other-store" : undefined,
    });
    if (dimension === "Gateway") {
      bindGatewayContextResolver(registration.entry.input, () => undefined);
    }
    try {
      expect(await waitForTerminalSessionRunSettlement(target)).toBe(true);
      expect(registration.controller.signal.aborted).toBe(false);
    } finally {
      registration.cleanup();
    }
  },
);
