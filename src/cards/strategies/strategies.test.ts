import { describe, expect, it } from "vitest";
import type { ParsedAdaptiveCard } from "../parse.js";
import { discordStrategy } from "./discord.js";
import { nativeStrategy } from "./native.js";
import { slackStrategy } from "./slack.js";
import { telegramStrategy } from "./telegram.js";

function makeParsed(overrides?: Partial<ParsedAdaptiveCard>): ParsedAdaptiveCard {
  return {
    card: {
      type: "AdaptiveCard",
      version: "1.5",
      body: [
        { type: "TextBlock", text: "Status", weight: "Bolder" },
        {
          type: "FactSet",
          facts: [
            { title: "Deploy", value: "Done" },
            { title: "Tests", value: "Pending" },
          ],
        },
      ],
      actions: [
        { type: "Action.OpenUrl", title: "View", url: "https://example.com" },
        { type: "Action.Submit", title: "Approve", data: { ok: true } },
      ],
    },
    fallbackText: "Status: Deploy (Done), Tests (Pending)",
    ...overrides,
  };
}

// ── Telegram ──

describe("telegramStrategy", () => {
  it("renders TextBlock + FactSet as HTML with inline keyboard", () => {
    const result = telegramStrategy.render(makeParsed());
    expect(result.type).toBe("telegram");
    if (result.type !== "telegram") {
      return;
    }
    expect(result.text).toContain("<b>Status</b>");
    expect(result.text).toContain("<b>Deploy</b>: Done");
    expect(result.replyMarkup).toBeDefined();
    expect(result.replyMarkup!.inline_keyboard).toHaveLength(2);
    expect(result.replyMarkup!.inline_keyboard[0][0].url).toBe("https://example.com");
    expect(result.replyMarkup!.inline_keyboard[1][0].callback_data).toBeDefined();
  });

  it("skips Action.OpenUrl with empty URL", () => {
    const parsed = makeParsed();
    parsed.card.actions = [{ type: "Action.OpenUrl", title: "Bad", url: "" }];
    const result = telegramStrategy.render(parsed);
    if (result.type !== "telegram") {
      return;
    }
    expect(result.replyMarkup).toBeUndefined();
  });

  it("truncates callback_data by byte length", () => {
    const parsed = makeParsed();
    // Create data that exceeds 64 bytes with multi-byte chars
    parsed.card.actions = [{ type: "Action.Submit", title: "Go", data: { msg: "A".repeat(80) } }];
    const result = telegramStrategy.render(parsed);
    if (result.type !== "telegram") {
      return;
    }
    const cbData = result.replyMarkup!.inline_keyboard[0][0].callback_data!;
    const byteLen = new TextEncoder().encode(cbData).byteLength;
    expect(byteLen).toBeLessThanOrEqual(64);
  });

  it("falls back to fallbackText when body is empty", () => {
    const parsed = makeParsed();
    parsed.card.body = [];
    const result = telegramStrategy.render(parsed);
    if (result.type !== "telegram") {
      return;
    }
    expect(result.text).toContain("Status: Deploy");
  });

  it("renders Icon as emoji + name", () => {
    const parsed = makeParsed();
    parsed.card.body = [{ type: "Icon", name: "settings" }];
    parsed.card.actions = [];
    const result = telegramStrategy.render(parsed);
    if (result.type !== "telegram") {
      return;
    }
    expect(result.text).toContain("\u{1F535} settings");
  });

  it("renders List as bulleted items with title", () => {
    const parsed = makeParsed();
    parsed.card.body = [
      {
        type: "List",
        title: "Tasks",
        items: [{ title: "Build", subtitle: "in progress" }, { title: "Deploy" }],
      },
    ];
    parsed.card.actions = [];
    const result = telegramStrategy.render(parsed);
    if (result.type !== "telegram") {
      return;
    }
    expect(result.text).toContain("<b>Tasks</b>");
    expect(result.text).toContain("\u2022 Build - in progress");
    expect(result.text).toContain("\u2022 Deploy");
  });

  it("collects ActionSet actions into inline keyboard", () => {
    const parsed = makeParsed();
    parsed.card.body = [
      { type: "TextBlock", text: "Hello" },
      {
        type: "ActionSet",
        actions: [{ type: "Action.OpenUrl", title: "Link", url: "https://example.com/inline" }],
      },
    ];
    parsed.card.actions = [];
    const result = telegramStrategy.render(parsed);
    if (result.type !== "telegram") {
      return;
    }
    expect(result.replyMarkup).toBeDefined();
    expect(result.replyMarkup!.inline_keyboard).toHaveLength(1);
    expect(result.replyMarkup!.inline_keyboard[0][0].url).toBe("https://example.com/inline");
  });
});

