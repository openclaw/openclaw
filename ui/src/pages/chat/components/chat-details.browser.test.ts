import type { ProgressCard } from "@openclaw/gateway-protocol";
import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import type { ChatDetailsSession } from "./chat-details-session.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import { ChatDetails } from "./chat-details.tsx";
import baseStyles from "../../../styles/base.css?inline";
import detailsStyles from "../../../styles/chat/details.css?inline";
import progressStyles from "../../../styles/chat/progress-card.css?inline";

const card: ProgressCard = {
  sessionKey: "agent:main:details",
  revision: 1,
  updatedAt: 1_000,
  steps: [
    { step: "Inspect layout", status: "completed" },
    { step: "Verify the change", status: "in_progress" },
  ],
};
const mounted: HTMLElement[] = [];
function props(overrides: Partial<ChatDetailsProps> = {}): ChatDetailsProps {
  return {
    sessionKey: card.sessionKey,
    currentAgentId: "main",
    selectedSession: { key: card.sessionKey, kind: "direct" },
    messages: [],
    gatewayScope: {},
    progressCard: card,
    progressCardLifetime: {},
    progressCardIdentity: card.sessionKey,
    detailsWorkspace: { root: "/workspace/details", label: "details" },
    ...overrides,
  };
}
async function fixture(value = props(), width = 600, fullscreen = false) {
  const styles = document.createElement("style");
  styles.textContent = [baseStyles, progressStyles, detailsStyles].join("\n");
  document.head.append(styles);
  const frame = document.createElement("div");
  frame.className = "chat-main__conversation-frame";
  frame.style.cssText = `position:relative;width:${width}px;height:560px;margin-left:20px`;
  const conversation = document.createElement("div");
  conversation.className = "chat-main__conversation";
  conversation.style.cssText =
    "position:absolute;inset-block:0;inset-inline-start:0;inset-inline-end:var(--chat-details-space,0px)";
  const footer = document.createElement("div");
  footer.className = "chat-footer";
  footer.style.cssText = "position:absolute;bottom:0;width:100%;height:100px";
  const pane = document.createElement("openclaw-chat-pane");
  pane.className = "sidebar-region";
  pane.style.cssText = `display:block;position:relative;width:${width}px;height:640px;margin:30px 20px`;
  pane.append(frame);
  frame.hidden = fullscreen;
  const header = document.createElement("div");
  if (fullscreen) {
    pane.prepend(header);
  }
  document.body.append(pane);
  const view = mountSolid(
    () =>
      createComponent(ChatDetails, {
        props: value,
        presented: true,
        conversationVisible: !fullscreen,
        externalTrigger: fullscreen,
      }),
    { container: fullscreen ? header : frame },
  );
  const element = view.container.querySelector("openclaw-chat-details")!;
  conversation.append(footer);
  frame.append(conversation);
  mounted.push(pane, styles);
  await element.updateComplete;
  const session = pane.querySelector<ChatDetailsSession>("openclaw-chat-details-session")!;
  const progress = pane.querySelector<HTMLElement>("openclaw-chat-details-progress")!;
  await session.updateComplete;
  flush();
  return {
    element,
    frame,
    pane,
    footer,
    session,
    progress,
    conversation,
    panel: pane.querySelector<HTMLElement>(".chat-details")!,
    trigger: element.querySelector<HTMLButtonElement>(".chat-details-toggle")!,
  };
}
async function toggle(details: HTMLDetailsElement) {
  const changed = new Promise<void>((resolve) => {
    details.addEventListener("toggle", () => resolve(), { once: true });
  });
  details.querySelector<HTMLElement>(":scope > summary")!.click();
  await changed;
}
afterEach(() => {
  for (const element of mounted.splice(0)) {
    element.remove();
  }
});

