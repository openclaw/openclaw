import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  buildHomeTabBlocks,
  formatUptime,
  resolveAgentModelDisplay,
  resolveTemplateVars,
  substituteTemplateVars,
} from "./home.js";

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

describe("buildHomeTabBlocks", () => {
  it("returns blocks with header showing agent name", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true, name: "TestBot" }] },
    };
    const blocks = buildHomeTabBlocks({ botUserId: "U12345", cfg });

    expect(blocks[0]).toMatchObject({
      type: "header",
      text: { type: "plain_text", text: "TestBot" },
    });
  });

  it("falls back to ui.assistant.name when no agent name", () => {
    const cfg: OpenClawConfig = { ui: { assistant: { name: "MyAssistant" } } };
    const blocks = buildHomeTabBlocks({ botUserId: "U12345", cfg });

    expect(blocks[0]).toMatchObject({
      type: "header",
      text: { type: "plain_text", text: "MyAssistant" },
    });
  });

  it("defaults to OpenClaw when no name configured", () => {
    const blocks = buildHomeTabBlocks({ botUserId: "U12345" });
    expect(blocks[0]).toMatchObject({
      type: "header",
      text: { type: "plain_text", text: "OpenClaw" },
    });
  });

  it("shows status and version fields", () => {
    const blocks = buildHomeTabBlocks({ botUserId: "U12345" });
    const statusSection = blocks[1];
    const fieldsText = JSON.stringify(statusSection);
    expect(fieldsText).toContain("Online");
    expect(fieldsText).toContain("Version");
  });

  it("shows model and uptime fields", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", model: "anthropic/opus-4" }] },
    };
    const blocks = buildHomeTabBlocks({ botUserId: "U12345", cfg, uptimeMs: 7200_000 });
    const infoSection = blocks[2];
    const text = JSON.stringify(infoSection);
    expect(text).toContain("anthropic/opus-4");
    expect(text).toContain("2h 0m");
  });

  it("uses default /openclaw slash command when none provided", () => {
    const blocks = buildHomeTabBlocks({ botUserId: "U99" });
    const slashBlock = blocks.find(
      (b) =>
        b.type === "section" &&
        "text" in b &&
        (b.text as Record<string, string>)?.text?.includes("Slash Commands"),
    );
    expect(slashBlock).toBeDefined();
    const text =
      slashBlock && "text" in slashBlock
        ? ((slashBlock.text as Record<string, string>)?.text ?? "")
        : "";
    expect(text).toContain("`/openclaw`");
  });

  it("uses custom slash command when provided", () => {
    const blocks = buildHomeTabBlocks({ botUserId: "U99", slashCommand: "/mybot" });
    const slashBlock = blocks.find(
      (b) =>
        b.type === "section" &&
        "text" in b &&
        (b.text as Record<string, string>)?.text?.includes("Slash Commands"),
    );
    expect(slashBlock).toBeDefined();
    const text =
      slashBlock && "text" in slashBlock
        ? ((slashBlock.text as Record<string, string>)?.text ?? "")
        : "";
    expect(text).toContain("`/mybot`");
    expect(text).not.toContain("/openclaw");
  });

  it("includes docs/github/community links in context block", () => {
    const blocks = buildHomeTabBlocks({ botUserId: "U99" });
    const contextBlock = blocks.find((b) => b.type === "context");
    expect(contextBlock).toBeDefined();
    const contextText = JSON.stringify(contextBlock);
    expect(contextText).toContain("docs.openclaw.ai");
    expect(contextText).toContain("github.com");
    expect(contextText).toContain("discord.com");
  });

  it("shows configured channels when present", () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          channels: {
            C123ABC: { enabled: true },
            C456DEF: { enabled: true },
          },
        },
      },
    };
    const blocks = buildHomeTabBlocks({ botUserId: "U99", cfg });
    const channelBlock = blocks.find(
      (b) =>
        b.type === "section" &&
        "text" in b &&
        (b.text as Record<string, string>)?.text?.includes("Channels"),
    );
    expect(channelBlock).toBeDefined();
    const text = (channelBlock as Record<string, Record<string, string>>)?.text?.text ?? "";
    expect(text).toContain("<#C123ABC>");
    expect(text).toContain("<#C456DEF>");
  });

  it("picks first agent as default when none marked default", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "alpha", name: "Alpha" },
          { id: "beta", name: "Beta" },
        ],
      },
    };
    const blocks = buildHomeTabBlocks({ botUserId: "U99", cfg });
    expect(blocks[0]).toMatchObject({
      type: "header",
      text: { type: "plain_text", text: "Alpha" },
    });
  });

  it("does not include any auth tokens or dashboard links", () => {
    const blocks = buildHomeTabBlocks({ botUserId: "U99" });
    const fullText = JSON.stringify(blocks);
    expect(fullText).not.toContain("token");
    expect(fullText).not.toContain("Dashboard");
    expect(fullText).not.toContain("127.0.0.1");
  });

  it("uses custom blocks from homeTabConfig when provided", () => {
    const customBlocks = [
      { type: "header", text: { type: "plain_text", text: "Hello {{agent_name}}!" } },
      { type: "section", text: { type: "mrkdwn", text: "Running {{version}} on {{model}}" } },
    ];
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true, name: "MyBot", model: "gpt-5" }] },
    };
    const blocks = buildHomeTabBlocks({
      botUserId: "U99",
      cfg,
      homeTabConfig: { blocks: customBlocks },
    });
    expect(blocks[0]).toMatchObject({
      type: "header",
      text: { type: "plain_text", text: "Hello MyBot!" },
    });
    expect(blocks[1]).toMatchObject({
      type: "section",
      text: { type: "mrkdwn", text: expect.stringContaining("gpt-5") },
    });
  });

  it("falls back to default blocks when homeTabConfig has no blocks", () => {
    const blocks = buildHomeTabBlocks({
      botUserId: "U99",
      homeTabConfig: { enabled: true },
    });
    // Should still render default view
    expect(blocks[0]).toMatchObject({ type: "header" });
    expect(blocks.length).toBeGreaterThan(3);
  });

  it("falls back to default blocks when homeTabConfig.blocks is empty", () => {
    const blocks = buildHomeTabBlocks({
      botUserId: "U99",
      homeTabConfig: { blocks: [] },
    });
    expect(blocks[0]).toMatchObject({ type: "header" });
    expect(blocks.length).toBeGreaterThan(3);
  });
});

