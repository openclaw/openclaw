import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOwnedTestInstance } from "../../plugins/plugin-instance.test-support.js";
import { PluginInvocationScope } from "../../plugins/plugin-invocation-scope.js";
import * as routeReplyModule from "./route-reply.js";
import { prepareSessionEventDelivery } from "./session-event-delivery.js";

it("routes a session-event reply after the finished turn's plugin scope closed", async () => {
  const channel = createOwnedTestInstance("event-channel");
  const send = channel.wrap(async () => ({ ok: true, delivered: true }) as const);
  const routed = vi.spyOn(routeReplyModule, "routePreparedReply").mockImplementation(() => send());
  const turn = new PluginInvocationScope(channel.owner!.registry!, [channel]);
  const deliverReply = await prepareSessionEventDelivery(
    { channel: "telegram", to: "-100001" },
    () => {},
  );

  // The reply dispatcher drains in the turn's async context after its lease released the scope.
  const reply = turn.run(() => {
    turn.release();
    return deliverReply({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:event-origin",
      payload: { text: "Process completed" },
      replyKind: "final",
    });
  });

  await expect(reply).resolves.toEqual({ ok: true, delivered: true });
  expect(routed).toHaveBeenCalledOnce();
});