describe("chat Details presentation", () => {
  it("automatically docks within the available pane, preserves intent, and releases its column", async () => {
    await page.viewport(1700, 900);
    const { element, frame, conversation, footer, trigger, panel, session } = await fixture(
      props(),
      1320,
    );
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
    expect(panel.getAttribute("role")).toBe("complementary");
    expect(panel.querySelector(".chat-details__toolbar")).toBeNull();
    const groupStyle = getComputedStyle(panel.querySelector(".chat-details__group")!);
    expect(groupStyle.borderTopWidth).toBe("1px");
    expect(groupStyle.borderInlineStartWidth).toBe("0px");
    expect(groupStyle.borderBottomWidth).toBe("0px");
    expect(panel.matches(":popover-open")).toBe(false);
    expect(conversation.getBoundingClientRect().right).toBeLessThanOrEqual(
      panel.getBoundingClientRect().left,
    );
    expect(footer.getBoundingClientRect().right).toBeLessThanOrEqual(
      panel.getBoundingClientRect().left,
    );
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const metadata = session.querySelector(".chat-details-session")!;
    // A side panel consumes pane width even when the desktop stays wide.
    frame.style.width = "900px";
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
    expect(conversation.getBoundingClientRect().width).toBe(900);
    frame.style.width = "1320px";
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
    expect(session.querySelector(".chat-details-session")).toBe(metadata);
    expect(metadata.querySelector(":scope > summary")).toBeNull();
    trigger.click();
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
    expect(conversation.getBoundingClientRect().width).toBe(1320);
    element.props = { ...element.props!, progressCard: { ...card, revision: 4 } };
    frame.style.width = "900px";
    await element.updateComplete;
    frame.style.width = "1320px";
    element.presented = false;
    await element.updateComplete;
    element.presented = true;
    await element.updateComplete;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.click();
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
    frame.style.width = "600px";
    await expect.poll(() => panel.matches(":popover-open")).toBe(true);
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(conversation.getBoundingClientRect().width).toBe(600);
    frame.style.width = "1320px";
    await expect.poll(() => panel.getAttribute("role")).toBe("complementary");
    expect(panel.matches(":popover-open")).toBe(false);
    element.presented = false;
    await element.updateComplete;
    expect(panel.hidden).toBe(true);
    expect(conversation.getBoundingClientRect().width).toBe(1320);
  });

  it("insets navigation highlights without shifting neighboring environment rows", async () => {
    const openFiles = vi.fn();
    const { element, trigger, panel } = await fixture(props({ onOpenWorkspace: openFiles }));
    trigger.click();
    await element.updateComplete;
    const environment = panel.querySelector(".chat-details__environment")!;
    const navigation = environment.querySelector<HTMLButtonElement>(".chat-details__navigation")!;
    const heading = environment.querySelector("summary")!;
    const workspaceIcon = environment.querySelector(".chat-details__row > svg")!;
    const leadingIcon = navigation.querySelector("svg")!;
    const trailingIcon = navigation.querySelector("svg:last-child")!;
    for (const width of [600, 300]) {
      const frame = panel.closest<HTMLElement>(".chat-main__conversation-frame")!;
      frame.style.width = width + "px";
      window.dispatchEvent(new Event("resize"));
      const row = navigation.getBoundingClientRect();
      expect(leadingIcon.getBoundingClientRect().left - row.left).toBeGreaterThanOrEqual(8);
      expect(row.right - trailingIcon.getBoundingClientRect().right).toBeGreaterThanOrEqual(8);
      expect(leadingIcon.getBoundingClientRect().left).toBe(
        workspaceIcon.getBoundingClientRect().left,
      );
      expect(
        heading.getBoundingClientRect().left +
          Number.parseFloat(getComputedStyle(heading).paddingLeft),
      ).toBe(leadingIcon.getBoundingClientRect().left);
      expect(row.height).toBeGreaterThanOrEqual(36);
      expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
    }
    await page.getByRole("button", { name: "Show session files", exact: true }).hover();
    const beforeFocus = navigation.getBoundingClientRect();
    navigation.focus();
    expect(navigation.getBoundingClientRect().toJSON()).toEqual(beforeFocus.toJSON());
    navigation.click();
    expect(openFiles).toHaveBeenCalledOnce();
  });

  it("starts closed, stays closed on revisions, and returns Escape focus to its labeled trigger", async () => {
    const { element, trigger, panel } = await fixture();
    expect(trigger.textContent).toContain("Details");
    expect(panel.matches(":popover-open")).toBe(false);
    element.props = { ...element.props!, progressCard: { ...card, revision: 2 } };
    await element.updateComplete;
    expect(panel.matches(":popover-open")).toBe(false);
    trigger.click();
    await element.updateComplete;
    expect(panel.matches(":popover-open")).toBe(true);
    expect(panel.querySelector(".chat-details__toolbar")).toBeNull();
    panel.querySelector<HTMLButtonElement>("button")!.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await element.updateComplete;
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("opens full-width mobile Details from Panels and restores focus to that control", async () => {
    await page.viewport(420, 720);
    const { element, frame, trigger, panel } = await fixture(props(), 380);
    element.mobile = true;
    const source = document.createElement("button");
    source.textContent = "Panels";
    frame.prepend(source);
    await element.updateComplete;
    expect(trigger.hidden).toBe(true);
    element.open(source);
    await element.updateComplete;
    expect(panel.matches(":popover-open")).toBe(true);
    expect(panel.getBoundingClientRect().width).toBe(364);
    expect(panel.querySelector(".chat-details__toolbar")).not.toBeNull();
    panel.querySelector<HTMLButtonElement>("button")!.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await element.updateComplete;
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(source);
    element.open(source);
    await element.updateComplete;
    panel.querySelector<HTMLButtonElement>(".chat-details__toolbar button")!.click();
    await element.updateComplete;
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(source);
    element.presented = false;
    await element.updateComplete;
    element.open(source);
    await element.updateComplete;
    expect(panel.matches(":popover-open")).toBe(false);
  });

  it("opens fullscreen Details within the visible pane and returns focus to its external trigger", async () => {
    await page.viewport(1700, 900);
    const { element, pane, frame, trigger, panel } = await fixture(props(), 1320, true);
    const source = document.createElement("button");
    source.textContent = "Session actions";
    pane.prepend(source);
    expect(frame.checkVisibility()).toBe(false);
    expect(trigger.hidden).toBe(true);
    expect(panel.matches(":popover-open")).toBe(false);
    element.open(source);
    await element.updateComplete;
    expect(panel.matches(":popover-open")).toBe(true);
    expect(panel.checkVisibility()).toBe(true);
    expect(frame.contains(panel)).toBe(false);
    expect(pane.contains(panel)).toBe(true);
    expect(panel.getAttribute("role")).toBe("dialog");
    const bounds = panel.getBoundingClientRect();
    const paneBounds = pane.getBoundingClientRect();
    expect(bounds.width).toBe(352);
    expect(bounds.height).toBeGreaterThan(40);
    expect(bounds.left).toBeGreaterThanOrEqual(paneBounds.left);
    expect(bounds.right).toBeLessThanOrEqual(paneBounds.right);
    expect(bounds.top).toBeGreaterThanOrEqual(source.getBoundingClientRect().bottom);
    expect(bounds.bottom).toBeLessThanOrEqual(paneBounds.bottom);
    const close = panel.querySelector<HTMLButtonElement>(".chat-details__toolbar button")!;
    expect(close.checkVisibility()).toBe(true);
    expect(close.getAttribute("aria-label")).toBe("Close details");
    close.focus();
    close.click();
    await element.updateComplete;
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(source);
    element.open(source);
    await element.updateComplete;
    close.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await element.updateComplete;
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(source);
  });

  it("closes Details after its child menu closes", async () => {
    const { element, trigger, panel, progress } = await fixture();
    trigger.click();
    await element.updateComplete;
    const menu = progress.querySelector<HTMLElement>(".chat-details-progress__menu")!;
    const menuSurface = menu.querySelector<HTMLElement>('[role="menu"]')!;
    menu.querySelector<HTMLButtonElement>("button")!.click();
    await expect.poll(() => menuSurface.dataset.phase).toBe("open");
    expect(menuSurface.matches(":popover-open")).toBe(true);
    menu.querySelector<HTMLButtonElement>("button")!.click();
    await expect
      .poll(() => menu.querySelector("button")!.getAttribute("aria-expanded"))
      .toBe("false");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await element.updateComplete;
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps metadata visible while progress retains its collapse across revisions", async () => {
    const { element, trigger, session, progress } = await fixture();
    trigger.click();
    await element.updateComplete;
    await session.updateComplete;
    flush();
    const sessionSection = session.querySelector<HTMLElement>(".chat-details-session")!;
    const progressSection = progress.querySelector<HTMLDetailsElement>(".session-progress-card")!;
    expect(sessionSection.querySelector(":scope > summary")).toBeNull();
    expect(progressSection.open).toBe(true);
    expect(session.querySelector("[data-details-group]")).toBeNull();
    await toggle(progressSection);
    expect(progressSection.open).toBe(false);
    expect(getComputedStyle(progress.querySelector(".chat-details-progress__menu")!).display).toBe(
      "none",
    );
    element.props = { ...element.props!, progressCard: { ...card, revision: 3 } };
    await element.updateComplete;
    flush();
    expect(sessionSection.checkVisibility()).toBe(true);
    expect(progressSection.open).toBe(false);
  });

  it("constrains the popover to its conversation and above the composer after narrowing", async () => {
    const { element, frame, footer, trigger, panel } = await fixture();
    trigger.click();
    await element.updateComplete;
    for (const width of [600, 300]) {
      frame.style.width = width + "px";
      window.dispatchEvent(new Event("resize"));
      const bounds = panel.getBoundingClientRect();
      const conversation = frame.getBoundingClientRect();
      expect(
        Math.abs(
          bounds.top - Math.max(conversation.top + 8, trigger.getBoundingClientRect().bottom + 6),
        ),
      ).toBeLessThanOrEqual(1);
      expect(bounds.left).toBeGreaterThanOrEqual(conversation.left);
      expect(bounds.right).toBeLessThanOrEqual(conversation.right);
      expect(bounds.bottom).toBeLessThanOrEqual(footer.getBoundingClientRect().top);
      expect(bounds.height).toBeGreaterThan(40);
    }
  });

  it("retires the open surface on hidden presentation and session changes", async () => {
    const { element, trigger, panel } = await fixture();
    trigger.click();
    await element.updateComplete;
    element.presented = false;
    await element.updateComplete;
    expect(panel.matches(":popover-open")).toBe(false);
    element.presented = true;
    await element.updateComplete;
    expect(panel.matches(":popover-open")).toBe(false);
    trigger.click();
    await element.updateComplete;
    element.props = {
      ...element.props!,
      sessionKey: "agent:main:other",
      selectedSession: undefined,
    };
    await element.updateComplete;
    expect(panel.matches(":popover-open")).toBe(false);
  });

  it("keeps global browser hide, lifetime dismiss, saved clear and refresh as distinct actions", async () => {
    const hide = vi.fn();
    const dismiss = vi.fn();
    const clear = vi.fn();
    const refresh = vi.fn();
    const collapse = vi.fn();
    const settings = vi.fn();
    const { element, trigger, progress } = await fixture(
      props({
        onHideTaskProgress: hide,
        onDismissProgressCard: dismiss,
        onClearSavedProgressCard: clear,
        onCollapseTaskProgressChange: collapse,
        onOpenTaskProgressSettings: settings,
        progressCardRefresh: { onRefresh: refresh },
      }),
    );
    trigger.click();
    await element.updateComplete;
    flush();
    const menu = progress.querySelector<HTMLElement>(".chat-details-progress__menu")!;
    const menuSurface = menu.querySelector<HTMLElement>('[role="menu"]')!;
    menu.querySelector<HTMLButtonElement>("button")!.click();
    await expect.poll(() => menuSurface.dataset.phase).toBe("open");
    expect(menuSurface.matches(":popover-open")).toBe(true);
    expect(progress.querySelector<HTMLDetailsElement>(".session-progress-card")!.open).toBe(true);
    const select = async (value: string) => {
      if (trigger.getAttribute("aria-expanded") !== "true") {
        trigger.click();
        await element.updateComplete;
        await expect
          .poll(() => menu.querySelector<HTMLButtonElement>("button")!.disabled)
          .toBe(false);
      }
      if (menu.querySelector("button")!.getAttribute("aria-expanded") !== "true") {
        menu.querySelector<HTMLButtonElement>("button")!.click();
        await expect.poll(() => menuSurface.dataset.phase).toBe("open");
      }
      menu.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)!.click();
    };
    await select("hide");
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
    expect(hide).toHaveBeenCalledOnce();
    expect(clear).not.toHaveBeenCalled();
    await select("collapse");
    expect(collapse).toHaveBeenCalledWith(true);
    expect(progress.querySelector<HTMLDetailsElement>(".session-progress-card")!.open).toBe(true);
    await select("settings");
    expect(settings).toHaveBeenCalledOnce();
    progress.querySelector<HTMLButtonElement>(".session-progress-card__dismiss")!.click();
    expect(dismiss).toHaveBeenCalledWith(card);
    expect(clear).not.toHaveBeenCalled();
    progress
      .querySelector<HTMLButtonElement>('.session-progress-card__refresh[data-state="idle"]')!
      .click();
    expect(refresh).toHaveBeenCalledWith(card);
    await select("clear");
    expect(clear).toHaveBeenCalledWith(card);
    element.presented = false;
    await element.updateComplete;
    flush();
    menu.querySelector<HTMLButtonElement>('[data-value="hide"]')!.click();
    expect(hide).toHaveBeenCalledTimes(1);
  });
});
