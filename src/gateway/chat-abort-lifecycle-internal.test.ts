import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import {
  captureSessionControllerSourceSettlement,
  trackSessionControllerSourceWork,
} from "../sessions/session-controller.mailbox.js";
import { getRpcSourceIdentity } from "../sessions/session-controller.rpc-sources.js";
import {
  resetSessionControllerStateForTest,
  rpcSourceTesting,
} from "../sessions/session-lifecycle-admission.test-support.js";
import {
  bindChatAbortTerminalDispatch,
  captureChatAbortRegistrationGuard,
  markChatAbortTerminalPersistenceError,
  waitForChatAbortControllerRemoval,
  waitForChatAbortTerminalPersistence,
} from "./chat-abort-lifecycle-internal.js";
import { abortChatRunById, registerChatAbortController, type ChatAbortOps } from "./chat-abort.js";
import { createChatRunState } from "./server-chat-state.js";

afterEach(() => resetSessionControllerStateForTest());

function registeredRun(
  options: {
    runId?: string;
    sessionKey?: string;
    sessionId?: string;
    onRemoved?: () => void;
    sourceWork?: Promise<unknown>;
  } = {},
) {
  const runId = options.runId ?? "terminal-drain";
  const sessionKey = options.sessionKey ?? "agent:main:terminal";
  const sessionId = options.sessionId ?? "terminal-session";
  const registration = registerChatAbortController({
    target: captureSessionTarget({
      storeScope: `/synthetic/${runId}/${sessionKey}/sessions`,
      sessionKey,
      incarnation: sessionId,
    }),
    runId,
    sessionId,
    sessionKey,
    timeoutMs: 60_000,
    onRemoved: options.onRemoved,
    sourceWork: options.sourceWork,
  });
  if (!registration.entry) {
    throw new Error("Expected a registered run");
  }
  const entry = registration.entry;
  const drain = () =>
    waitForChatAbortControllerRemoval({
      targets: [{ runId, entry }],
      timeoutMs: 1_000,
    });
  const abort = (broadcast: ChatAbortOps["broadcast"] = () => {}) =>
    abortChatRunById(
      {
        chatRunState: createChatRunState(),
        removeChatRun: () => undefined,
        agentRunSeq: new Map(),
        broadcast,
        nodeSendToSession: () => {},
      },
      { runId, sessionKey: getRpcSourceIdentity(entry).sessionKey },
    );
  return { runId, entry, registration, drain, abort };
}

it.each(
  ["settled", "pending", "writing", "failed"].flatMap((state) =>
    [false, true].map((alreadyRemoved) => ({ state, alreadyRemoved })),
  ),
)(
  "checks $state terminal ownership when alreadyRemoved=$alreadyRemoved",
  async ({ state, alreadyRemoved }) => {
    const { runId, entry, drain } = registeredRun();
    if (state === "pending") {
      entry.adapter.projectSessionTerminalPending = true;
    } else if (state === "writing") {
      entry.adapter.projectSessionTerminalPersistence = new Promise<void>(() => {});
    } else if (state === "failed") {
      markChatAbortTerminalPersistenceError(entry, new Error("terminal write failed"));
    }
    if (alreadyRemoved) {
      rpcSourceTesting.deleteExpected(runId, entry);
    }
    const result = drain();
    rpcSourceTesting.deleteExpected(runId, entry);
    expect(await result).toBe(state === "settled");
  },
);

it("finishes an empty selection without draining unrelated registrations", async () => {
  const { runId } = registeredRun();
  expect(await waitForChatAbortControllerRemoval({ targets: [], timeoutMs: 1_000 })).toBe(true);
  expect(rpcSourceTesting.has(runId)).toBe(true);
});

it("releases the reserved terminal owner when no lifecycle subscriber adopts it", async () => {
  const { runId, drain, abort } = registeredRun();
  const result = drain();
  expect(abort()).toEqual({ aborted: true });
  expect(await result).toBe(true);
  expect(rpcSourceTesting.has(runId)).toBe(false);
});

