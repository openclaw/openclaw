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

it("checks an Incognito send's expected leaf against its process-local transcript", async () => {
  await using fixture = await createBrowserFollowupFixture({
    active: false,
    persistDuringDispatch: true,
    storage: "memory",
  });
  await appendTranscriptMessage(fixture.scope, {
    eventId: "current-leaf",
    message: { role: "assistant", content: "Existing response.", timestamp: 2 },
  });
  const send = async (expectedLeafEntryId: string) => {
    const respond = vi.fn<RespondFn>();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: fixture.params.idempotencyKey,
        method: "chat.send",
        params: { ...fixture.params, expectedLeafEntryId },
      },
      client: fixture.client,
      context: fixture.context,
      respond,
      isWebchatConnect: () => true,
    });
    return respond;
  };

  const stale = await send("obsolete-leaf");
  expect(stale.mock.calls[0]?.[2]).toMatchObject({
    code: "INVALID_REQUEST",
    details: { reason: "active-leaf-changed" },
  });
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();

  const accepted = await send("current-leaf");
  expect(accepted.mock.calls[0]).toMatchObject({ 0: true, 1: { status: "started" } });
  await fixture.finishDispatch();
  expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
});
