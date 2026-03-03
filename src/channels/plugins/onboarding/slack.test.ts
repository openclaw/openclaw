import { describe, expect, it } from "vitest";
import { buildSlackManifest } from "./slack.js";

describe("buildSlackManifest", () => {
  it("returns valid JSON that can be parsed without error (#32493)", () => {
    const manifest = buildSlackManifest("TestBot");
    expect(() => JSON.parse(manifest)).not.toThrow();
  });

  it("uses the provided bot name in the manifest", () => {
    const parsed = JSON.parse(buildSlackManifest("MyAgent"));
    expect(parsed.display_information.name).toBe("MyAgent");
    expect(parsed.features.bot_user.display_name).toBe("MyAgent");
  });

  it("falls back to OpenClaw when bot name is empty or whitespace", () => {
    const parsed = JSON.parse(buildSlackManifest("   "));
    expect(parsed.display_information.name).toBe("OpenClaw");

    const parsed2 = JSON.parse(buildSlackManifest(""));
    expect(parsed2.display_information.name).toBe("OpenClaw");
  });

  it("output does not contain box-drawing or pipe framing characters (#32493)", () => {
    const manifest = buildSlackManifest("TestBot");
    expect(manifest).not.toMatch(/[│┌┐└┘─|]/);
  });

  it("includes required Slack manifest structure", () => {
    const parsed = JSON.parse(buildSlackManifest("Bot"));
    expect(parsed).toHaveProperty("display_information");
    expect(parsed).toHaveProperty("features.bot_user");
    expect(parsed).toHaveProperty("oauth_config.scopes.bot");
    expect(parsed).toHaveProperty("settings.socket_mode_enabled", true);
    expect(parsed).toHaveProperty("settings.event_subscriptions.bot_events");
    expect(Array.isArray(parsed.oauth_config.scopes.bot)).toBe(true);
  });
});
