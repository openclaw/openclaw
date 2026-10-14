/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderComposerFixture, resetComposerFixture } from "./chat-composer.test-support.ts";
import { renderChatComposer } from "./components/chat-composer-render.test-support.ts";

afterEach(async () => {
  await resetComposerFixture();
});

describe("archived session composer banner", () => {
  it("keeps the focused action through a banner refresh and uses the current action", () => {
    const initialAction = vi.fn();
    const refreshedAction = vi.fn();
    const { container, props } = renderComposerFixture({
      canSend: false,
      disabledBanner: {
        kind: "composer-replacement",
        text: "This session is archived.",
        actionLabel: "Unarchive",
        onAction: initialAction,
      },
    });
    document.body.append(container);
    const action = container.querySelector<HTMLButtonElement>(
      ".agent-chat__disabled-banner button",
    )!;
    action.focus();
    const banner = action.parentElement;

    render(
      renderChatComposer({
        ...props,
        disabledBanner: {
          kind: "composer-replacement",
          text: "This session is still archived.",
          actionLabel: "Unarchive",
          onAction: refreshedAction,
        },
      }),
      container,
    );

    expect(container.querySelector(".agent-chat__disabled-banner")?.textContent).toContain(
      "This session is still archived.",
    );
    expect(container.querySelector(".agent-chat__disabled-banner")).toBe(banner);
    expect(container.querySelector(".agent-chat__disabled-banner button")).toBe(action);
    expect(document.activeElement).toBe(action);
    action.click();
    expect(initialAction).not.toHaveBeenCalled();
    expect(refreshedAction).toHaveBeenCalledOnce();
  });

  it("disables its action with the mutation reason", () => {
    const onAction = vi.fn();
    const reason = "Operator write access is required.";
    const { container } = renderComposerFixture({
      canSend: false,
      disabledBanner: {
        kind: "composer-replacement",
        text: "This session is archived. Unarchive it to continue the conversation.",
        actionLabel: "Unarchive",
        disabledReason: reason,
        onAction,
      },
    });

    const action = container.querySelector<HTMLButtonElement>(
      ".agent-chat__disabled-banner button",
    );
    expect(action?.disabled).toBe(true);
    expect(action?.title).toBe(reason);
    action?.click();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("renders a standard primary action with progress feedback", () => {
    const { container } = renderComposerFixture({
      canSend: false,
      disabledBanner: {
        kind: "composer-replacement",
        title: "This session ended during a restart.",
        text: "Its transcript is safe.",
        tone: "neutral",
        icon: "warning",
        actionLabel: "Resume in new session",
        actionStyle: "primary",
        busy: true,
        busyLabel: "Resuming…",
        onAction: vi.fn(),
      },
    });

    const action = container.querySelector<HTMLButtonElement>(
      ".agent-chat__disabled-banner button",
    );
    const banner = container.querySelector(".agent-chat__disabled-banner");
    expect(banner?.classList.contains("info")).toBe(false);
    expect(banner?.classList.contains("agent-chat__disabled-banner--neutral")).toBe(true);
    expect(banner?.querySelector(".agent-chat__disabled-banner-icon")).not.toBeNull();
    expect(banner?.querySelector(".agent-chat__disabled-banner-title")?.textContent).toContain(
      "This session ended during a restart.",
    );
    expect(banner?.querySelector(".agent-chat__disabled-banner-detail")?.textContent).toContain(
      "Its transcript is safe.",
    );
    expect(action?.classList.contains("primary")).toBe(true);
    expect(action?.disabled).toBe(true);
    expect(action?.getAttribute("aria-busy")).toBe("true");
    expect(action?.textContent).toContain("Resuming…");
    expect(action?.querySelector(".btn__spinner")).not.toBeNull();
  });
});
