/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import {
  renderComposerFixture,
  resetComposerFixture,
  renderComposerInto,
} from "./chat-composer.test-support.ts";

afterEach(() => resetComposerFixture());

type Banner = NonNullable<Parameters<typeof renderComposerFixture>[0]>["disabledBanner"];
function drawBanner(overrides: Partial<NonNullable<Banner>> = {}) {
  const view = renderComposerFixture({
    canSend: false,
    disabledBanner: {
      kind: "composer-replacement",
      text: "This session is archived.",
      actionLabel: "Unarchive",
      onAction: vi.fn(),
      ...overrides,
    },
  });
  const banner = view.container.querySelector(".agent-chat__disabled-banner")!;
  const update = (disabledBanner: Banner) =>
    renderComposerInto(view.container, { ...view.props, disabledBanner });
  return { ...view, update, banner, action: banner.querySelector<HTMLButtonElement>("button")! };
}

it.each(["action", "stop"] as const)(
  "keeps %s focus and its current callback through refresh",
  (kind) => {
    const initial = vi.fn();
    const current = vi.fn();
    const controls = (callback: () => void) =>
      kind === "stop"
        ? { actionLabel: undefined, onAction: undefined, stop: { onAbort: callback } }
        : { actionLabel: "Unarchive", onAction: callback };
    const { container, update, banner } = drawBanner(controls(initial));
    const selector = kind === "stop" ? '[aria-label="Stop generating"]' : "button";
    const findAction = () => banner.querySelector<HTMLButtonElement>(selector);
    const action = findAction()!;
    document.body.append(container);
    action.focus();
    const text = "The session status changed.";
    update({ kind: "composer-replacement", text, ...controls(current) });
    expect(banner.textContent).toContain(text);
    expect(container.querySelector(".agent-chat__disabled-banner")).toBe(banner);
    expect(findAction()).toBe(action);
    expect(document.activeElement).toBe(action);
    action.click();
    expect(initial).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
    if (kind === "stop") {
      update({ kind: "composer-replacement", text: "This subagent finished." });
      expect(findAction()).toBeNull();
      expect(current).toHaveBeenCalledOnce();
    }
  },
);

it("disables its action with the mutation reason", () => {
  const onAction = vi.fn();
  const reason = "Operator write access is required.";
  const { action } = drawBanner({ disabledReason: reason, onAction });
  expect(action).toMatchObject({ disabled: true, title: reason });
  action?.click();
  expect(onAction).not.toHaveBeenCalled();
});

it("renders a standard primary action with progress feedback", () => {
  const title = "This task was interrupted by a restart.";
  const text = "Your transcript is safe. Resume to continue in this session.";
  const busyLabel = "Resuming…";
  const { banner, action } = drawBanner({
    title,
    text,
    tone: "neutral",
    icon: "warning",
    actionLabel: "Resume",
    actionStyle: "primary",
    busy: true,
    busyLabel,
  });
  expect(banner.classList.contains("agent-chat__disabled-banner--neutral")).toBe(true);
  expect(banner?.querySelector(".agent-chat__disabled-banner-icon")).not.toBeNull();
  expect(banner.querySelector(".agent-chat__disabled-banner-title")?.textContent).toContain(title);
  expect(banner.querySelector(".agent-chat__disabled-banner-detail")?.textContent).toContain(text);
  expect(action.classList.contains("primary")).toBe(true);
  expect(action).toMatchObject({ disabled: true, textContent: expect.stringContaining(busyLabel) });
  expect(action?.getAttribute("aria-busy")).toBe("true");
  expect(action?.querySelector(".btn__spinner")).not.toBeNull();
});
