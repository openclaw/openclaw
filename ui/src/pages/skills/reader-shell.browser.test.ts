import { nothing, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import "../../styles.css";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import { createProps } from "./view.test-support.ts";
import { renderSkills } from "./view.ts";

const browserMode = "__vitest_browser__" in globalThis;
let container: HTMLElement | undefined;

afterEach(() => {
  if (container) {
    render(nothing, container);
    container.remove();
  }
});

describe.runIf(browserMode)("skill reader shell", () => {
  it.each([390, 1440])(
    "keeps a short error compact with Close beside its title at %i px",
    async (width) => {
      const { page, userEvent } = await import("vitest/browser");
      await page.viewport(width, 844);
      container = document.createElement("openclaw-skills-page");
      document.body.append(container);
      render(
        renderSkills(
          createProps({
            clawhubDetailRef: "example-skill",
            clawhubDetailError: "The skill could not be loaded. Try again later.",
          }),
        ),
        container,
      );
      const { modal, dialog } = await getRenderedModalDialog(container);
      await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
      const title = container.querySelector<HTMLElement>(".md-preview-dialog__title")!;
      const close = container.querySelector<HTMLButtonElement>(
        ".md-preview-dialog__header button",
      )!;
      const panel = container.querySelector<HTMLElement>(".md-preview-dialog__panel")!;
      const titleRect = title.getBoundingClientRect();
      const closeRect = close.getBoundingClientRect();
      expect(closeRect.top).toBeLessThan(titleRect.bottom);
      expect(closeRect.left).toBeGreaterThanOrEqual(titleRect.right);
      expect(panel.getBoundingClientRect().height).toBeLessThan(window.innerHeight / 2);
      expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
      expect(modal.label).toBe("example-skill");
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => dialog.open).toBe(false);
    },
  );
});