it("marks captured cancellation without publishing over a replacement", () => {
  const { runId, entry, abort } = registeredRun();
  let replacement: ReturnType<typeof registeredRun> | undefined;
  entry.input.abortSignal.addEventListener("abort", () => {
    rpcSourceTesting.deleteExpected(runId, entry);
    replacement = registeredRun({ runId, sessionKey: "agent:main:replacement" });
  });
  const broadcast = vi.fn();
  expect(abort(broadcast)).toEqual({ aborted: true });
  expect(broadcast).not.toHaveBeenCalled();
  expect(entry.input.abortSignal.aborted).toBe(true);
  expect(entry.adapter.terminalOutcomeObserved).toBe(true);
  expect(replacement).toBeDefined();
  expect(replacement?.entry.input.abortSignal.aborted).toBe(false);
  expect(replacement?.entry.adapter.terminalOutcomeObserved).toBeUndefined();
  expect(rpcSourceTesting.get(runId)).toBe(replacement?.entry);
});

it.each([true, false])(
  "binds retired terminal publication to its Gateway (same=%s)",
  (sameGateway) => {
    const resolveGatewayContext = () => undefined;
    const resolveForeign = () => undefined;
    const original = withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
      registeredRun(),
    );
    const isCurrent = captureChatAbortRegistrationGuard([
      { runId: original.runId, entry: original.entry },
    ]);
    expect(isCurrent()).toBe(true);
    rpcSourceTesting.deleteExpected(original.runId, original.entry);
    expect(isCurrent()).toBe(true);
    withPluginRuntimeGatewayContextResolver(
      sameGateway ? resolveGatewayContext : resolveForeign,
      () => registeredRun({ runId: original.runId, sessionKey: "agent:other:replacement" }),
    );
    expect(isCurrent()).toBe(!sameGateway);
  },
);

it.each(["fulfilled", "rejected"] as const)(
  "settles promise-only source work after it is %s",
  async (outcome) => {
    const onRemoved = vi.fn();
    const { runId, entry, registration } = registeredRun({ onRemoved });
    const persistence = createDeferred();
    entry.adapter.projectSessionTerminalPersistence = persistence.promise;
    registration.cleanup();
    expect(rpcSourceTesting.get(runId)).toBe(entry);
    expect(onRemoved).not.toHaveBeenCalled();
    const failure = new Error("terminal write failed");
    const sourceSettlement = captureSessionControllerSourceSettlement(entry.input);
    const sourceOutcome =
      outcome === "fulfilled"
        ? expect(sourceSettlement).resolves.toBeUndefined()
        : expect(sourceSettlement).rejects.toBe(failure);
    if (outcome === "fulfilled") {
      persistence.resolve();
    } else {
      persistence.reject(failure);
    }
    await sourceOutcome;
    if (outcome === "rejected") {
      await expect(waitForChatAbortTerminalPersistence(entry)).rejects.toBe(failure);
    }
    expect(rpcSourceTesting.has(runId)).toBe(false);
    expect(onRemoved).toHaveBeenCalledOnce();
  },
);

it("joins accepted dispatch before reporting an already-rejected prepared write", async ({
  signal,
}) => {
  const { entry, registration } = registeredRun();
  const dispatch = createDeferred();
  const persistenceFailure = new Error("prepared terminal write failed");
  const persistence = Promise.reject(persistenceFailure);
  void persistence.catch(() => {});
  entry.adapter.projectSessionTerminalPersistence = persistence;
  bindChatAbortTerminalDispatch([entry], dispatch.promise, {
    failure: { error: new Error("accepted terminal dispatch failed") },
  });
  const observed = vi.fn();
  const waiter = waitForChatAbortTerminalPersistence(entry).then(
    () => observed({ ok: true }),
    (error: unknown) => observed({ ok: false, error }),
  );
  try {
    // Give an early rejection a complete event-loop turn while dispatch is still owned.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(observed).not.toHaveBeenCalled();
    dispatch.resolve();
    await withinTest(waiter, signal);
    expect(observed).toHaveBeenCalledExactlyOnceWith({ ok: false, error: persistenceFailure });
  } finally {
    dispatch.resolve();
    await Promise.allSettled([waiter]);
    registration.cleanup();
    await Promise.allSettled([entry.input.settlement.promise]);
  }
});

