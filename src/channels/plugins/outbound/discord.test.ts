import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { discordOutbound } from "./discord.js";

describe("discordOutbound.resolveTarget", () => {
  const resolveTarget = discordOutbound.resolveTarget!;

  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          plugin: createOutboundTestPlugin({ id: "discord", outbound: discordOutbound }),
          source: "test",
        },
      ]),
    );
  });

  it("normalizes bare numeric channel id to channel: prefix", () => {
    const result = resolveTarget({ to: "1234567890123456789", mode: "explicit" });
    expect(result).toEqual({ ok: true, to: "channel:1234567890123456789" });
  });

  it("preserves user: prefix targets", () => {
    const result = resolveTarget({ to: "user:9876543210", mode: "explicit" });
    expect(result).toEqual({ ok: true, to: "user:9876543210" });
  });

  it("preserves channel: prefix targets", () => {
    const result = resolveTarget({ to: "channel:1234567890", mode: "explicit" });
    expect(result).toEqual({ ok: true, to: "channel:1234567890" });
  });

  it("normalizes discord: prefix to user target", () => {
    const result = resolveTarget({ to: "discord:9876543210", mode: "explicit" });
    expect(result).toEqual({ ok: true, to: "user:9876543210" });
  });

  it("normalizes mention format", () => {
    const result = resolveTarget({ to: "<@123456>", mode: "explicit" });
    expect(result).toEqual({ ok: true, to: "user:123456" });
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
      allowFrom: ["1234567890"],
      mode: "implicit",
    });
    expect(result).toEqual({ ok: true, to: "channel:1234567890" });
  });

  it("falls back to allowFrom in heartbeat mode when to is empty", () => {
    const result = resolveTarget({
      to: undefined,
      allowFrom: ["user:5555"],
      mode: "heartbeat",
    });
    expect(result).toEqual({ ok: true, to: "user:5555" });
  });

  it("returns error when no target and no allowFrom in implicit mode", () => {
    const result = resolveTarget({ to: "", mode: "implicit" });
    expect(result.ok).toBe(false);
  });

  it("normalizes channel name strings to channel: prefix", () => {
    const result = resolveTarget({ to: "general", mode: "explicit" });
    expect(result).toEqual({ ok: true, to: "channel:general" });
  });
});
