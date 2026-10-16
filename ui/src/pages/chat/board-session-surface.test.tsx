/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { PRESENTATION_CHANGED_EVENT } from "../../lib/presentation.ts";
import { createMockBoardProvider } from "../../test-helpers/board-provider.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { BoardSessionSurface, type BoardSessionSurfaceProps } from "./board-session-surface.tsx";

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

      const [current, setCurrent] = createSignal<BoardSessionSurfaceProps>(props);
      const mount = () =>
        mountSolid(
          () => (
            <BoardSessionSurface
              active={current().active}
              session={current().session}
              snapshot={current().snapshot}
              activeTabId={current().activeTabId}
              pageWidgetName={current().pageWidgetName}
              canMutate={current().canMutate}
              canGrant={current().canGrant}
              callbacks={current().callbacks}
              widgetFrameUrl={current().widgetFrameUrl}
            />
          ),
          { container },
        );
      let mounted = mount();
      flush();
      const board = container.querySelector("openclaw-board-view");
      expect(board?.active).toBe(true);

      active = false;
      if (parent === "parked") {
        owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
      } else {
        setCurrent({ ...props, active: false });
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
        setCurrent(props);
      }
      flush();
      expect(container.querySelector("openclaw-board-view")).toBe(board);
      expect(container.querySelector<HTMLElement>(".board-session-surface")?.hidden).toBe(false);
      expect(board?.active).toBe(true);
      if (parent === "parked") {
        mounted.unmount();
        active = false;
        owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
        expect(board?.active).toBe(true);
        mounted = mount();
        flush();
        const replacement = container.querySelector("openclaw-board-view");
        expect(replacement).not.toBe(board);
        expect(replacement?.active).toBe(false);
        active = true;
        owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
        flush();
        expect(replacement?.active).toBe(true);
      }
      mounted.unmount();
    },
  );
});
