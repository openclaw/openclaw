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

  it("bounds artwork to seven silhouettes and ten hues with vector-only geometry", () => {
    const silhouettes = new Set<string | null>();
    const colors = new Set<string | null>();
    for (let index = 0; index < 1000; index++) {
      const avatar = face(`agent-${index}`);
      silhouettes.add(avatar.querySelector("path")!.getAttribute("d"));
      colors.add(avatar.querySelector("rect")!.getAttribute("fill"));
      expect(avatar.getAttribute("viewBox")).toBe("0 0 32 32");
      expect(avatar.querySelector("filter, image, foreignObject")).toBeNull();
    }
    expect(silhouettes.size).toBe(7);
    expect(colors.size).toBe(10);
  });
});
