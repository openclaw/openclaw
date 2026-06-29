import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  setInternalHooksEnabled,
} from "../../hooks/internal-hooks.js";
import type { InternalHookEvent } from "../../hooks/internal-hooks.js";
import {
  resetOutboundDeliveryReportCacheForTests,
  reportOutboundDelivered,
} from "./report-outbound-delivered.js";

// Allow the fire-and-forget internal hook to flush.
const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe("reportOutboundDelivered", () => {
  let sent: InternalHookEvent[];

  beforeEach(() => {
    sent = [];
    resetOutboundDeliveryReportCacheForTests();
    clearInternalHooks();
    setInternalHooksEnabled(true);
    registerInternalHook("message:sent", (event) => {
      sent.push(event);
    });
  });

  afterEach(() => {
    clearInternalHooks();
  });

  it("emits exactly one canonical message:sent for a provider-accepted delivery", async () => {
    reportOutboundDelivered({
      channel: "whatsapp",
      to: "1555@s.whatsapp.net",
      sessionKey: "agent:demo:whatsapp:direct:1555",
      success: true,
      content: "hello",
      messageId: "wamid.A",
      correlationId: "in-1",
      accountId: "default",
      isGroup: false,
    });
    await flush();
    expect(sent).toHaveLength(1);
    const e = sent[0];
    expect(e.type).toBe("message");
    expect(e.action).toBe("sent");
    expect(e.sessionKey).toBe("agent:demo:whatsapp:direct:1555");
    const ctx = e.context;
    expect(ctx.channelId).toBe("whatsapp");
    expect(ctx.to).toBe("1555@s.whatsapp.net");
    expect(ctx.content).toBe("hello");
    expect(ctx.success).toBe(true);
    expect(ctx.messageId).toBe("wamid.A");
  });

  it("carries group flags through the canonical context", async () => {
    reportOutboundDelivered({
      channel: "whatsapp",
      to: "120363@g.us",
      sessionKey: "agent:demo:whatsapp:group",
      success: true,
      content: "group hi",
      messageId: "wamid.G",
      isGroup: true,
      groupId: "120363@g.us",
    });
    await flush();
    expect(sent).toHaveLength(1);
    const ctx = sent[0].context;
    expect(ctx.isGroup).toBe(true);
    expect(ctx.groupId).toBe("120363@g.us");
  });

  it("is idempotent on messageId (provider retry already accepted)", async () => {
    const report = {
      channel: "whatsapp",
      to: "1555@s.whatsapp.net",
      sessionKey: "agent:demo:whatsapp:direct:1555",
      success: true,
      content: "hi",
      messageId: "wamid.X",
      correlationId: "in-9",
    } as const;
    reportOutboundDelivered(report);
    reportOutboundDelivered(report);
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("does NOT dedupe distinct messages sharing a correlationId (multiple blocks in one turn)", async () => {
    const base = {
      channel: "whatsapp",
      to: "1555@s.whatsapp.net",
      sessionKey: "agent:demo:whatsapp:direct:1555",
      success: true,
      correlationId: "in-9",
    } as const;
    reportOutboundDelivered({ ...base, content: "block 1", messageId: "wamid.Y1" });
    reportOutboundDelivered({ ...base, content: "block 2", messageId: "wamid.Y2" });
    await flush();
    expect(sent).toHaveLength(2);
  });

  it("fails open when sessionKey is missing: no throw, internal hook skipped", async () => {
    expect(() =>
      reportOutboundDelivered({
        channel: "whatsapp",
        to: "1555@s.whatsapp.net",
        success: true,
        content: "no session key",
        messageId: "wamid.C",
      }),
    ).not.toThrow();
    await flush();
    expect(sent).toHaveLength(0);
  });

  it("never throws even if a downstream hook handler throws", async () => {
    registerInternalHook("message:sent", () => {
      throw new Error("downstream boom");
    });
    expect(() =>
      reportOutboundDelivered({
        channel: "whatsapp",
        to: "1555@s.whatsapp.net",
        sessionKey: "agent:demo:whatsapp:direct:1555",
        success: true,
        content: "hi",
        messageId: "wamid.B",
      }),
    ).not.toThrow();
    await flush();
    // the non-throwing handler still observed the event
    expect(sent).toHaveLength(1);
  });
});
