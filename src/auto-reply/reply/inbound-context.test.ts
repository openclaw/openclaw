import { describe, expect, it } from "vitest";

import type { MsgContext } from "../templating.js";
import { finalizeInboundContext } from "./inbound-context.js";

describe("finalizeInboundContext", () => {
  it("fills BodyForAgent/BodyForCommands and normalizes newlines", () => {
    const ctx: MsgContext = {
      Body: "a\\nb\r\nc",
      RawBody: "raw\\nline",
      ChatType: "channel",
      From: "whatsapp:group:123@g.us",
      GroupSubject: "Test",
    };

    const out = finalizeInboundContext(ctx);
    expect(out.Body).toBe("a\nb\nc");
    expect(out.RawBody).toBe("raw\nline");
    expect(out.BodyForAgent).toBe("a\nb\nc");
    expect(out.BodyForCommands).toBe("raw\nline");
    expect(out.CommandAuthorized).toBe(false);
    expect(out.ChatType).toBe("channel");
    expect(out.ConversationLabel).toContain("Test");
  });

  it("can force BodyForCommands to follow updated CommandBody", () => {
    const ctx: MsgContext = {
      Body: "base",
      BodyForCommands: "<media:audio>",
      CommandBody: "say hi",
      From: "signal:+15550001111",
      ChatType: "direct",
    };

    finalizeInboundContext(ctx, { forceBodyForCommands: true });
    expect(ctx.BodyForCommands).toBe("say hi");
  });
});
