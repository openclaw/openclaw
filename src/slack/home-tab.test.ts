import { describe, expect, it } from "vitest";
import { buildDefaultHomeView } from "./home-tab.js";

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
    const header = blocks[0];
    expect(header.text.text).toContain("Slurpy");
  });

  it("defaults bot name to OpenClaw", () => {
    const view = buildDefaultHomeView();
    const blocks = view.blocks as Array<{ text: { text: string } }>;
    const header = blocks[0];
    expect(header.text.text).toContain("OpenClaw");
  });

  it("includes commands section when showCommands is true", () => {
    const view = buildDefaultHomeView({ showCommands: true });
    const blocks = view.blocks as Array<{ type: string; text?: { text: string } }>;
    const commandBlock = blocks.find(
      (b) => b.type === "section" && b.text?.text?.includes("How to interact"),
    );
    expect(commandBlock).toBeDefined();
  });

  it("omits commands section when showCommands is false", () => {
    const view = buildDefaultHomeView({ showCommands: false });
    const blocks = view.blocks as Array<{ type: string; text?: { text: string } }>;
    const commandBlock = blocks.find(
      (b) => b.type === "section" && b.text?.text?.includes("How to interact"),
    );
    expect(commandBlock).toBeUndefined();
  });

  it("includes slash command when enabled", () => {
    const view = buildDefaultHomeView({
      showCommands: true,
      slashCommandEnabled: true,
      slashCommandName: "mybot",
    });
    const blocks = view.blocks as Array<{ type: string; text?: { text: string } }>;
    const commandBlock = blocks.find(
      (b) => b.type === "section" && b.text?.text?.includes("/mybot"),
    );
    expect(commandBlock).toBeDefined();
  });

  it("omits slash command when disabled", () => {
    const view = buildDefaultHomeView({
      showCommands: true,
      slashCommandEnabled: false,
      slashCommandName: "mybot",
    });
    const blocks = view.blocks as Array<{ type: string; text?: { text: string } }>;
    const commandBlock = blocks.find(
      (b) => b.type === "section" && b.text?.text?.includes("/mybot"),
    );
    expect(commandBlock).toBeUndefined();
  });

  it("appends custom blocks", () => {
    const custom = [{ type: "section", text: { type: "mrkdwn", text: "Custom!" } }];
    const view = buildDefaultHomeView({ customBlocks: custom });
    const blocks = view.blocks as Array<{ type: string; text?: { text: string } }>;
    const customBlock = blocks.find((b) => b.type === "section" && b.text?.text === "Custom!");
    expect(customBlock).toBeDefined();
  });

  it("includes OpenClaw context footer", () => {
    const view = buildDefaultHomeView();
    const blocks = view.blocks as Array<{ type: string; elements?: Array<{ text: string }> }>;
    const context = blocks.find(
      (b) => b.type === "context" && b.elements?.some((e) => e.text?.includes("OpenClaw")),
    );
    expect(context).toBeDefined();
  });

  it("handles empty customBlocks gracefully", () => {
    const view = buildDefaultHomeView({ customBlocks: [] });
    expect(view.type).toBe("home");
    // No extra divider should be added for empty custom blocks
    const blocks = view.blocks as Array<{ type: string }>;
    const dividers = blocks.filter((b) => b.type === "divider");
    const viewWithoutCustom = buildDefaultHomeView();
    const blocksWithout = viewWithoutCustom.blocks as Array<{ type: string }>;
    const dividersWithout = blocksWithout.filter((b) => b.type === "divider");
    expect(dividers.length).toBe(dividersWithout.length);
  });
});
