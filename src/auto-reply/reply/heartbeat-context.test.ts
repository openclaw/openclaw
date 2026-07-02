// Tests for synthetic heartbeat context suppression (PR #97067)
import { describe, expect, it } from "vitest";
import type { TemplateContext } from "../templating.js";
import { buildInboundUserContextPrefix } from "./inbound-meta.js";

function parseConversationInfoPayload(text: string): Record<string, unknown> {
  const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
  if (!jsonMatch) {
    return {};
  }
  try {
    return JSON.parse(jsonMatch[1]) as Record<string, unknown>;
  } catch {
    return {};
  }
}

describe("buildInboundUserContextPrefix synthetic heartbeat suppression", () => {
  it("omits conversation info block for synthetic heartbeat turns", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "direct",
      Provider: "heartbeat",
      OriginatingTo: "c2c:683F2ADDE4414658153CECAC0F93EDDE",
      OriginatingChannel: "qqbot",
    } as TemplateContext);

    expect(text).toBe("");
  });

  it("omits conversation info block for synthetic cron-event turns", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "direct",
      Provider: "cron-event",
      OriginatingTo: "c2c:SOMEID",
      OriginatingChannel: "telegram",
    } as TemplateContext);

    expect(text).toBe("");
  });

  it("omits conversation info block for synthetic exec-event turns", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "direct",
      Provider: "exec-event",
      OriginatingTo: "c2c:SOMEID",
      OriginatingChannel: "discord",
    } as TemplateContext);

    expect(text).toBe("");
  });

  it("includes conversation info block for real channel messages", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "direct",
      Provider: "qqbot",
      OriginatingTo: "qqbot:c2c:683F2ADDE4414658153CECAC0F93EDDE",
      OriginatingChannel: "qqbot",
    } as TemplateContext);

    const info = parseConversationInfoPayload(text);
    expect(info["chat_id"]).toBe("qqbot:c2c:683F2ADDE4414658153CECAC0F93EDDE");
  });
});
