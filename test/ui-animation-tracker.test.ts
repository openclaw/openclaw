import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { trackInspectedAnimations } from "../ui/src/e2e/animation-tracker.test-support.ts";

describe("CDP transition lifetime", () => {
  it("removes canceled IDs before a seek and retains the live transition", () => {
    const inspector = new EventEmitter();
    const active = trackInspectedAnimations(inspector);
    inspector.emit("Animation.animationStarted", {
      animation: { id: "old", name: "height", type: "CSSTransition", source: { duration: 250 } },
    });
    inspector.emit("Animation.animationStarted", {
      animation: {
        id: "current",
        name: "height",
        type: "CSSTransition",
        source: { duration: 250 },
      },
    });
    inspector.emit("Animation.animationCanceled", { id: "old" });
    expect([...active.keys()]).toEqual(["current"]);
    expect(active.get("current")?.source?.duration).toBe(250);
    inspector.emit("Animation.animationCanceled", { id: "current" });
    expect(active.size).toBe(0);
  });

  it("tracks reversed transitions without reintroducing canceled or non-transition IDs", () => {
    const inspector = new EventEmitter();
    const active = trackInspectedAnimations(inspector);
    inspector.emit("Animation.animationStarted", {
      animation: { id: "opening", name: "height", type: "CSSTransition" },
    });
    active.clear();
    inspector.emit("Animation.animationCanceled", { id: "opening" });
    inspector.emit("Animation.animationStarted", {
      animation: { id: "unrelated", name: "spinner", type: "CSSAnimation" },
    });
    inspector.emit("Animation.animationStarted", {
      animation: { id: "closing", name: "height", type: "CSSTransition" },
    });
    expect([...active.keys()]).toEqual(["closing"]);
  });
});
