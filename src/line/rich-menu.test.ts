import { describe, expect, it } from "vitest";
import { createGridLayout, messageAction } from "./rich-menu.js";

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
});
