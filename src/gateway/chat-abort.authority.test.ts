import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { abortChatRunById, registerChatAbortController, type ChatAbortOps } from "./chat-abort.js";
import { createChatRunState } from "./server-chat-state.js";

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
