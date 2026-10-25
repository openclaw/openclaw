import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionEffect,
  captureSessionTarget,
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
  const cleanups: (() => void)[] = [];
  const waits: Promise<unknown>[] = [];
  const track = <T>(promise: Promise<T>) => {
    waits.push(promise);
    void promise.catch(() => {});
    return promise;
  };
  onTestFinished(async () => {
    for (const cleanup of cleanups.toReversed()) {
      cleanup();
    }
    await Promise.allSettled(waits);
  });
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
        ...controllerTarget,
        storeScope: options?.storePath ?? target.storePath,
      }),
      timeoutMs: 60_000,
      kind: options?.kind,
    });
    if (!registration.registered) {
      throw new Error("Missing registered run");
    }
    cleanups.push(() => {
      registration.entry.adapter.projectSessionTerminalPending = false;
      registration.entry.adapter.projectSessionTerminalPersistence = undefined;
      const claim = registration.entry.input.claim;
      claim?.operation?.complete();
      if (claim) {
        releaseSessionControllerClaim(claim);
      }
      registration.cleanup();
      retireSessionControllerInput(registration.entry.input);
    });
    track(registration.entry.input.settlement.promise);
    if (options?.terminal !== false) {
      registration.entry.adapter.projectSessionTerminalObservedAt = Date.now();
    }
    return registration;
  };
  const admit = async () => {
    const admission = await beginSessionEffect({
      target: controllerTarget,
      assertAllowed: () => {},
    });
    cleanups.push(() => admission.release());
    return admission;
  };
  return { target, register, admit, track };
}

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
    expect(await waitForTerminalSessionRunSettlement(target)).toBe(false);
    expect(getRpcSource("terminal-run")).toBe(registration.entry);
    expect(registration.controller.signal.aborted).toBe(false);
  },
);

it("joins captured terminal owners without waiting for its caller or a successor admission", async () => {
  const { target, register, admit, track } = fixture();
  const registration = register();
  const release = await claimRpcSourceForTest(registration.entry);
  registration.entry.input.claim!.operation!.freezeAbort();
  const caller = await admit();
  let settled = false;
  const waiting = track(caller.run(() => waitForTerminalSessionRunSettlement(target)));
  void waiting.then(() => {
    settled = true;
  });
  const successor = await admit();
  registration.cleanup();
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  release();
  expect(await waiting).toBe(true);
  expect(caller.isActive()).toBe(true);
  expect(successor.isActive()).toBe(true);
});

it.each(["timeout", "cancel"] as const)(
  "bounds terminal settlement on %s without cancelling the run",
  async (ending) => {
    const { target, register, track } = fixture();
    const registration = register();
    const controller = new AbortController();
    const waiting = track(
      waitForTerminalSessionRunSettlement({ ...target, signal: controller.signal }),
    );
    if (ending === "cancel") {
      const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await rejected;
    } else {
      await vi.advanceTimersByTimeAsync(SESSION_CONTROLLER_DRAIN_TIMEOUT_MS);
      expect(await waiting).toBe(false);
    }
    expect(registration.controller.signal.aborted).toBe(false);
  },
);

it.each([false, true])(
  "excludes only the in-band turn while joining another terminal source (other=%s)",
  async (hasOther) => {
    const { target, register, admit, track } = fixture();
    const caller = register({ kind: "agent", runId: "caller-run" });
    const release = await claimRpcSourceForTest(caller.entry);
    const operation = caller.entry.input.claim!.operation!;
    const admission = await admit();
    const other = hasOther ? register() : undefined;
    let settled = false;
    const waiting = track(
      admission.run(() =>
        withSessionControllerOwner(operation, async () => {
          expect(await waitForTerminalSessionRunSettlement(target)).toBe(true);
          settled = true;
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(!hasOther);
    other?.cleanup();
    await waiting;
    expect(settled).toBe(true);
    expect(admission.isActive()).toBe(true);
    release();
  },
);

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
    expect(await waitForTerminalSessionRunSettlement(target)).toBe(true);
    expect(registration.controller.signal.aborted).toBe(false);
  },
);
