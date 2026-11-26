import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  createComposerContainer,
  createComposerProps,
  findPrimaryButton,
  renderComposerInto,
  resetComposerFixture,
} from "../chat-composer.test-support.ts";
import { getChatComposerState } from "./chat-composer-state.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";

const initialViewport = { width: window.innerWidth, height: window.innerHeight };
const initialTheme = document.documentElement.dataset.themeMode;

afterEach(async () => {
  await resetComposerFixture();
  if (initialTheme === undefined) {
    delete document.documentElement.dataset.themeMode;
  } else {
    document.documentElement.dataset.themeMode = initialTheme;
  }
  await page.viewport(initialViewport.width, initialViewport.height);
});

it.each([390, 1100])(
  "presents an injected original-only review and delegates its choice at %ipx",
  async (width) => {
    await page.viewport(width, 1050);
    document.documentElement.dataset.themeMode = "dark";
    const host = document.body.appendChild(document.createElement("main"));
    host.className = "chat";
    host.style.cssText = "position: relative; width: 100%; height: 100dvh";
    const footer = host.appendChild(document.createElement("div"));
    footer.className = "chat-footer";
    footer.style.cssText =
      "position: absolute; bottom: 0; left: 0; right: 0; --chat-footer-max-height: 80dvh";
    const container = createComposerContainer();
    container.style.width = "100%";
    footer.append(container);
    const props = createComposerProps({
      draft: "Please check this draft.",
      composerCorrections: { version: 1, mode: "explicit", locale: "en-US" },
      onToggleRealtimeTalk: vi.fn(),
    });
    renderComposerInto(container, props);
    await expect
      .element(page.getByRole("combobox", { name: "Spoken corrections" }))
      .toHaveValue("explicit");
    await page.screenshot({ path: `.artifacts/m03-review/composer-${width}-before-review.png` });

    const dictation = getChatComposerState(props.paneId).dictation;
    if (!dictation) {
      throw new Error("expected the composer dictation owner");
    }
    const original = "I work Tuesday, no Wednesday shifts are available";
    // Presentation only: no capture was admitted and no audio or transport is exercised.
    vi.spyOn(dictation, "correctionCommitRequired", "get").mockReturnValue(true);
    vi.spyOn(dictation, "correctionReview", "get").mockReturnValue({
      original,
      canKeepOriginal: true,
      invalidated: false,
    });
    renderComposerInto(container, props);
    await waitForSolid(() =>
      expect(container.querySelector(".composer-correction-review")).not.toBeNull(),
    );
    await expect
      .element(page.getByText("The recognized text needs your review. No correction was applied."))
      .toBeVisible();
    await expect
      .element(
        page.getByText(
          "Spoken corrections are unavailable. The recognized text has been kept unchanged.",
        ),
      )
      .toBeVisible();
    const originalRegion = page.getByRole("region", { name: "Original recognized text" });
    await expect.element(originalRegion).toHaveTextContent(original);
    expect(container.querySelector(".composer-correction-review details")).toBeNull();
    const accept = page.getByRole("button", { name: "Accept correction" });
    await expect.element(accept).toBeDisabled();
    expect(accept.element().closest(".agent-chat__input")).toBeNull();
    expect(findPrimaryButton(container).disabled).toBe(true);
    expect(props.onSend).not.toHaveBeenCalled();
    const shell = container.querySelector(".agent-chat__composer-shell")!.getBoundingClientRect();
    expect(shell.left).toBeGreaterThanOrEqual(0);
    expect(shell.right).toBeLessThanOrEqual(window.innerWidth);
    expect(shell.top).toBeGreaterThanOrEqual(0);
    expect(shell.bottom).toBeLessThanOrEqual(window.innerHeight);
    await page.screenshot({ path: `.artifacts/m03-review/composer-${width}-pending-review.png` });

    const resolve = vi.spyOn(dictation, "resolveCorrection");
    (originalRegion.element() as HTMLElement).focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(
      page.getByRole("region", { name: "Proposed correction" }).element(),
    );
    await userEvent.tab();
    expect(document.activeElement).toBe(
      page.getByRole("button", { name: "Cancel", exact: true }).element(),
    );
    await userEvent.tab();
    expect(document.activeElement).toBe(
      page.getByRole("button", { name: "Keep original" }).element(),
    );
    await userEvent.keyboard("{Enter}");
    expect(resolve).toHaveBeenCalledExactlyOnceWith("original");
    // The unmodified owner refuses insertion because the presentation fixture has no capture.
    expect(resolve).toHaveReturnedWith(false);
    expect(props.onDraftChange).not.toHaveBeenCalled();
    expect(props.onSend).not.toHaveBeenCalled();
  },
);
