import type { ProgressCard } from "@openclaw/gateway-protocol";
import { createComponent, createSignal, merge } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatDetailsDesktopBody } from "./chat-details-desktop-body.tsx";
import { ChatDetailsEnvironment } from "./chat-details-environment.tsx";
import type { ChatDetailsSession } from "./chat-details-session.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import { ChatDetails, type ChatDetailsViewProps } from "./chat-details.tsx";
import "../../../styles/components.css";
import baseStyles from "../../../styles/base.css?inline";
import detailsStyles from "../../../styles/chat/details.css?inline";
import layoutStyles from "../../../styles/chat/layout.css?inline";
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
async function fixture(
  value = props(),
  width = 600,
  fullscreen = false,
  nativePresentation?: ChatDetailsViewProps["nativePresentation"],
  contentPending?: boolean,
) {
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
  pane.style.setProperty("--desktop-side-reserve", "0px");
  pane.style.setProperty("--desktop-divider-reserve", "0px");
  pane.append(frame);
  frame.hidden = fullscreen;
  const header = document.createElement("div");
  if (fullscreen) {
    pane.prepend(header);
  }
  document.body.append(pane);
  let details: ChatDetails | undefined;
  const [current, setCurrent] = createSignal<ChatDetailsViewProps>({
    chat: value,
    elements: { pane, frame, footer, header: fullscreen ? header : undefined },
    presentation: true,
    mobile: false,
    nativePresentation,
    contentPending,
    conversationVisible: !fullscreen,
    externalTrigger: fullscreen,
    setRef: (handle) => (details = handle),
  });
  const update = (patch: Partial<ChatDetailsViewProps>) =>
    setCurrent((previous) => ({ ...previous, ...patch }));
  const view = mountSolid(
    () =>
      createComponent(
        ChatDetails,
        merge(() => current()),
      ),
    { container: fullscreen ? header : frame },
  );
  const element = view.container.querySelector("openclaw-chat-details")!;
  conversation.append(footer);
  frame.append(conversation);
  mounted.push(pane, styles);
  flush();
  const progress = pane.querySelector<HTMLElement>("openclaw-chat-details-progress")!;
  return {
    element,
    update,
    updateChat: (patch: Partial<ChatDetailsProps>) =>
      update({ chat: { ...current().chat!, ...patch } }),
    open: (source: HTMLElement) => details?.open(source),
    frame,
    pane,
    footer,
    get session() {
      return pane.querySelector<ChatDetailsSession>("openclaw-chat-details-session")!;
    },
    progress,
    conversation,
    panel: pane.querySelector<HTMLElement>(".chat-details")!,
    trigger: element.querySelector<HTMLButtonElement>(".chat-details-toggle")!,
  };
}
function click(element: HTMLElement) {
  element.click();
  flush();
}
function escape() {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  flush();
}
const expectOpen = (panel: Element, open: boolean) =>
  expect(panel.matches(":popover-open")).toBe(open);
afterEach(() => {
  for (const element of mounted.splice(0)) {
    element.remove();
  }
});

