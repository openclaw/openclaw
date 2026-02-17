import "./test-helpers.js";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { monitorWebChannel } from "./auto-reply.js";
import {
  createWebInboundDeliverySpies,
  createWebListenerFactoryCapture,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  sendWebDirectInboundMessage,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";

installWebAutoReplyTestHomeHooks();

describe("broadcast groups", () => {
  installWebAutoReplyUnitTestHooks();

  it("skips unknown broadcast agent ids when agents.list is present", async () => {
    setLoadConfigMock({
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }],
      },
      broadcast: {
        "+1000": ["alfred", "missing"],
      },
    } satisfies OpenClawConfig);

    const seen: string[] = [];
    const resolver = vi.fn(async (ctx: { SessionKey?: unknown }) => {
      seen.push(String(ctx.SessionKey));
      return { text: "ok" };
    });

    const spies = createWebInboundDeliverySpies();
    const { listenerFactory, getOnMessage } = createWebListenerFactoryCapture();

    await monitorWebChannel(false, listenerFactory, false, resolver);
    const onMessage = getOnMessage();
    expect(onMessage).toBeDefined();

    await sendWebDirectInboundMessage({
      onMessage: onMessage!,
      spies,
      id: "m1",
      from: "+1000",
      to: "+2000",
      body: "hello",
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(seen[0]).toContain("agent:alfred:");
    resetLoadConfigMock();
  });
});
