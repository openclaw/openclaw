/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderComposerFixture,
  resetComposerFixture,
  renderComposerInto,
} from "./chat-composer.test-support.ts";

afterEach(() => resetComposerFixture());

type Banner = NonNullable<Parameters<typeof renderComposerFixture>[0]>["disabledBanner"];
function bannerProps(overrides: Partial<NonNullable<Banner>> = {}) {
  return {
    kind: "composer-replacement" as const,
    text: "This session is archived.",
    actionLabel: "Unarchive",
    onAction: vi.fn(),
    ...overrides,
  };
}

function drawBanner(overrides: Partial<NonNullable<Banner>> = {}) {
  const view = renderComposerFixture({ canSend: false, disabledBanner: bannerProps(overrides) });
  const banner = view.container.querySelector(".agent-chat__disabled-banner")!;
  return { ...view, banner, action: banner.querySelector<HTMLButtonElement>("button")! };
}

function expectClasses(element: Element, classes: string) {
  expect(new Set(element.classList)).toEqual(new Set(classes.split(" ")));
}

describe("archived session composer banner", () => {
  it("keeps the focused action through a banner refresh and uses the current action", () => {
    const initialAction = vi.fn();
    const refreshedAction = vi.fn();
    const { container, props, action, banner } = drawBanner({ onAction: initialAction });
    document.body.append(container);
    action.focus();
    expectClasses(
      action.parentElement!,
      "agent-chat__disabled-banner agent-chat__disabled-banner--replacement callout info callout--action",
    );

    renderComposerInto(container, {
      ...props,
      disabledBanner: bannerProps({
        text: "This session is still archived.",
        onAction: refreshedAction,
      }),
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
    const { action } = drawBanner({ disabledReason: reason, onAction });
    expect(action?.disabled).toBe(true);
    expect(action?.title).toBe(reason);
    action?.click();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("renders a standard primary action with progress feedback", () => {
    const { banner, action } = drawBanner({
      title: "This task was interrupted by a restart.",
      text: "Your transcript is safe. Resume to continue in this session.",
      tone: "neutral",
      icon: "warning",
      actionLabel: "Resume",
      actionStyle: "primary",
      busy: true,
      busyLabel: "Resuming…",
    });
    expectClasses(
      banner,
      "agent-chat__disabled-banner agent-chat__disabled-banner--replacement callout agent-chat__disabled-banner--neutral callout--action",
    );
    expect(banner?.querySelector(".agent-chat__disabled-banner-icon")).not.toBeNull();
    expect(banner?.querySelector(".agent-chat__disabled-banner-title")?.textContent).toContain(
      "This task was interrupted by a restart.",
    );
    expect(banner?.querySelector(".agent-chat__disabled-banner-detail")?.textContent).toContain(
      "Your transcript is safe. Resume to continue in this session.",
    );
    expectClasses(action, "btn btn--sm primary");
    expect(action?.disabled).toBe(true);
    expect(action?.getAttribute("aria-busy")).toBe("true");
    expect(action?.textContent).toContain("Resuming…");
    expect(action?.querySelector(".btn__spinner")).not.toBeNull();
  });
});
