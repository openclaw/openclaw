/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderAgentAvatarFace } from "./agent-avatar-face.ts";

function face(id: string) {
  const container = document.createElement("div");
  render(renderAgentAvatarFace(id), container);
  return container.querySelector("svg")!;
}

describe("default agent face", () => {
  it("keeps an agent's artwork deterministic across render order", () => {
    const first = face("forge").outerHTML;
    face("scout");
    expect(face("forge").outerHTML).toBe(first);
    expect(face("scout").outerHTML).not.toBe(first);
  });

  it("fills the circular avatar with self-contained vector artwork", () => {
    for (let index = 0; index < 32; index++) {
      const avatar = face(`agent-${index}`);
      expect(avatar.getAttribute("viewBox")).toBe("0 0 32 32");
      const background = avatar.firstElementChild!;
      expect(background.tagName).toBe("circle");
      expect(background.getAttribute("cx")).toBe("16");
      expect(background.getAttribute("cy")).toBe("16");
      expect(background.getAttribute("r")).toBe("16");
      expect(background.getAttribute("fill")).toMatch(/^hsl\(/);
      expect(avatar.querySelector("filter, image, foreignObject, use")).toBeNull();
    }
  });
});
