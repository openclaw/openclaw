import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import type { ProgressCard } from "@openclaw/gateway-protocol";
import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import type { ChatDetailsProgress } from "./chat-details-progress.tsx";
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
async function fixture(value = props()) {
  const styles = document.createElement("style");
  styles.textContent = [baseStyles, progressStyles, detailsStyles].join("\n");
  document.head.append(styles);
  const frame = document.createElement("div");
  frame.className = "chat-main__conversation-frame";
  frame.style.cssText = "position:relative;width:600px;height:560px;margin-left:20px";
  const footer = document.createElement("div");
  footer.className = "chat-footer";
  footer.style.cssText = "position:absolute;bottom:0;width:100%;height:100px";
  document.body.append(frame);
  const view = mountSolid(() => createComponent(ChatDetails, { props: value, presented: true }), {
    container: frame,
  });
  const element = view.container.querySelector("openclaw-chat-details")!;
  frame.append(footer);
  mounted.push(frame, styles);
  await element.updateComplete;
  const session = element.querySelector<ChatDetailsSession>("openclaw-chat-details-session")!;
  const progress = element.querySelector<ChatDetailsProgress>("openclaw-chat-details-progress")!;
  await session.updateComplete;
  await progress?.updateComplete;
  return {
    element,
    frame,
    footer,
    session,
    progress,
    panel: element.querySelector<HTMLElement>(".chat-details")!,
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
    panel.querySelector<HTMLButtonElement>("button")!.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await element.updateComplete;
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("collapses session details and progress independently without revisions reopening them", async () => {
    const { element, trigger, session, progress } = await fixture();
    trigger.click();
    await element.updateComplete;
    await session.updateComplete;
    await progress.updateComplete;
    const sessionSection = session.querySelector<HTMLDetailsElement>(".chat-details-session")!;
    const progressSection = progress.querySelector<HTMLDetailsElement>(".session-progress-card")!;
    expect(sessionSection.open).toBe(true);
    expect(progressSection.open).toBe(true);
    expect(
      session.querySelector<HTMLDetailsElement>('[data-details-group="pull-requests"]')!.open,
    ).toBe(false);
    expect(
      session.querySelector<HTMLDetailsElement>('[data-details-group="automations"]')!.open,
    ).toBe(false);
    await toggle(sessionSection);
    await session.updateComplete;
    expect(progressSection.open).toBe(true);
    await toggle(progressSection);
    expect(progressSection.open).toBe(false);
    expect(getComputedStyle(progress.querySelector(".chat-details-progress__menu")!).display).toBe(
      "none",
    );
    element.props = { ...element.props!, progressCard: { ...card, revision: 3 } };
    await element.updateComplete;
    await progress.updateComplete;
    expect(sessionSection.open).toBe(false);
    expect(progressSection.open).toBe(false);
    await toggle(sessionSection);
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
    await progress.updateComplete;
    const menu = progress.querySelector<WaDropdown>("wa-dropdown")!;
    menu.querySelector<HTMLButtonElement>("button")!.click();
    await menu.updateComplete;
    expect(menu.open).toBe(true);
    expect(progress.querySelector<HTMLDetailsElement>(".session-progress-card")!.open).toBe(true);
    const select = (value: string) =>
      menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value } } }));
    select("hide");
    expect(hide).toHaveBeenCalledOnce();
    expect(clear).not.toHaveBeenCalled();
    menu.querySelector<HTMLElement>('wa-dropdown-item[value="collapse"]')!.click();
    await menu.updateComplete;
    expect(collapse).toHaveBeenCalledWith(true);
    expect(progress.querySelector<HTMLDetailsElement>(".session-progress-card")!.open).toBe(true);
    select("settings");
    expect(settings).toHaveBeenCalledOnce();
    progress.querySelector<HTMLButtonElement>(".session-progress-card__dismiss")!.click();
    expect(dismiss).toHaveBeenCalledWith(card);
    expect(clear).not.toHaveBeenCalled();
    progress
      .querySelector<HTMLButtonElement>('.session-progress-card__refresh[data-state="idle"]')!
      .click();
    expect(refresh).toHaveBeenCalledWith(card);
    select("clear");
    expect(clear).toHaveBeenCalledWith(card);
    element.presented = false;
    await element.updateComplete;
    await progress.updateComplete;
    select("hide");
    expect(hide).toHaveBeenCalledTimes(1);
  });
});
