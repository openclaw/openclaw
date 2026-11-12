import { expect, it, vi } from "vitest";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";
import { handleGatewayRequest } from "../server-methods.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

it("checks Incognito sends and Stop against the process-local active path", async () => {
  await using fixture = await createBrowserFollowupFixture({
    active: false,
    persistDuringDispatch: true,
    storage: "memory",
  });
  for (const [eventId, timestamp] of [
    ["earlier-leaf", 2],
    ["current-leaf", 3],
  ] as const) {
    await appendTranscriptMessage(fixture.scope, {
      eventId,
      message: { role: "assistant", content: `Response ${timestamp}.`, timestamp },
    });
  }
  const send = async (params: Record<string, unknown>) => {
    const respond = vi.fn<RespondFn>();
    await handleGatewayRequest({
      req: { type: "req", id: fixture.params.idempotencyKey, method: "chat.send", params },
      client: fixture.client,
      context: fixture.context,
      respond,
      isWebchatConnect: () => true,
    });
    return respond;
  };
  const expectLeafChanged = (respond: ReturnType<typeof vi.fn<RespondFn>>) =>
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "active-leaf-changed" },
    });
  const stop = (expectedLeafEntryId: string) =>
    send({
      ...fixture.params,
      message: "/stop",
      idempotencyKey: `stop-${expectedLeafEntryId}`,
      expectedLeafEntryId,
    });

  expectLeafChanged(await stop("obsolete-leaf"));
  expect((await stop("current-leaf")).mock.calls[0]?.[0]).toBe(true);
  expectLeafChanged(await send({ ...fixture.params, expectedLeafEntryId: "obsolete-leaf" }));
  // Without a session fence, only the exact leaf is current.
  expectLeafChanged(
    await send({ ...fixture.params, sessionId: undefined, expectedLeafEntryId: "earlier-leaf" }),
  );
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();

  // A session-fenced sender may still be on the active path behind the newest reply.
  const accepted = await send({ ...fixture.params, expectedLeafEntryId: "earlier-leaf" });
  expect(accepted.mock.calls[0]).toMatchObject({ 0: true, 1: { status: "started" } });
  await fixture.finishDispatch();
  expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
});
