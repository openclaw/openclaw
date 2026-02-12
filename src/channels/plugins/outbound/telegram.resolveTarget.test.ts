import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { telegramOutbound } from "./telegram.js";

describe("telegramOutbound.resolveTarget", () => {
  const resolveTarget = telegramOutbound.resolveTarget!;

  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: createOutboundTestPlugin({ id: "telegram", outbound: telegramOutbound }),
          source: "test",
        },
      ]),
    );
  });

  it("normalizes bare numeric chat id", () => {
    const result = resolveTarget({ to: "123456789", mode: "explicit" });
    expect(result).toEqual({ ok: true, to: "telegram:123456789" });
  });

  it("normalizes negative group chat id", () => {
    const result = resolveTarget({ to: "-1001234567890", mode: "explicit" });
    expect(result).toEqual({ ok: true, to: "telegram:-1001234567890" });
  });

  it("normalizes telegram: prefixed targets", () => {
    const result = resolveTarget({ to: "telegram:987654321", mode: "explicit" });
    expect(result).toEqual({ ok: true, to: "telegram:987654321" });
  });

  it("normalizes tg: prefixed targets", () => {
    const result = resolveTarget({ to: "tg:111222333", mode: "explicit" });
    expect(result).toEqual({ ok: true, to: "telegram:111222333" });
  });

  it("normalizes @username targets", () => {
    const result = resolveTarget({ to: "@mybot", mode: "explicit" });
    expect(result).toEqual({ ok: true, to: "telegram:@mybot" });
  });

  it("normalizes t.me link targets", () => {
    const result = resolveTarget({ to: "https://t.me/mybot", mode: "explicit" });
    expect(result).toEqual({ ok: true, to: "telegram:@mybot" });
  });

  it("returns error for empty target in explicit mode", () => {
    const result = resolveTarget({ to: "", mode: "explicit" });
    expect(result.ok).toBe(false);
  });

  it("returns error for undefined target in explicit mode", () => {
    const result = resolveTarget({ to: undefined, mode: "explicit" });
    expect(result.ok).toBe(false);
  });

  it("falls back to allowFrom in implicit mode when to is empty", () => {
    const result = resolveTarget({
      to: "",
      allowFrom: ["123456789"],
      mode: "implicit",
    });
    expect(result).toEqual({ ok: true, to: "telegram:123456789" });
  });

  it("falls back to allowFrom in heartbeat mode when to is empty", () => {
    const result = resolveTarget({
      to: undefined,
      allowFrom: ["999888777"],
      mode: "heartbeat",
    });
    expect(result).toEqual({ ok: true, to: "telegram:999888777" });
  });

  it("returns error when no target and no allowFrom in implicit mode", () => {
    const result = resolveTarget({ to: "", mode: "implicit" });
    expect(result.ok).toBe(false);
  });

  it("passes through non-normalizable target as-is", () => {
    // sendMessageTelegram has its own normalizeChatId for edge cases
    const result = resolveTarget({ to: "some_custom_target", mode: "explicit" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // normalizeTelegramMessagingTarget should handle usernames
      expect(result.to).toBe("telegram:some_custom_target");
    }
  });
});
