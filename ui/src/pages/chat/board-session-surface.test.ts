/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { PRESENTATION_CHANGED_EVENT } from "../../lit/presentation-binding.ts";
import { createMockBoardProvider } from "../../test-helpers/board-provider.ts";
import { renderBoardSessionSurface } from "./board-session-surface.tsx";

const containers: HTMLElement[] = [];

function createContainer() {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  return container;
}

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

describe("board session shell", () => {
  it.each(["rendered", "parked"] as const)(
    "preserves the board while a %s parent activates and parks it",
    (parent) => {
      const container = createContainer();
      const provider = createMockBoardProvider("agent:main:main");
      const owner = new EventTarget();
      let active = true;
      const props = {
        active:
          parent === "parked" ? { owner, isPresented: () => active, preview: () => true } : true,
        session: { sessionKey: "agent:main:main" },
        snapshot: provider.snapshot$.value,
        activeTabId: "main",
        canMutate: true,
        canGrant: true,
        callbacks: {
          applyOps: (ops: Parameters<typeof provider.applyOps>[0]) => provider.applyOps(ops),
          grant: (...args: Parameters<typeof provider.grant>) => provider.grant(...args),
          selectTab: () => {},
        },
        widgetFrameUrl: (name: string, revision: number) => provider.widgetFrameUrl(name, revision),
      };

      render(renderBoardSessionSurface(props), container);
      flush();
      const board = container.querySelector("openclaw-board-view");
      expect(board?.active).toBe(true);

      active = false;
      if (parent === "parked") {
        owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
      } else {
        render(renderBoardSessionSurface({ ...props, active: false }), container);
      }
      flush();
      const hiddenSurface = container.querySelector<HTMLElement>(".board-session-surface");
      expect(hiddenSurface?.hidden).toBe(true);
      expect(hiddenSurface?.hasAttribute("inert")).toBe(true);
      expect(container.querySelector("openclaw-board-view")).toBe(board);
      expect(board?.active).toBe(false);

      active = true;
      if (parent === "parked") {
        owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
      } else {
        render(renderBoardSessionSurface(props), container);
      }
      flush();
      expect(container.querySelector("openclaw-board-view")).toBe(board);
      expect(container.querySelector<HTMLElement>(".board-session-surface")?.hidden).toBe(false);
      expect(board?.active).toBe(true);
      if (parent === "parked") {
        render(nothing, container);
        active = false;
        owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
        expect(board?.active).toBe(true);
        render(renderBoardSessionSurface(props), container);
        flush();
        const replacement = container.querySelector("openclaw-board-view");
        expect(replacement).not.toBe(board);
        expect(replacement?.active).toBe(false);
        active = true;
        owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
        flush();
        expect(replacement?.active).toBe(true);
      }
    },
  );
});
