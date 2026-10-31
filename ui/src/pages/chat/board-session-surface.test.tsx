/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { describe, expect, it, onTestFinished } from "vitest";
import { PRESENTATION_CHANGED_EVENT } from "../../lib/presentation.ts";
import { createMockBoardProvider } from "../../test-helpers/board-provider.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { BoardSessionSurface, type BoardSessionSurfaceProps } from "./board-session-surface.tsx";

describe("board session shell", () => {
  it.each(["rendered", "parked"] as const)(
    "preserves the board while a %s parent activates and parks it",
    async (parent) => {
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
      const container = document.body.appendChild(document.createElement("div"));
      onTestFinished(() => container.remove());
      const mount = () => mountSolid(() => <BoardSessionSurface {...current()} />, { container });
      const present = (next: boolean) => {
        active = next;
        if (parent === "parked") {
          owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
        } else {
          setCurrent({ ...props, active: next, session: { ...props.session } });
        }
        flush();
      };
      let mounted = mount();
      flush();
      await waitForSolid(() =>
        expect(container.querySelector("openclaw-board-view")?.active).toBe(true),
      );
      const board = container.querySelector("openclaw-board-view");
      expect(board?.active).toBe(true);
      const session = board?.session;

      present(false);
      const hiddenSurface = container.querySelector<HTMLElement>(".board-session-surface");
      expect(hiddenSurface?.hidden).toBe(true);
      expect(hiddenSurface?.hasAttribute("inert")).toBe(true);
      expect(container.querySelector("openclaw-board-view")).toBe(board);
      expect(board?.active).toBe(false);
      expect(board?.session).toBe(session);

      present(true);
      expect(container.querySelector("openclaw-board-view")).toBe(board);
      expect(container.querySelector<HTMLElement>(".board-session-surface")?.hidden).toBe(false);
      expect(board?.active).toBe(true);
      expect(board?.session).toBe(session);
      if (parent === "parked") {
        mounted.unmount();
        active = false;
        owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
        expect(board?.active).toBe(true);
        mounted = mount();
        flush();
        await waitForSolid(() =>
          expect(container.querySelector("openclaw-board-view")?.active).toBe(false),
        );
        const replacement = container.querySelector("openclaw-board-view");
        expect(replacement).not.toBe(board);
        expect(replacement?.active).toBe(false);
        present(true);
        expect(replacement?.active).toBe(true);
      }
      mounted.unmount();
    },
  );
});