it.for(["fulfilled", "rejected"] as const)(
  "keeps the captured %s write when persistence is replaced during dispatch",
  async (outcome, { signal }) => {
    const { entry, registration } = registeredRun();
    const dispatch = createDeferred();
    const prepared = createDeferred();
    const replacement = createDeferred();
    const failure = new Error("captured terminal write failed");
    void prepared.promise.catch(() => {});
    entry.adapter.projectSessionTerminalPersistence = prepared.promise;
    bindChatAbortTerminalDispatch([entry], dispatch.promise, {});
    const waiter = waitForChatAbortTerminalPersistence(entry);
    void waiter.catch(() => {});
    entry.adapter.projectSessionTerminalPersistence = replacement.promise;
    try {
      if (outcome === "fulfilled") {
        prepared.resolve();
      } else {
        prepared.reject(failure);
      }
      dispatch.resolve();
      if (outcome === "fulfilled") {
        await expect(withinTest(waiter, signal)).resolves.toBeUndefined();
      } else {
        await expect(withinTest(waiter, signal)).rejects.toBe(failure);
      }
      expect(entry.adapter.projectSessionTerminalPersistence).toBe(replacement.promise);
    } finally {
      dispatch.resolve();
      prepared.resolve();
      replacement.resolve();
      await Promise.allSettled([waiter]);
      registration.cleanup();
      await Promise.allSettled([entry.input.settlement.promise]);
    }
  },
);

it.each(["fulfilled", "rejected"] as const)(
  "does not retire a replacement persistence owner when an older write is %s",
  async (outcome) => {
    const { entry, registration } = registeredRun();
    const previous = createDeferred();
    const current = createDeferred();
    entry.adapter.projectSessionTerminalPersistence = previous.promise;
    registration.cleanup();
    entry.adapter.projectSessionTerminalPersistence = current.promise;
    if (outcome === "fulfilled") {
      previous.resolve();
    } else {
      previous.reject(new Error("older terminal write failed"));
    }
    await previous.promise.catch(() => {});
    await Promise.resolve();
    expect(entry.adapter.projectSessionTerminalPersistence).toBe(current.promise);
    const joined = waitForChatAbortTerminalPersistence(entry);
    current.resolve();
    await expect(joined).resolves.toBeUndefined();
  },
);

it.each(["settled", "pending", "writing", "failed", "dispatch-failed"] as const)(
  "retains %s terminal ownership while joining the raw producer",
  async (state) => {
    const producer = createDeferred();
    const { entry, registration } = registeredRun({ sourceWork: producer.promise });
    const write = createDeferred();
    if (state === "pending") {
      entry.adapter.projectSessionTerminalPending = true;
    }
    if (state === "writing") {
      entry.adapter.projectSessionTerminalPersistence = write.promise;
    }
    if (state === "failed") {
      markChatAbortTerminalPersistenceError(entry, new Error("write failed"));
    }
    if (state === "dispatch-failed") {
      bindChatAbortTerminalDispatch([entry], Promise.resolve(), {
        failure: { error: new Error("terminal dispatch failed") },
      });
    }
    registration.cleanup();
    let drained = false;
    const settled = captureSessionControllerSourceSettlement(entry.input).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    entry.adapter.projectSessionTerminalPending = false;
    entry.adapter.projectSessionTerminalPersistence = undefined;
    markChatAbortTerminalPersistenceError(entry, undefined);
    write.resolve();
    producer.resolve();
    await settled;
    expect(drained).toBe(true);
  },
);

it("waits for every selected source without draining unrelated registrations", async () => {
  const first = registeredRun({ runId: "first-tail" });
  const sibling = registeredRun({ runId: "sibling-tail" });
  const unrelated = registeredRun({ runId: "unrelated-tail" });
  const producer = createDeferred();
  trackSessionControllerSourceWork(sibling.entry.input, producer.promise);
  let drained = false;
  const result = waitForChatAbortControllerRemoval({
    targets: [
      { runId: first.runId, entry: first.entry },
      { runId: sibling.runId, entry: sibling.entry },
    ],
    timeoutMs: 1_000,
  }).then((settled) => {
    drained = true;
    return settled;
  });
  first.registration.cleanup();
  sibling.registration.cleanup();
  await first.entry.input.settlement.promise;
  expect(drained).toBe(false);
  expect(rpcSourceTesting.get(unrelated.runId)).toBe(unrelated.entry);
  producer.resolve();
  expect(await result).toBe(true);
  expect(rpcSourceTesting.has(first.runId)).toBe(false);
  expect(rpcSourceTesting.has(sibling.runId)).toBe(false);
  expect(rpcSourceTesting.get(unrelated.runId)).toBe(unrelated.entry);
  unrelated.registration.cleanup();
});

