/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderComposerFixture,
  resetComposerFixture,
  renderComposerInto,
} from "./chat-composer.test-support.ts";

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
    expect(new Set(banner?.classList)).toEqual(
      new Set([
        "agent-chat__disabled-banner",
        "agent-chat__disabled-banner--replacement",
        "callout",
        "info",
        "callout--action",
      ]),
    );

    renderComposerInto(container, {
      ...props,
      disabledBanner: {
        kind: "composer-replacement",
        text: "This session is still archived.",
        actionLabel: "Unarchive",
        onAction: refreshedAction,
      },
    });

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
        title: "This task was interrupted by a restart.",
        text: "Your transcript is safe. Resume to continue in this session.",
        tone: "neutral",
        icon: "warning",
        actionLabel: "Resume",
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
    expect(new Set(banner?.classList)).toEqual(
      new Set([
        "agent-chat__disabled-banner",
        "agent-chat__disabled-banner--replacement",
        "callout",
        "agent-chat__disabled-banner--neutral",
        "callout--action",
      ]),
    );
    expect(banner?.querySelector(".agent-chat__disabled-banner-icon")).not.toBeNull();
    expect(banner?.querySelector(".agent-chat__disabled-banner-title")?.textContent).toContain(
      "This task was interrupted by a restart.",
    );
    expect(banner?.querySelector(".agent-chat__disabled-banner-detail")?.textContent).toContain(
      "Your transcript is safe. Resume to continue in this session.",
    );
    expect(new Set(action?.classList)).toEqual(new Set(["btn", "btn--sm", "primary"]));
    expect(action?.disabled).toBe(true);
    expect(action?.getAttribute("aria-busy")).toBe("true");
    expect(action?.textContent).toContain("Resuming…");
    expect(action?.querySelector(".btn__spinner")).not.toBeNull();
  });
});
