import { assert, expect, it, vi } from "vitest";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import {
  beginSessionControllerSourceInjection,
  updateSessionControllerSourcePolicy,
} from "../../sessions/session-controller.mailbox.js";
import { getRpcSourceForGateway } from "../../sessions/session-controller.rpc-sources.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { chatRpc } from "./chat-rpc-fixture.test-support.js";
import { bindChatProfile } from "./chat-send-admission-fixtures.test-support.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const fixture = useBrowserFollowupFixture();
async function readyFixture() {
  const f = await fixture();
  bindChatProfile(f.client, "interrupt@example.test", true);
  await initializeSessionReadContext(f.context);
  await getSessionRowProjection(f.context)?.ensureMaterialized();
  return f;
}
const interrupt = (f: Awaited<ReturnType<typeof readyFixture>>, runId: string, extra = {}) =>
  chatRpc(f.context, f.client, "chat.interrupt", {
    sessionKey: f.scope.sessionKey,
    sessionId: f.scope.sessionId,
    runId,
    ...extra,
  });

it("interrupts for the original queued input without resending or canceling its siblings", async () => {
  await using f = await readyFixture();
  for (const id of ["older", "selected", "later"]) {
    const ack = await f.send(undefined, undefined, {
      ...f.params,
      queueMode: "followup",
      idempotencyKey: id,
    });
    expect(ack.mock.calls[0]?.[0]).toBe(true);
  }
  const selected = getRpcSourceForGateway("selected", f.context.resolveGatewayContext);
  assert(selected);
  await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(3));
  const originalInput = selected.input;
  const settled = vi.fn();
  void f.activeRun?.ownerSettlement.then(settled);
  expect(await interrupt(f, "selected")).toMatchObject([
    true,
    { status: "queued", runId: "selected", cancellationRequested: true },
  ]);
  expect(f.activeRun?.abortSignal.aborted).toBe(true);
  expect(settled).not.toHaveBeenCalled();
  expect(selected.input).toBe(originalInput);
  expect(selected.input.mailbox.priority).toBe(originalInput);
  expect(selected.input.abortSignal.aborted).toBe(false);
  // Each explicit selection wins, including selecting an already-interrupt input again.
  expect(await interrupt(f, "older")).toMatchObject([true, { status: "queued" }]);
  expect(await interrupt(f, "selected")).toMatchObject([true, { status: "queued" }]);
  expect(settled).not.toHaveBeenCalled();
  expect(selected.input.mailbox.priority).toBe(originalInput);
  // Original-send preparation must not undo a later explicit queued-input control.
  updateSessionControllerSourcePolicy(selected.input, { mode: "followup" });
  expect(selected.input.policy.mode).toBe("interrupt");
  const older = getRpcSourceForGateway("older", f.context.resolveGatewayContext);
  assert(older);
  updateSessionControllerSourcePolicy(older.input, { mode: "followup" });
  expect(selected.input.mailbox.priority).toBe(originalInput);
  for (const id of ["older", "later"]) {
    expect(
      getRpcSourceForGateway(id, f.context.resolveGatewayContext)?.input.abortSignal.aborted,
    ).toBe(false);
  }
  expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(3);
});

it("refuses consumed or uncertain injection custody and stale sessions without stopping current work", async () => {
  await using f = await readyFixture();
  await f.send(undefined, undefined, {
    ...f.params,
    queueMode: "followup",
    idempotencyKey: "uncertain",
  });
  const source = getRpcSourceForGateway("uncertain", f.context.resolveGatewayContext);
  assert(source);
  const injection = beginSessionControllerSourceInjection(source.input);
  try {
    expect(await interrupt(f, "uncertain")).toMatchObject([
      true,
      { status: "not_queued", cancellationRequested: false },
    ]);
    expect(await interrupt(f, "consumed")).toMatchObject([
      true,
      { status: "not_queued", cancellationRequested: false },
    ]);
    expect(await interrupt(f, "uncertain", { sessionId: "replaced-session" })).toMatchObject([
      false,
      undefined,
      { code: "INVALID_REQUEST" },
    ]);
    expect(
      await interrupt(f, "uncertain", { message: "never accept replacement text" }),
    ).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
    expect(f.activeRun?.abortSignal.aborted).toBe(false);
    expect(source.input.policy.mode).toBe("followup");
  } finally {
    injection.finish(false);
  }
});

it("uses the signed-in native client's personal interrupt default without a UI send override", async () => {
  await using f = await readyFixture();
  expect(
    await chatRpc(f.context, f.client, "users.prefs.set", {
      entries: { "chat.followUpMode": "interrupt" },
    }),
  ).toMatchObject({ 0: true, 1: { status: "ok" } });
  const ack = await f.send();
  expect(ack.mock.calls[0]).toMatchObject({ 0: true, 1: { interruptedActiveRun: true } });
  expect(f.activeRun?.abortSignal.aborted).toBe(true);
  expect(f.params.queueMode).toBeUndefined();
});

it("does not let the personal interrupt default cancel work before an active-safe control runs", async () => {
  await using f = await readyFixture();
  expect(
    await chatRpc(f.context, f.client, "users.prefs.set", {
      entries: { "chat.followUpMode": "interrupt" },
    }),
  ).toMatchObject({ 0: true });
  const ack = await f.send(undefined, undefined, { ...f.params, message: "/interrupt list" });
  expect(ack.mock.calls[0]?.[0]).toBe(true);
  expect(f.activeRun?.abortSignal.aborted).toBe(false);
});
