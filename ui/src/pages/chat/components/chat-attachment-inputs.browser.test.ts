import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { createChatAttachmentInputHandle } from "./chat-attachment-inputs.ts";
import "../../../styles/chat/composer.css";

it("anchors the native picker to its trigger inside layout containment", async () => {
  const container = document.createElement("div");
  container.style.cssText = "position:relative;contain:layout;margin-top:54px;height:200px";
  const trigger = document.createElement("button");
  trigger.textContent = "Attach";
  trigger.style.cssText = "position:absolute;left:40px;top:80px;width:32px;height:32px";
  const input = document.createElement("input");
  input.type = "file";
  input.className = "agent-chat__file-input";
  container.append(trigger, input);
  document.body.append(container);
  const handle = createChatAttachmentInputHandle();
  const releaseInputs = handle.bindInputs({ inputs: { file: input } });
  const releaseAnchor = handle.bindAnchor(trigger);
  let geometry: { input: DOMRect; trigger: DOMRect } | undefined;
  trigger.addEventListener("click", () => handle.open("file"));
  input.addEventListener("click", (event) => {
    event.preventDefault();
    geometry = { input: input.getBoundingClientRect(), trigger: trigger.getBoundingClientRect() };
  });
  try {
    await userEvent.click(trigger);
    expect(geometry).toBeDefined();
    expect(geometry!.trigger.top).toBeGreaterThan(80);
    for (const axis of ["left", "top", "width", "height"] as const) {
      expect(geometry!.input[axis]).toBeCloseTo(geometry!.trigger[axis], 1);
    }
  } finally {
    releaseAnchor();
    releaseInputs();
    container.remove();
  }
});