describe("chat Details presentation", () => {
  it.each([undefined, "desktop"] as const)(
    "reserves automatic Details before the first resize delivery (presentation: %s)",
    async (nativePresentation) => {
      vi.stubGlobal("ResizeObserver", undefined);
      try {
        await page.viewport(1700, 900);
        const { conversation, panel } = await fixture(
          props(),
          1320,
          false,
          nativePresentation,
          true,
        );
        expect(panel.hidden).toBe(false);
        expect(getComputedStyle(conversation).right).toBe(
          nativePresentation === "desktop" ? "313px" : "300px",
        );
        if (nativePresentation === "desktop") {
          expect(panel.querySelector(".chat-details-session")).toBeNull();
        }
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each(["transcript paint", "explicit open"] as const)(
    "holds automatic content until %s and retains it through later hydration",
    async (release) => {
      // A cold lazy import must not accidentally satisfy the initial hold assertion.
      await import("./chat-details-session.tsx");
      await page.viewport(1700, 900);
      const { update, open, conversation, trigger, panel } = await fixture(
        props(),
        1320,
        false,
        "desktop",
        true,
      );
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
      expect(panel.getAttribute("role")).toBe("complementary");
      expect(conversation.getBoundingClientRect().right).toBeLessThanOrEqual(
        panel.getBoundingClientRect().left,
      );
      expect(panel.querySelector(".chat-details-session")).toBeNull();

      if (release === "transcript paint") {
        update({ contentPending: false });
      } else {
        open(trigger);
      }
      await expect.poll(() => panel.querySelector(".chat-details-session")).not.toBeNull();
      const session = panel.querySelector(".chat-details-session");
      update({ contentPending: true });
      flush();
      expect(panel.querySelector(".chat-details-session")).toBe(session);
      expect(panel.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
    },
  );

  it("positions above its supplied footer when unrelated matching DOM precedes it", async () => {
    const { updateChat, frame, footer, trigger, panel } = await fixture();
    expect(trigger.textContent).toContain("Details");
    expectOpen(panel, false);
    expect(panel.querySelector("openclaw-chat-details-session")).toBeNull();
    updateChat({ progressCard: { ...card, revision: 2 } });
    flush();
    expectOpen(panel, false);
    const unrelatedFooter = document.createElement("div");
    unrelatedFooter.className = "chat-footer";
    unrelatedFooter.style.cssText = "position:absolute;top:0;height:20px";
    frame.prepend(unrelatedFooter);
    click(trigger);
    expectOpen(panel, true);
    expect(Number.parseFloat(panel.style.maxHeight)).toBeCloseTo(
      footer.getBoundingClientRect().top - 8 - Number.parseFloat(panel.style.top),
    );
  });

  it("aligns the Environment diff below its branch label without shifting on hover or focus", async () => {
    await page.viewport(1000, 800);
    const openChanges = vi.fn();
    const styles = document.createElement("style");
    styles.textContent = [baseStyles, layoutStyles, detailsStyles].join("\n");
    document.head.append(styles);
    const panel = document.createElement("section");
    panel.className = "chat-details";
    panel.setAttribute("data-desktop", "");
    panel.style.cssText = "position:relative;inset:auto;width:600px;max-width:none;height:400px";
    document.body.append(panel);
    mounted.push(panel, styles);
    mountSolid(
      () =>
        createComponent(ChatDetailsDesktopBody, {
          presented: true,
          get children() {
            return createComponent(ChatDetailsEnvironment, {
              details: props({
                detailsWorkspace: {
                  root: "/workspace/details",
                  label: null,
                  branch: "feature/details",
                },
              }),
              presented: true,
              onOpenUncommitted: openChanges,
              uncommitted: {
                sessionKey: card.sessionKey,
                branch: "feature/details",
                baseRef: "HEAD",
                files: [{ path: "example.ts", status: "modified", additions: 3, deletions: 1 }],
                additions: 3,
                deletions: 1,
              },
            });
          },
        }),
      { container: panel },
    );
    flush();
    const heading = panel.querySelector(".chat-details-desktop-section__heading")!;
    const navigation = panel.querySelector<HTMLButtonElement>(
      ".chat-environment__branch-controls button.chat-pr__diff",
    )!;
    const branchLabel = panel.querySelector(".chat-environment__branch-name")!;
    // The scroll owner applies its initial gutter measurement before the first paint.
    await new Promise(requestAnimationFrame);
    expect(navigation.getAttribute("aria-label")).toBe("Show session changes");
    expect(navigation.textContent).toContain("+3");
    expect(navigation.textContent).toContain("−1");
    for (const width of [600, 300]) {
      panel.style.width = width + "px";
      const row = navigation.getBoundingClientRect();
      const headingBounds = heading.getBoundingClientRect();
      const branchBounds = branchLabel.getBoundingClientRect();
      expect(Math.abs(row.left - branchBounds.left)).toBeLessThanOrEqual(1);
      expect(row.top).toBeGreaterThanOrEqual(branchBounds.bottom);
      expect(row.left).toBeGreaterThanOrEqual(headingBounds.left);
      expect(row.right).toBeLessThanOrEqual(headingBounds.right);
      expect(row.height).toBeGreaterThanOrEqual(
        Number.parseFloat(getComputedStyle(navigation).lineHeight),
      );
      expect(navigation.scrollHeight).toBeLessThanOrEqual(navigation.clientHeight);
      expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
    }
    const beforeHover = navigation.getBoundingClientRect().toJSON();
    await page.getByRole("button", { name: "Show session changes", exact: true }).hover();
    expect(navigation.getBoundingClientRect().toJSON()).toEqual(beforeHover);
    navigation.focus();
    expect(navigation.getBoundingClientRect().toJSON()).toEqual(beforeHover);
    await page.getByRole("button", { name: "Show session changes", exact: true }).click();
    expect(openChanges).toHaveBeenCalledOnce();
  });

  it("opens full-width mobile Details from Panels and restores focus to that control", async () => {
    await page.viewport(420, 720);
    const { update, open, frame, trigger, panel } = await fixture(props(), 380);
    update({ mobile: true, contentPending: true });
    const source = document.createElement("button");
    source.textContent = "Panels";
    frame.prepend(source);
    flush();
    expect(trigger.hidden).toBe(true);
    open(source);
    flush();
    expectOpen(panel, true);
    expect(panel.getBoundingClientRect().width).toBe(364);
    expect(panel.querySelector(".chat-details__toolbar")).not.toBeNull();
    await expect.poll(() => panel.querySelector(".chat-details-session")).not.toBeNull();
    panel.querySelector<HTMLButtonElement>("button")!.focus();
    escape();
    expectOpen(panel, false);
    expect(document.activeElement).toBe(source);
    open(source);
    flush();
    panel.querySelector<HTMLButtonElement>(".chat-details__toolbar button")!.click();
    flush();
    expectOpen(panel, false);
    expect(document.activeElement).toBe(source);
    update({ presentation: false });
    flush();
    open(source);
    flush();
    expectOpen(panel, false);
  });

  it("opens fullscreen Details within the visible pane and returns focus to its external trigger", async () => {
    await page.viewport(1700, 900);
    const { open, pane, frame, trigger, panel } = await fixture(props(), 1320, true);
    const source = document.createElement("button");
    source.textContent = "Session actions";
    pane.prepend(source);
    expect(frame.checkVisibility()).toBe(false);
    expect(trigger.hidden).toBe(true);
    expectOpen(panel, false);
    open(source);
    flush();
    expectOpen(panel, true);
    expect(panel.checkVisibility()).toBe(true);
    expect(frame.contains(panel)).toBe(false);
    expect(pane.contains(panel)).toBe(true);
    expect(panel.getAttribute("role")).toBe("dialog");
    const bounds = panel.getBoundingClientRect();
    const paneBounds = pane.getBoundingClientRect();
    expect(bounds.width).toBe(300);
    expect(bounds.height).toBeGreaterThan(40);
    expect(bounds.left).toBeGreaterThanOrEqual(paneBounds.left);
    expect(bounds.right).toBeLessThanOrEqual(paneBounds.right);
    expect(bounds.top).toBeGreaterThanOrEqual(source.getBoundingClientRect().bottom);
    expect(bounds.bottom).toBeLessThanOrEqual(paneBounds.bottom);
    const close = panel.querySelector<HTMLButtonElement>(".chat-details__toolbar button")!;
    expect(close.checkVisibility()).toBe(true);
    expect(close.getAttribute("aria-label")).toBe("Close details");
    close.focus();
    click(close);
    expectOpen(panel, false);
    expect(document.activeElement).toBe(source);
    open(source);
    flush();
    close.focus();
    escape();
    expectOpen(panel, false);
    expect(document.activeElement).toBe(source);
  });

  it("keeps its child menu open through chat updates and closes Details after it closes", async () => {
    const { trigger, panel, progress, updateChat } = await fixture();
    click(trigger);
    const menu = progress.querySelector<HTMLElement>(".chat-details-progress__menu")!;
    const menuSurface = menu.querySelector<HTMLElement>('[role="menu"]')!;
    menu.querySelector<HTMLButtonElement>("button")!.click();
    await expect.poll(() => menuSurface.dataset.phase).toBe("open");
    expectOpen(menuSurface, true);
    updateChat({ messages: [] });
    flush();
    expectOpen(menuSurface, true);
    menu.querySelector<HTMLButtonElement>("button")!.click();
    await expect
      .poll(() => menu.querySelector("button")!.getAttribute("aria-expanded"))
      .toBe("false");
    escape();
    expectOpen(panel, false);
    expect(document.activeElement).toBe(trigger);
  });

  it("constrains the popover to its conversation and above the composer after narrowing", async () => {
    const { frame, footer, trigger, panel } = await fixture();
    click(trigger);
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
    const { update, updateChat, trigger, panel } = await fixture();
    click(trigger);
    update({ presentation: false });
    flush();
    expectOpen(panel, false);
    update({ presentation: true });
    flush();
    expectOpen(panel, false);
    click(trigger);
    updateChat({ sessionKey: "agent:main:other", selectedSession: undefined });
    flush();
    expectOpen(panel, false);
  });

  it("opens progress settings and retires hidden menu actions", async () => {
    const hide = vi.fn();
    const settings = vi.fn();
    const { update, trigger, progress } = await fixture(
      props({
        onHideTaskProgress: hide,
        onOpenTaskProgressSettings: settings,
      }),
    );
    click(trigger);
    flush();
    const menu = progress.querySelector<HTMLElement>(".chat-details-progress__menu")!;
    menu.querySelector<HTMLButtonElement>("button")!.click();
    await expect
      .poll(() => menu.querySelector<HTMLElement>('[role="menu"]')!.dataset.phase)
      .toBe("open");
    menu.querySelector<HTMLButtonElement>('[data-value="settings"]')!.click();
    expect(settings).toHaveBeenCalledOnce();
    update({ presentation: false });
    flush();
    flush();
    menu.querySelector<HTMLButtonElement>('[data-value="hide"]')!.click();
    expect(hide).not.toHaveBeenCalled();
  });
});

it("keeps Environment changes readable with the current callback and omits empty Participants", async () => {
  await page.viewport(1000, 800);
  const openChanges = vi.fn();
  const currentOpenChanges = vi.fn();
  const view = await fixture(
    props({
      onOpenSessionDiff: openChanges,
      environment: {
        uncommitted: {
          sessionKey: card.sessionKey,
          files: [{ path: "app.ts", status: "modified", additions: 248, deletions: 61 }],
          additions: 248,
          deletions: 61,
        },
      },
    }),
    360,
  );
  view.trigger.click();
  const action = () =>
    view.panel.querySelector<HTMLButtonElement>(
      '[data-details-group="environment"] .chat-environment__action',
    )!;
  await expect.poll(() => action()?.textContent).toContain("+248");
  const disclosure = action().closest<HTMLDetailsElement>('[data-details-group="environment"]')!;
  const heading = disclosure.querySelector<HTMLElement>(":scope > summary")!;
  for (const width of [360, 300]) {
    view.frame.style.width = width + "px";
    const row = action().getBoundingClientRect();
    const caption = heading.getBoundingClientRect();
    expect(row.left).toBeGreaterThanOrEqual(caption.left);
    expect(row.right).toBeLessThanOrEqual(caption.right);
    expect(row.top).toBeGreaterThanOrEqual(caption.bottom);
    expect(action().scrollWidth).toBeLessThanOrEqual(action().clientWidth);
  }
  await page.getByRole("button", { name: /Changes/ }).click();
  expect(openChanges).toHaveBeenCalledOnce();
  view.updateChat({ onOpenSessionDiff: currentOpenChanges });
  flush();
  expect(action().textContent).toContain("+248");
  expect(action().textContent).toContain("−61");
  await page.getByRole("button", { name: /Changes/ }).click();
  expect(openChanges).toHaveBeenCalledOnce();
  expect(currentOpenChanges).toHaveBeenCalledOnce();
  expect(view.session.querySelector(".chat-details__participants")).toBeNull();
  const additions = action().querySelector<HTMLElement>(".chat-environment__added")!;
  const deletions = action().querySelector<HTMLElement>(".chat-environment__removed")!;
  expect(getComputedStyle(additions).fontVariantNumeric).toBe("tabular-nums");
  expect(getComputedStyle(additions).color).not.toBe(getComputedStyle(deletions).color);
});
