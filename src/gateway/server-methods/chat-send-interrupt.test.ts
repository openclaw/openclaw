import { assert, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  retireSessionControllerInput,
  tryClaimSessionControllerTask,
} from "../../sessions/session-controller.mailbox.js";
import { captureSessionControllerInterruptBefore } from "../../sessions/session-controller.stop-runtime.js";
import { stopSession } from "../../sessions/session-controller.stop.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();

it("leaves the active run intact when replacement session settings are stale", async () => {
  await using fixture = await createFixture();
  const active = fixture.activeRun;
  assert(active, "Expected an active fixture run");
  fixture.params.queueMode = "interrupt";
  fixture.params.expectedPermissionMode = "full";

  const respond = await fixture.send();

  expect(respond.mock.calls[0]).toMatchObject({
    0: false,
    2: { code: "INVALID_REQUEST", details: { reason: "session-settings-changed" } },
  });
  expect(active.abortSignal.aborted).toBe(false);
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
});

it("cancels an earlier admission before it owns a reply operation", async () => {
  await using fixture = await createFixture({ active: false });
  const cancelled = vi.fn();
  const pending = reserveSessionControllerSource(fixture.scope.sessionKey, {
    target: captureSessionTarget({
      storeScope: fixture.scope.storePath,
      sessionKey: fixture.scope.sessionKey,
      agentId: fixture.scope.agentId,
      incarnation: fixture.scope.sessionId,
    }),
    policy: { mode: "followup" },
    adapter: { cancel: cancelled },
  });
  fixture.params.queueMode = "interrupt";
  try {
    const respond = await fixture.send();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(pending.abortSignal.aborted).toBe(true);
    expect(respond.mock.calls[0]).toMatchObject({
      0: true,
      1: { status: "started", interruptedActiveRun: true },
    });
  } finally {
    retireSessionControllerInput(pending);
  }
});

it("captures earlier claimed admissions without capturing another incarnation or later arrivals", () => {
  const target = captureSessionTarget({
    storeScope: "/synthetic/chat-interrupt/sessions.json",
    sessionKey: "agent:main:interrupt-capture",
    incarnation: "current-session",
    agentId: "main",
  });
  const reserve = (incarnation = target.incarnation) =>
    reserveSessionControllerSource(target.sessionKey, {
      target: captureSessionTarget({ ...target, incarnation }),
      policy: { mode: "followup" },
    });
  const previous = reserve();
  const claim = tryClaimSessionControllerTask(previous);
  assert(claim);
  const otherIncarnation = reserve("previous-session");
  const incoming = reserve();
  const capture = captureSessionControllerInterruptBefore(incoming);
  assert(capture, "Expected the earlier admission to be captured");
  const successor = reserve();
  try {
    expect(stopSession({ source: "interrupt", capture }).aborted).toBe(true);
    expect(
      [previous, otherIncarnation, incoming, successor].map((input) => input.abortSignal.aborted),
    ).toEqual([true, false, false, false]);
  } finally {
    releaseSessionControllerClaim(claim);
    for (const input of [otherIncarnation, previous, incoming, successor]) {
      retireSessionControllerInput(input);
    }
  }
});

it("acknowledges an interrupt while a finalizing owner refuses cancellation", async () => {
  await using fixture = await createFixture();
  const active = fixture.activeRun;
  assert(active, "Expected an active fixture run");
  const cleanup = createDeferred();
  active.registerExecutionCleanup(() => cleanup.promise);
  const settled = vi.fn();
  void active.ownerSettlement.then(settled);
  const cancel = vi.fn();
  active.attachBackend({ kind: "embedded", cancel });
  active.freezeAbort();
  fixture.params.queueMode = "interrupt";
  try {
    const respond = await fixture.send();
    expect(cancel).not.toHaveBeenCalled();
    expect(active.abortSignal.aborted).toBe(false);
    expect(settled).not.toHaveBeenCalled();
    const payload = respond.mock.calls[0]?.[1];
    expect(respond.mock.calls[0]).toMatchObject({ 0: true, 1: { status: "started" } });
    expect(payload).not.toHaveProperty("interruptedActiveRun");
  } finally {
    cleanup.resolve();
  }
}, 10_000);