// ── Slack ──

describe("slackStrategy", () => {
  it("renders TextBlock as mrkdwn section and FactSet as fields", () => {
    const result = slackStrategy.render(makeParsed());
    expect(result.type).toBe("slack");
    if (result.type !== "slack") {
      return;
    }
    expect(result.blocks.length).toBeGreaterThan(0);
    const section = result.blocks[0] as { type: string; text: { text: string } };
    expect(section.type).toBe("section");
    expect(section.text.text).toContain("*Status*");
    // Should have action buttons
    const actions = result.blocks.find((b: unknown) => (b as { type: string }).type === "actions");
    expect(actions).toBeDefined();
  });

  it("skips Action.OpenUrl with empty URL", () => {
    const parsed = makeParsed();
    parsed.card.actions = [{ type: "Action.OpenUrl", title: "Bad", url: "" }];
    const result = slackStrategy.render(parsed);
    if (result.type !== "slack") {
      return;
    }
    const actions = result.blocks.find((b: unknown) => (b as { type: string }).type === "actions");
    expect(actions).toBeUndefined();
  });

  it("splits FactSet with >10 facts into multiple sections", () => {
    const facts = Array.from({ length: 15 }, (_, i) => ({
      title: `Key${i}`,
      value: `Val${i}`,
    }));
    const parsed = makeParsed();
    parsed.card.body = [{ type: "FactSet", facts }];
    parsed.card.actions = [];
    const result = slackStrategy.render(parsed);
    if (result.type !== "slack") {
      return;
    }
    const sections = result.blocks.filter(
      (b: unknown) =>
        (b as { type: string; fields?: unknown }).type === "section" &&
        (b as { fields?: unknown[] }).fields,
    );
    expect(sections.length).toBe(2); // 10 + 5
  });

  it("skips Icon gracefully", () => {
    const parsed = makeParsed();
    parsed.card.body = [{ type: "Icon", name: "settings" }];
    parsed.card.actions = [];
    const result = slackStrategy.render(parsed);
    if (result.type !== "slack") {
      return;
    }
    expect(result.blocks).toHaveLength(0);
  });

  it("renders List as mrkdwn section with bullets", () => {
    const parsed = makeParsed();
    parsed.card.body = [
      {
        type: "List",
        title: "Tasks",
        items: [{ title: "Build", subtitle: "done" }, { title: "Test" }],
      },
    ];
    parsed.card.actions = [];
    const result = slackStrategy.render(parsed);
    if (result.type !== "slack") {
      return;
    }
    const section = result.blocks[0] as { type: string; text: { text: string } };
    expect(section.type).toBe("section");
    expect(section.text.text).toContain("*Tasks*");
    expect(section.text.text).toContain("\u2022 Build - done");
    expect(section.text.text).toContain("\u2022 Test");
  });

  it("renders ActionSet as actions block", () => {
    const parsed = makeParsed();
    parsed.card.body = [
      { type: "TextBlock", text: "Info" },
      {
        type: "ActionSet",
        actions: [{ type: "Action.OpenUrl", title: "Go", url: "https://example.com/go" }],
      },
    ];
    parsed.card.actions = [];
    const result = slackStrategy.render(parsed);
    if (result.type !== "slack") {
      return;
    }
    const actionsBlock = result.blocks.find(
      (b: unknown) => (b as { type: string }).type === "actions",
    );
    expect(actionsBlock).toBeDefined();
  });
});

// ── Discord ──

