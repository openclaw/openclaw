import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SlackAccountSchema } from "../config/zod-schema.providers-core.js";
import { buildDefaultHomeView, formatUptime } from "./home-tab.js";
import { resolveAgentModelDisplay } from "./monitor/events/app-home.js";

describe("formatUptime", () => {
  it("formats minutes only", () => {
    expect(formatUptime(5 * 60_000)).toBe("5m");
  });

  it("formats hours and minutes", () => {
    expect(formatUptime(2 * 3600_000 + 15 * 60_000)).toBe("2h 15m");
  });

  it("formats days, hours, and minutes", () => {
    expect(formatUptime(3 * 86400_000 + 4 * 3600_000 + 30 * 60_000)).toBe("3d 4h 30m");
  });

  it("shows 0m for less than a minute", () => {
    expect(formatUptime(30_000)).toBe("0m");
  });
});

describe("buildDefaultHomeView", () => {
  it("returns a view with type home", () => {
    const view = buildDefaultHomeView();
    expect(view.type).toBe("home");
  });

  it("includes blocks array", () => {
    const view = buildDefaultHomeView();
    const blocks = view.blocks as unknown[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("uses provided bot name in header", () => {
    const view = buildDefaultHomeView({ botName: "Slurpy" });
    const blocks = view.blocks as Array<{ text: { text: string } }>;
    expect(blocks[0].text.text).toContain("Slurpy");
  });

  it("defaults bot name to OpenClaw", () => {
    const view = buildDefaultHomeView();
    const blocks = view.blocks as Array<{ text: { text: string } }>;
    expect(blocks[0].text.text).toContain("OpenClaw");
  });

  it("shows version and status fields", () => {
    const view = buildDefaultHomeView({ version: "2026.2.8" });
    const text = JSON.stringify(view.blocks);
    expect(text).toContain("Online");
    expect(text).toContain("2026.2.8");
  });

  it("shows model when provided", () => {
    const view = buildDefaultHomeView({ model: "anthropic/opus-4" });
    const text = JSON.stringify(view.blocks);
    expect(text).toContain("anthropic/opus-4");
  });

  it("shows uptime when provided", () => {
    const view = buildDefaultHomeView({ uptimeMs: 7200_000 });
    const text = JSON.stringify(view.blocks);
    expect(text).toContain("2h 0m");
  });

  it("shows configured channels", () => {
    const view = buildDefaultHomeView({ channelIds: ["C123ABC", "C456DEF"] });
    const text = JSON.stringify(view.blocks);
    expect(text).toContain("<#C123ABC>");
    expect(text).toContain("<#C456DEF>");
  });

  it("includes getting started section with bot mention", () => {
    const view = buildDefaultHomeView({ botUserId: "U_BOT" });
    const text = JSON.stringify(view.blocks);
    expect(text).toContain("<@U_BOT>");
    expect(text).toContain("direct message");
  });

  it("includes slash command when enabled", () => {
    const view = buildDefaultHomeView({
      showCommands: true,
      slashCommandEnabled: true,
      slashCommandName: "mybot",
    });
    const text = JSON.stringify(view.blocks);
    expect(text).toContain("/mybot");
  });

  it("omits slash command section when disabled", () => {
    const view = buildDefaultHomeView({
      showCommands: true,
      slashCommandEnabled: false,
      slashCommandName: "mybot",
    });
    const text = JSON.stringify(view.blocks);
    expect(text).not.toContain("Slash Commands");
  });

  it("appends custom blocks", () => {
    const custom = [{ type: "section", text: { type: "mrkdwn", text: "Custom!" } }];
    const view = buildDefaultHomeView({ customBlocks: custom });
    const text = JSON.stringify(view.blocks);
    expect(text).toContain("Custom!");
  });

  it("includes docs/github/community links", () => {
    const view = buildDefaultHomeView();
    const text = JSON.stringify(view.blocks);
    expect(text).toContain("docs.openclaw.ai");
    expect(text).toContain("github.com");
    expect(text).toContain("discord.com");
  });

  it("handles empty customBlocks gracefully", () => {
    const view = buildDefaultHomeView({ customBlocks: [] });
    expect(view.type).toBe("home");
    const blocks = view.blocks as Array<{ type: string }>;
    const dividers = blocks.filter((b) => b.type === "divider");
    const viewWithoutCustom = buildDefaultHomeView();
    const blocksWithout = viewWithoutCustom.blocks as Array<{ type: string }>;
    const dividersWithout = blocksWithout.filter((b) => b.type === "divider");
    expect(dividers.length).toBe(dividersWithout.length);
  });

  it("does not include auth tokens or dashboard links", () => {
    const view = buildDefaultHomeView();
    const text = JSON.stringify(view.blocks);
    expect(text).not.toContain("token");
    expect(text).not.toContain("Dashboard");
    expect(text).not.toContain("127.0.0.1");
  });
});

describe("resolveAgentModelDisplay", () => {
  it("returns agent model string", () => {
    expect(resolveAgentModelDisplay({ id: "a", model: "anthropic/claude-3" }, {})).toBe(
      "anthropic/claude-3",
    );
  });

  it("returns agent model primary from object", () => {
    expect(resolveAgentModelDisplay({ id: "a", model: { primary: "openai/gpt-5" } }, {})).toBe(
      "openai/gpt-5",
    );
  });

  it("falls back to agents.defaults.model.primary", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "fallback/model" } } },
    };
    expect(resolveAgentModelDisplay({ id: "a" }, cfg)).toBe("fallback/model");
  });

  it("returns dash when no model configured", () => {
    expect(resolveAgentModelDisplay(undefined, {})).toBe("—");
  });
});

describe("Zod schema validation", () => {
  it("accepts homeTab config in SlackAccountSchema", () => {
    const result = SlackAccountSchema.safeParse({
      homeTab: { enabled: true },
    });
    expect(result.success).toBe(true);
  });

  it("accepts homeTab: false in actions config", () => {
    const result = SlackAccountSchema.safeParse({
      actions: { homeTab: false },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown keys in homeTab config", () => {
    const result = SlackAccountSchema.safeParse({
      homeTab: { enabled: true, unknownKey: "bad" },
    });
    expect(result.success).toBe(false);
  });
});
