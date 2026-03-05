import { describe, expect, it } from "vitest";
import type { MsgContext, TemplateContext } from "../templating.js";
import { resolveMessageProviderKey } from "./get-reply-directives.js";

describe("resolveMessageProviderKey", () => {
  it("prefers resolved command channel over direct runtime provider", () => {
    const provider = resolveMessageProviderKey({
      commandChannelId: "telegram",
      sessionCtx: {
        Provider: "direct",
        Surface: "direct",
      } as unknown as TemplateContext,
      ctx: {
        Provider: "direct",
        Surface: "direct",
        OriginatingChannel: "telegram",
      } as unknown as MsgContext,
    });

    expect(provider).toBe("telegram");
  });

  it("falls back to originating channel before provider", () => {
    const provider = resolveMessageProviderKey({
      sessionCtx: {
        Provider: "direct",
        Surface: "direct",
        OriginatingChannel: "telegram",
      } as unknown as TemplateContext,
      ctx: {
        Provider: "direct",
        Surface: "direct",
      } as unknown as MsgContext,
    });

    expect(provider).toBe("telegram");
  });

  it("uses provider when no channel hints exist", () => {
    const provider = resolveMessageProviderKey({
      sessionCtx: {
        Provider: "direct",
      } as unknown as TemplateContext,
      ctx: {} as MsgContext,
    });

    expect(provider).toBe("direct");
  });
});