describe("discordStrategy", () => {
  it("renders TextBlock as embed title and FactSet as fields", () => {
    const result = discordStrategy.render(makeParsed());
    expect(result.type).toBe("discord");
    if (result.type !== "discord") {
      return;
    }
    expect(result.embeds).toHaveLength(1);
    const embed = result.embeds[0] as { title?: string; fields?: unknown[] };
    expect(embed.title).toBe("Status");
    expect(embed.fields).toHaveLength(2);
    expect(result.components).toBeDefined();
  });

  it("skips Action.OpenUrl with empty URL", () => {
    const parsed = makeParsed();
    parsed.card.actions = [{ type: "Action.OpenUrl", title: "Bad", url: "" }];
    const result = discordStrategy.render(parsed);
    if (result.type !== "discord") {
      return;
    }
    expect(result.components).toBeUndefined();
  });

  it("truncates title to 256 chars", () => {
    const parsed = makeParsed();
    parsed.card.body = [{ type: "TextBlock", text: "A".repeat(300), weight: "Bolder" }];
    parsed.card.actions = [];
    const result = discordStrategy.render(parsed);
    if (result.type !== "discord") {
      return;
    }
    const embed = result.embeds[0] as { title?: string };
    expect(embed.title!.length).toBeLessThanOrEqual(256);
  });

  it("caps fields at 25", () => {
    const facts = Array.from({ length: 30 }, (_, i) => ({
      title: `Key${i}`,
      value: `Val${i}`,
    }));
    const parsed = makeParsed();
    parsed.card.body = [{ type: "FactSet", facts }];
    parsed.card.actions = [];
    const result = discordStrategy.render(parsed);
    if (result.type !== "discord") {
      return;
    }
    const embed = result.embeds[0] as { fields?: unknown[] };
    expect(embed.fields!.length).toBeLessThanOrEqual(25);
  });

  it("skips Icon gracefully", () => {
    const parsed = makeParsed();
    parsed.card.body = [{ type: "Icon", name: "alert" }];
    parsed.card.actions = [];
    const result = discordStrategy.render(parsed);
    if (result.type !== "discord") {
      return;
    }
    const embed = result.embeds[0] as { title?: string; description?: string };
    // Icon should not produce a title or description
    expect(embed.title).toBeUndefined();
    expect(embed.description).toBeUndefined();
  });

  it("renders List as embed field with bulleted items", () => {
    const parsed = makeParsed();
    parsed.card.body = [
      {
        type: "List",
        title: "Deployments",
        items: [
          { title: "staging", subtitle: "live" },
          { title: "production", subtitle: "pending" },
        ],
      },
    ];
    parsed.card.actions = [];
    const result = discordStrategy.render(parsed);
    if (result.type !== "discord") {
      return;
    }
    const embed = result.embeds[0] as { fields?: Array<{ name: string; value: string }> };
    expect(embed.fields).toHaveLength(1);
    expect(embed.fields![0].name).toBe("Deployments");
    expect(embed.fields![0].value).toContain("\u2022 staging - live");
    expect(embed.fields![0].value).toContain("\u2022 production - pending");
  });

  it("collects ActionSet actions into button components", () => {
    const parsed = makeParsed();
    parsed.card.body = [
      { type: "TextBlock", text: "Info", weight: "Bolder" },
      {
        type: "ActionSet",
        actions: [{ type: "Action.OpenUrl", title: "Visit", url: "https://example.com/visit" }],
      },
    ];
    parsed.card.actions = [];
    const result = discordStrategy.render(parsed);
    if (result.type !== "discord") {
      return;
    }
    expect(result.components).toBeDefined();
    const row = result.components![0] as {
      type: number;
      components: Array<{ label: string; url?: string }>;
    };
    expect(row.type).toBe(1);
    expect(row.components[0].label).toBe("Visit");
    expect(row.components[0].url).toBe("https://example.com/visit");
  });
});

// ── Native ──

describe("nativeStrategy", () => {
  it("returns card as attachment with correct contentType", () => {
    const result = nativeStrategy.render(makeParsed());
    expect(result.type).toBe("attachment");
    if (result.type !== "attachment") {
      return;
    }
    expect(result.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(result.content).toEqual(makeParsed().card);
    expect(result.fallback).toBe("Status: Deploy (Done), Tests (Pending)");
  });
});
