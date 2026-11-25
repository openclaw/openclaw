import { expect, it, onTestFinished } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../styles/base.css";
import "./markdown-mermaid.tsx";

it("opens the shared viewer from the preview and returns keyboard focus", async () => {
  const diagram = document.createElement("openclaw-mermaid");
  diagram.source = "flowchart LR\n  Draft --> Review --> Ship";
  document.body.append(diagram);
  onTestFinished(() => {
    diagram.remove();
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
  });
  await diagram.updateComplete;
  const preview = page.getByRole("button", { name: "Expand diagram", exact: true });
  // Native actionability waits for the cold renderer, rather than polling its startup time.
  await preview.click();
  const image = diagram.querySelector<HTMLImageElement>(".preview img")!;
  await image.decode();
  const button = diagram.querySelector<HTMLButtonElement>("button.preview")!;

  for (const activation of ["click", "{Enter}", " "]) {
    if (activation !== "click") {
      button.focus();
      await userEvent.keyboard(activation);
    }
    await expect.poll(() => diagram.querySelector("dialog")?.open).toBe(true);
    const viewer = diagram.querySelector("openclaw-image-lightbox")!;
    expect(viewer.src).toBe(image.src);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => diagram.querySelector("openclaw-image-lightbox")).toBeNull();
    if (activation !== "click") {
      expect(document.activeElement).toBe(button);
      expect(button.matches(":focus-visible")).toBe(true);
      expect(getComputedStyle(button).outlineStyle).toBe("solid");
      expect(getComputedStyle(button).outlineWidth).toBe("2px");
    }
  }
});