describe("delegated abort authority", () => {
  beforeEach(resetAgentRunRegistryForTest);

  function createAuthorityAbortFixture(runId: string, sessionless = false) {
    const sessionKey = "agent:main:authority";
    const operationalRunInstance = createOperationalRunInstanceRef(runId);
    rpcSourceTesting.clear();
    const registration = registerChatAbortController({
      runId,
      sessionId: `session-${runId}`,
      sessionKey: sessionless ? undefined : sessionKey,
      target: !sessionless
        ? captureSessionTarget({
            storeScope: `/synthetic/authority/${runId}`,
            sessionKey,
            incarnation: `session-${runId}`,
          })
        : undefined,
      timeoutMs: 60_000,
      operationalRunInstance,
    });
    onTestFinished(registration.cleanup);
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    if (registration.registered) {
      registration.bindAgentRunDelegatedAuthority(authority);
    }
    const chatRunState = createChatRunState();
    const ops: ChatAbortOps = {
      chatRunState,
      removeChatRun: vi.fn(() => undefined),
      agentRunSeq: new Map(),
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
    };
    const abort = (
      options: Omit<Parameters<typeof abortChatRunById>[1], "runId" | "sessionKey"> = {},
    ) => abortChatRunById(ops, { runId, sessionKey, ...options });
    return { authority, operationalRunInstance, chatRunState, ops, registration, abort };
  }

  it("binds delegated authority only to the exact operational instance object", () => {
    const { authority, operationalRunInstance, registration } =
      createAuthorityAbortFixture("run-exact-authority");

    expect(registration.entry?.adapter.agentRunDelegatedAuthority).toBe(authority);
    expect(registration.entry?.adapter.operationalRunInstance).toBe(operationalRunInstance);
    expect(() =>
      registration.bindAgentRunDelegatedAuthority({
        ...authority,
        operationalRunInstance: Object.freeze({ ...operationalRunInstance }),
      }),
    ).toThrow("does not belong to this exact RPC source");

    registration.cleanup();
    expect(validateAgentRunDelegatedAuthority(authority)).toBe(false);
  });

  it("leaves sessionless authority with the outer admission owner", () => {
    const { registration, authority } = createAuthorityAbortFixture("run-sessionless", true);
    const unrelatedInstance = createOperationalRunInstanceRef("run-unrelated-authority");
    const unrelatedAuthority = claimAgentRunDelegatedAuthority(unrelatedInstance);

    expect(registration.registered).toBe(false);
    expect(rpcSourceTesting.size).toBe(0);
    const authorities = [authority, unrelatedAuthority];
    for (const delegated of authorities) {
      expect(() => registration.bindAgentRunDelegatedAuthority(delegated)).toThrow(
        "Unregistered source cannot own a projected run authority",
      );
    }
    registration.cleanup();
    expect(authorities.map((delegated) => validateAgentRunDelegatedAuthority(delegated))).toEqual([
      true,
      true,
    ]);
    expect(authorities.map(releaseAgentRunDelegatedAuthority)).toEqual([true, true]);
  });

  it("prepares before cancellation and publishes only after exact authority retirement", () => {
    const runId = "run-authority-abort";
    const { authority, chatRunState, ops, registration, abort } =
      createAuthorityAbortFixture("run-authority-abort");
    const entry = registration.entry!;
    const expectRetired = () => {
      expect(validateAgentRunDelegatedAuthority(authority)).toBe(false);
      expect(entry.input.abortSignal.aborted).toBe(true);
    };
    const onAbortPrepared = vi.fn(() => {
      expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);
      expect(entry.input.abortSignal.aborted).toBe(false);
      expect(chatRunState.hasAbortMarker(runId)).toBe(true);
    });
    const onAbortCommitted = vi.fn(expectRetired);
    ops.onRunAborted = vi.fn(expectRetired);

    expect(abort({ stopReason: "user", onAbortPrepared, onAbortCommitted })).toEqual({
      aborted: true,
    });
    expect(ops.onRunAborted).toHaveBeenCalledOnce();
    expect(abort({ onAbortCommitted })).toEqual({ aborted: false });
    expect(onAbortCommitted).toHaveBeenCalledOnce();
  });

  it("does not revoke a same-id successor from a stale abort controller", () => {
    const runId = "run-authority-successor";
    const { abort } = createAuthorityAbortFixture(runId);
    const successorInstance = createOperationalRunInstanceRef(runId);
    const successor = claimAgentRunDelegatedAuthority(successorInstance);

    expect(abort({ stopReason: "stale" })).toEqual({ aborted: true });
    expect(validateAgentRunDelegatedAuthority(successor)).toBe(true);
    expect(releaseAgentRunDelegatedAuthority(successor)).toBe(true);
  });
});
