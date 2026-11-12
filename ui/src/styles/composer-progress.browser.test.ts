import { expect, it } from "vitest";
import { createSessionGoalFixture } from "../../../src/gateway/session-goal.test-support.js";
import { ChatGoal } from "../pages/chat/components/chat-composer-goal.tsx";
import { mountSolid } from "../test-helpers/solid-render.tsx";
import progressStyles from "./chat/composer-progress.css?inline";

it("loads Goal action styling from the standalone processed progress stylesheet", () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  try {
    const document = frame.contentDocument!;
    const style = document.createElement("style");
    style.textContent = `:root { --muted: rgb(51, 68, 85); --radius-sm: 6px; --chat-stack-trailing-control-size: 24px; }\n${progressStyles}`;
    document.head.append(style);
    document.body.innerHTML =
      '<button type="button" class="agent-chat__goal-action"><svg viewBox="0 0 24 24" width="24" height="24"><path d="m8 4 8 8-8 8"/></svg></button>';
    const button = frame.contentWindow!.getComputedStyle(document.querySelector("button")!);
    const svg = frame.contentWindow!.getComputedStyle(document.querySelector("svg")!);
    expect([
      button.display,
      button.width,
      button.height,
      button.padding,
      button.borderWidth,
    ]).toEqual(["inline-flex", "24px", "24px", "0px", "0px"]);
    expect([button.color, button.borderRadius]).toEqual(["rgb(51, 68, 85)", "6px"]);
    expect([
      svg.width,
      svg.height,
      svg.stroke,
      svg.fill,
      svg.strokeWidth,
      svg.strokeLinecap,
      svg.strokeLinejoin,
    ]).toEqual(["14px", "14px", "rgb(51, 68, 85)", "none", "1.75px", "round", "round"]);
  } finally {
    frame.remove();
  }
});

it.each(["active", "paused"] as const)(
  "preserves the %s goal's transport glyph paint and control spacing",
  (status) => {
    const frame = document.createElement("iframe");
    frame.width = "800";
    document.body.append(frame);
    const doc = frame.contentDocument!;
    const style = doc.createElement("style");
    style.textContent = `:root { --muted: rgb(51, 68, 85); --chat-stack-trailing-control-size: 24px; }\n${progressStyles}`;
    doc.head.append(style);
    const view = mountSolid(
      ChatGoal,
      {
        goal: createSessionGoalFixture("goal-icons", "Verify the deployment", { status }),
        expanded: false,
        canAct: true,
        onGoalAction: () => {},
        onExpandedChange: () => {},
      },
      doc.body,
    );
    try {
      const action = status === "active" ? "pause" : "resume";
      const button = doc.querySelector<HTMLButtonElement>(`.agent-chat__goal-${action}`)!;
      const shapes = button.querySelectorAll("svg path, svg rect, svg polygon");
      expect(shapes.length).toBeGreaterThan(0);
      for (const shape of shapes) {
        const paint = frame.contentWindow!.getComputedStyle(shape);
        expect(paint.fill).toBe(status === "active" ? "rgb(51, 68, 85)" : "none");
        expect(paint.stroke).toBe(status === "active" ? "none" : "rgb(51, 68, 85)");
      }
      expect(button.disabled).toBe(false);
      const clear = doc.querySelector(".agent-chat__goal-clear")!;
      const buttonBox = button.getBoundingClientRect();
      const clearBox = clear.getBoundingClientRect();
      expect(buttonBox.height).toBe(24);
      expect(clearBox.top).toBe(buttonBox.top);
      expect(clearBox.left - buttonBox.right).toBe(4);
    } finally {
      view.dispose();
      frame.remove();
    }
  },
);
