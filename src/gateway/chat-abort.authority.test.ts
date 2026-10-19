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

beforeEach(() => {
  resetAgentRunRegistryForTest();
});

function createAuthorityAbortFixture(runId: string) {
  const sessionKey = "agent:main:authority";
  const operationalRunInstance = createOperationalRunInstanceRef(runId);
  rpcSourceTesting.clear();
  const registration = registerChatAbortController({
    runId,
    sessionId: `session-${runId}`,
    sessionKey,
    target: captureSessionTarget({
      storeScope: `/synthetic/authority/${runId}`,
      sessionKey,
      incarnation: `session-${runId}`,
    }),
    timeoutMs: 60_000,
    operationalRunInstance,
  });
  onTestFinished(registration.cleanup);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  registration.bindAgentRunDelegatedAuthority(authority);
  const chatRunState = createChatRunState();
  const ops: ChatAbortOps = {
    chatRunState,
    removeChatRun: vi.fn(() => undefined),
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
  };
  return { authority, operationalRunInstance, chatRunState, ops, registration, runId, sessionKey };
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
  const runId = "run-sessionless-authority";
  const operationalRunInstance = createOperationalRunInstanceRef(runId);
  rpcSourceTesting.clear();
  const registration = registerChatAbortController({
    runId,
    sessionId: `session-${runId}`,
    timeoutMs: 60_000,
    operationalRunInstance,
  });
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const unrelatedInstance = createOperationalRunInstanceRef("run-unrelated-authority");
  const unrelatedAuthority = claimAgentRunDelegatedAuthority(unrelatedInstance);

  expect(registration.registered).toBe(false);
  expect(rpcSourceTesting.size).toBe(0);
  expect(() => registration.bindAgentRunDelegatedAuthority(authority)).toThrow(
    "Unregistered source cannot own a projected run authority",
  );
  expect(() => registration.bindAgentRunDelegatedAuthority(unrelatedAuthority)).toThrow(
    "Unregistered source cannot own a projected run authority",
  );

  registration.cleanup();
  expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);
  expect(validateAgentRunDelegatedAuthority(unrelatedAuthority)).toBe(true);
  expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
  expect(releaseAgentRunDelegatedAuthority(unrelatedAuthority)).toBe(true);
});

it("prepares before cancellation and publishes only after exact authority retirement", () => {
  const { authority, chatRunState, ops, registration, runId, sessionKey } =
    createAuthorityAbortFixture("run-authority-abort");
  const entry = registration.entry!;
  const onAbortPrepared = vi.fn(() => {
    expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);
    expect(entry.input.abortSignal.aborted).toBe(false);
    expect(chatRunState.hasAbortMarker(runId)).toBe(true);
  });
  const onAbortCommitted = vi.fn(() => {
    expect(validateAgentRunDelegatedAuthority(authority)).toBe(false);
    expect(entry.input.abortSignal.aborted).toBe(true);
  });
  ops.onRunAborted = vi.fn(() => {
    expect(validateAgentRunDelegatedAuthority(authority)).toBe(false);
    expect(entry.input.abortSignal.aborted).toBe(true);
  });

  expect(
    abortChatRunById(ops, {
      runId,
      sessionKey,
      stopReason: "user",
      onAbortPrepared,
      onAbortCommitted,
    }),
  ).toEqual({
    aborted: true,
  });
  expect(ops.onRunAborted).toHaveBeenCalledOnce();
  expect(entry.input.abortSignal.aborted).toBe(true);
  expect(abortChatRunById(ops, { runId, sessionKey, onAbortCommitted })).toEqual({
    aborted: false,
  });
  expect(onAbortCommitted).toHaveBeenCalledOnce();
});

it("does not revoke a same-id successor from a stale abort controller", () => {
  const { ops, runId, sessionKey } = createAuthorityAbortFixture("run-authority-successor");
  const successorInstance = createOperationalRunInstanceRef(runId);
  const successor = claimAgentRunDelegatedAuthority(successorInstance);

  expect(abortChatRunById(ops, { runId, sessionKey, stopReason: "stale" })).toEqual({
    aborted: true,
  });
  expect(validateAgentRunDelegatedAuthority(successor)).toBe(true);
  expect(releaseAgentRunDelegatedAuthority(successor)).toBe(true);
});
