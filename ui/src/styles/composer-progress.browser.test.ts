import { expect, it } from "vitest";
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
