import { describe, expect, it } from "vitest";
import { createGridLayout, messageAction, createDefaultMenuConfig } from "./rich-menu.js";

describe("createGridLayout", () => {
  it("creates a 2x3 grid layout for tall menu", () => {
    const actions = [
      messageAction("A1"),
      messageAction("A2"),
      messageAction("A3"),
      messageAction("A4"),
      messageAction("A5"),
      messageAction("A6"),
    ] as [
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
    ];

    const areas = createGridLayout(1686, actions);

    expect(areas.length).toBe(6);

    // Check first row positions
    expect(areas[0].bounds.x).toBe(0);
    expect(areas[0].bounds.y).toBe(0);
    expect(areas[1].bounds.x).toBe(833);
    expect(areas[1].bounds.y).toBe(0);
    expect(areas[2].bounds.x).toBe(1666);
    expect(areas[2].bounds.y).toBe(0);

    // Check second row positions
    expect(areas[3].bounds.y).toBe(843);
    expect(areas[4].bounds.y).toBe(843);
    expect(areas[5].bounds.y).toBe(843);
  });

  it("creates a 2x3 grid layout for short menu", () => {
    const actions = [
      messageAction("A1"),
      messageAction("A2"),
      messageAction("A3"),
      messageAction("A4"),
      messageAction("A5"),
      messageAction("A6"),
    ] as [
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
    ];

    const areas = createGridLayout(843, actions);

    expect(areas.length).toBe(6);

    // Row height should be half of 843
    expect(areas[0].bounds.height).toBe(421);
    expect(areas[3].bounds.y).toBe(421);
  });

  it("assigns correct actions to areas", () => {
    const actions = [
      messageAction("Help", "/help"),
      messageAction("Status", "/status"),
      messageAction("Settings", "/settings"),
      messageAction("About", "/about"),
      messageAction("Feedback", "/feedback"),
      messageAction("Contact", "/contact"),
    ] as [
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
    ];

    const areas = createGridLayout(843, actions);

    expect((areas[0].action as { text: string }).text).toBe("/help");
    expect((areas[1].action as { text: string }).text).toBe("/status");
    expect((areas[2].action as { text: string }).text).toBe("/settings");
    expect((areas[3].action as { text: string }).text).toBe("/about");
    expect((areas[4].action as { text: string }).text).toBe("/feedback");
    expect((areas[5].action as { text: string }).text).toBe("/contact");
  });
});

describe("createDefaultMenuConfig", () => {
  it("has expected default commands", () => {
    const config = createDefaultMenuConfig();

    const commands = config.areas.map((a) => (a.action as { text: string }).text);
    expect(commands).toContain("/help");
    expect(commands).toContain("/status");
    expect(commands).toContain("/settings");
  });
});