describe("substituteTemplateVars", () => {
  const vars = {
    agent_name: "TestBot",
    version: "1.0.0",
    model: "gpt-5",
    uptime: "2h 30m",
    channels: "<#C123>",
    slash_command: "/test",
  };

  it("substitutes string variables", () => {
    expect(substituteTemplateVars("Hello {{agent_name}}!", vars)).toBe("Hello TestBot!");
  });

  it("substitutes multiple variables in one string", () => {
    expect(substituteTemplateVars("{{agent_name}} v{{version}}", vars)).toBe("TestBot v1.0.0");
  });

  it("leaves unknown variables unchanged", () => {
    expect(substituteTemplateVars("{{unknown_var}}", vars)).toBe("{{unknown_var}}");
  });

  it("handles nested objects", () => {
    const obj = { text: { type: "mrkdwn", text: "Model: {{model}}" } };
    expect(substituteTemplateVars(obj, vars)).toEqual({
      text: { type: "mrkdwn", text: "Model: gpt-5" },
    });
  });

  it("handles arrays", () => {
    const arr = ["{{agent_name}}", "{{version}}"];
    expect(substituteTemplateVars(arr, vars)).toEqual(["TestBot", "1.0.0"]);
  });

  it("passes through non-string primitives", () => {
    expect(substituteTemplateVars(42, vars)).toBe(42);
    expect(substituteTemplateVars(true, vars)).toBe(true);
    expect(substituteTemplateVars(null, vars)).toBe(null);
  });
});

describe("resolveTemplateVars", () => {
  it("resolves agent name from config", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true, name: "MyAgent" }] },
    };
    const vars = resolveTemplateVars({ cfg });
    expect(vars.agent_name).toBe("MyAgent");
  });

  it("resolves channels from config", () => {
    const cfg: OpenClawConfig = {
      channels: { slack: { channels: { C111: {}, C222: {} } } },
    };
    const vars = resolveTemplateVars({ cfg });
    expect(vars.channels).toContain("<#C111>");
    expect(vars.channels).toContain("<#C222>");
  });

  it("returns 'None configured' when no channels", () => {
    const vars = resolveTemplateVars({});
    expect(vars.channels).toBe("None configured");
  });
});
