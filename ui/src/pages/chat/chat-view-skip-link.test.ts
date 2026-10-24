/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { t } from "../../i18n/index.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { renderChatView, requireElement } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

// The transcript's focusable controls precede the composer in tab order, so a
// keyboard bypass must sit before the transcript region (issue #180815). Tab
// ordering and normal-composer activation are covered end to end in
// chat-composer-skip-link.e2e.test.ts; these jsdom cases cover the states the
// browser suite cannot reach cheaply.
beforeEach(() => {
  installTranscriptDomMocks();
});

afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

describe("chat composer skip link", () => {
  it("does not render for embedded suggestion composers", () => {
    const container = renderChatView({ suggestionComposer: true });
    expect(container.querySelector("button.chat-skip-link")).toBeNull();
  });

  it("focuses the recovery banner when the composer is replaced", () => {
    const container = renderChatView({
      disabledBanner: {
        kind: "composer-replacement",
        icon: "archive",
        text: t("chat.archivedSessionDisabled"),
        actionLabel: t("common.unarchive"),
        onAction: () => {},
      },
    });
    // The replacement banner removes the textarea, so the bypass has no
    // composer to focus and must land on the recovery surface instead.
    expect(container.querySelector(".agent-chat__composer-combobox > textarea")).toBeNull();
    const banner = requireElement(
      container,
      ".agent-chat__disabled-banner",
      "recovery banner",
    ) as HTMLElement;
    expect(document.activeElement).not.toBe(banner);
    const skipLink = requireElement(
      container,
      "button.chat-skip-link",
      "composer skip link",
    ) as HTMLButtonElement;
    skipLink.click();
    // The banner becomes a programmatic-only focus target; its recovery
    // action stays in the tab order as the next stop.
    expect(document.activeElement).toBe(banner);
    expect(banner.getAttribute("tabindex")).toBe("-1");
    const recovery = requireElement(
      container,
      ".agent-chat__disabled-banner button",
      "banner recovery action",
    ) as HTMLButtonElement;
    expect(recovery.getAttribute("tabindex")).toBeNull();
  });

  it("focuses the footer when the composer is unavailable without a recovery action", () => {
    const container = renderChatView({
      disabledBanner: {
        kind: "composer-replacement",
        presentation: "hidden",
        text: t("chat.archivedSessionDisabled"),
      },
    });
    const footer = requireElement(container, ".chat-footer", "chat footer") as HTMLElement;
    const skipLink = requireElement(
      container,
      "button.chat-skip-link",
      "composer skip link",
    ) as HTMLButtonElement;
    skipLink.click();
    // The footer itself becomes a programmatic-only focus target.
    expect(document.activeElement).toBe(footer);
    expect(footer.getAttribute("tabindex")).toBe("-1");
  });
});
