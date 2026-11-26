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
import { prepareDictationRefinement } from "../spoken-corrections.ts";
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
  "presents an unsent correction in the production composer at %ipx",
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
    const result = prepareDictationRefinement(
      {
        captureToken: {},
        revision: 0,
        text: "Tell John to call. Change John to James.",
        locale: "en-US",
        isFinal: true,
      },
      { mode: "explicit" },
    );
    expect(result.plan?.edits).toHaveLength(2);
    // The capture owner publishes this presentation after final recognition.
    // No microphone/provider result is claimed by this browser fixture.
    vi.spyOn(dictation, "correctionCommitRequired", "get").mockReturnValue(true);
    vi.spyOn(dictation, "correctionReview", "get").mockReturnValue({
      result,
      canAccept: true,
      canKeepOriginal: true,
      invalidated: false,
    });
    renderComposerInto(container, props);
    await waitForSolid(() =>
      expect(container.querySelector(".composer-correction-review")).not.toBeNull(),
    );
    await expect
      .element(page.getByText("1 proposed correction is ready for review.", { exact: true }))
      .toBeVisible();
    const summary = page.getByText("Inspect changed words", { exact: true });
    await userEvent.click(summary);
    expect(document.activeElement).toBe(summary.element());
    await expect.element(page.getByText("James", { exact: true })).toBeVisible();
    const accept = page.getByRole("button", { name: "Accept correction" });
    await expect.element(accept).toBeEnabled();
    expect(accept.element().closest(".agent-chat__input")).toBeNull();
    expect(findPrimaryButton(container).disabled).toBe(true);
    expect(props.onSend).not.toHaveBeenCalled();
    const shell = container.querySelector(".agent-chat__composer-shell")!.getBoundingClientRect();
    expect(shell.left).toBeGreaterThanOrEqual(0);
    expect(shell.right).toBeLessThanOrEqual(window.innerWidth);
    expect(shell.top).toBeGreaterThanOrEqual(0);
    expect(shell.bottom).toBeLessThanOrEqual(window.innerHeight);
    await page.screenshot({ path: `.artifacts/m03-review/composer-${width}-pending-review.png` });
  },
);
