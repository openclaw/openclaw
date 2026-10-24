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
  it("reserves automatic desktop Details before the first resize delivery", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    try {
      await page.viewport(1700, 900);
      const { conversation, panel } = await fixture(props(), 1320, false, "desktop", true);
      expect(panel.hidden).toBe(false);
      expect(getComputedStyle(conversation).right).toBe("313px");
      expect(panel.querySelector(".chat-details-session")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

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

  it("automatically docks within the available pane, preserves intent, and releases its column", async () => {
    await page.viewport(1700, 900);
    const { update, updateChat, frame, conversation, footer, trigger, panel } = await fixture(
      props({
        detailsWorkspace: {
          root: "/workspace/details",
          label: "details",
          branch: "feature/docking",
        },
      }),
      1320,
    );
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
    // The first docked view also resolves the lazy session module.
    await expect
      .poll(() => panel.querySelector(".chat-details-session"), { timeout: 5_000 })
      .not.toBeNull();
    const session = panel.querySelector<ChatDetailsSession>("openclaw-chat-details-session")!;
    expect(panel.getAttribute("role")).toBe("complementary");
    expect(panel.querySelector(".chat-details__toolbar")).toBeNull();
    const groupStyle = getComputedStyle(panel.querySelector(".chat-details-desktop-section")!);
    expect(groupStyle.borderTopWidth).toBe("0px");
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
    updateChat({ progressCard: { ...card, revision: 4 } });
    frame.style.width = "900px";
    flush();
    frame.style.width = "1320px";
    update({ presentation: false });
    flush();
    update({ presentation: true });
    flush();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.click();
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
    frame.style.width = "600px";
    await expect.poll(() => panel.matches(":popover-open")).toBe(true);
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(conversation.getBoundingClientRect().width).toBe(600);
    frame.style.width = "1320px";
    await expect.poll(() => panel.getAttribute("role"), { timeout: 5_000 }).toBe("complementary");
    expect(panel.matches(":popover-open")).toBe(false);
    update({ presentation: false });
    flush();
    expect(panel.hidden).toBe(true);
    expect(conversation.getBoundingClientRect().width).toBe(1320);
  });

  it("positions above its supplied footer when unrelated matching DOM precedes it", async () => {
    const { frame, footer, trigger, panel } = await fixture();
    const unrelatedFooter = document.createElement("div");
    unrelatedFooter.className = "chat-footer";
    unrelatedFooter.style.cssText = "position:absolute;top:0;height:20px";
    frame.prepend(unrelatedFooter);
    trigger.click();
    flush();
    expect(panel.matches(":popover-open")).toBe(true);
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

  it("starts closed, stays closed on revisions, and returns Escape focus to its labeled trigger", async () => {
    const { updateChat, trigger, panel } = await fixture();
    expect(trigger.textContent).toContain("Details");
    expect(panel.matches(":popover-open")).toBe(false);
    expect(panel.querySelector("openclaw-chat-details-session")).toBeNull();
    updateChat({ progressCard: { ...card, revision: 2 } });
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    trigger.click();
    flush();
    expect(panel.matches(":popover-open")).toBe(true);
    await expect.poll(() => panel.querySelector(".chat-details-session")).not.toBeNull();
    expect(panel.querySelector(".chat-details__toolbar")).toBeNull();
    panel.querySelector<HTMLButtonElement>("button")!.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(trigger);
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
    expect(panel.matches(":popover-open")).toBe(true);
    expect(panel.getBoundingClientRect().width).toBe(364);
    expect(panel.querySelector(".chat-details__toolbar")).not.toBeNull();
    await expect.poll(() => panel.querySelector(".chat-details-session")).not.toBeNull();
    panel.querySelector<HTMLButtonElement>("button")!.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(source);
    open(source);
    flush();
    panel.querySelector<HTMLButtonElement>(".chat-details__toolbar button")!.click();
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(source);
    update({ presentation: false });
    flush();
    open(source);
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
  });

  it("opens fullscreen Details within the visible pane and returns focus to its external trigger", async () => {
    await page.viewport(1700, 900);
    const { open, pane, frame, trigger, panel } = await fixture(props(), 1320, true);
    const source = document.createElement("button");
    source.textContent = "Session actions";
    pane.prepend(source);
    expect(frame.checkVisibility()).toBe(false);
    expect(trigger.hidden).toBe(true);
    expect(panel.matches(":popover-open")).toBe(false);
    open(source);
    flush();
    expect(panel.matches(":popover-open")).toBe(true);
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
    close.click();
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(source);
    open(source);
    flush();
    close.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(source);
  });

  it("keeps its child menu open through chat updates and closes Details after it closes", async () => {
    const { trigger, panel, progress, updateChat } = await fixture();
    trigger.click();
    flush();
    const menu = progress.querySelector<HTMLElement>(".chat-details-progress__menu")!;
    const menuSurface = menu.querySelector<HTMLElement>('[role="menu"]')!;
    menu.querySelector<HTMLButtonElement>("button")!.click();
    await expect.poll(() => menuSurface.dataset.phase).toBe("open");
    expect(menuSurface.matches(":popover-open")).toBe(true);
    updateChat({ messages: [] });
    flush();
    expect(menuSurface.matches(":popover-open")).toBe(true);
    menu.querySelector<HTMLButtonElement>("button")!.click();
    await expect
      .poll(() => menu.querySelector("button")!.getAttribute("aria-expanded"))
      .toBe("false");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps metadata visible while progress retains its collapse across revisions", async () => {
    const { updateChat, trigger, panel, progress } = await fixture();
    trigger.click();
    flush();
    await expect.poll(() => panel.querySelector(".chat-details-session")).not.toBeNull();
    const session = panel.querySelector<ChatDetailsSession>("openclaw-chat-details-session")!;
    await session.updateComplete;
    flush();
    const sessionSection = session.querySelector<HTMLElement>(".chat-details-session")!;
    const progressSection = progress.querySelector<HTMLDetailsElement>(".task-progress-details")!;
    expect(sessionSection.querySelector(":scope > summary")).toBeNull();
    expect(progressSection.open).toBe(true);
    expect(
      session.querySelector(
        '[data-details-group="pull-requests"], [data-details-group="automations"], [data-details-group="subagents"], [data-details-group="processes"]',
      ),
    ).toBeNull();
    await toggle(progressSection);
    expect(progressSection.open).toBe(false);
    expect(
      getComputedStyle(progress.querySelector(".chat-details-progress__menu")!).display,
    ).not.toBe("none");
    updateChat({ progressCard: { ...card, revision: 3 } });
    flush();
    flush();
    expect(sessionSection.checkVisibility()).toBe(true);
    expect(progressSection.open).toBe(false);
  });

  it("constrains the popover to its conversation and above the composer after narrowing", async () => {
    const { frame, footer, trigger, panel } = await fixture();
    trigger.click();
    flush();
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
    trigger.click();
    flush();
    update({ presentation: false });
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    update({ presentation: true });
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    trigger.click();
    flush();
    updateChat({ sessionKey: "agent:main:other", selectedSession: undefined });
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
  });

  it("keeps global browser hide, lifetime dismiss, saved clear and refresh as distinct actions", async () => {
    const hide = vi.fn();
    const dismiss = vi.fn();
    const clear = vi.fn();
    const refresh = vi.fn();
    const collapse = vi.fn();
    const settings = vi.fn();
    const { update, trigger, progress } = await fixture(
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
    flush();
    flush();
    const menu = progress.querySelector<HTMLElement>(".chat-details-progress__menu")!;
    const menuSurface = menu.querySelector<HTMLElement>('[role="menu"]')!;
    menu.querySelector<HTMLButtonElement>("button")!.click();
    await expect.poll(() => menuSurface.dataset.phase).toBe("open");
    expect(menuSurface.matches(":popover-open")).toBe(true);
    expect(progress.querySelector<HTMLDetailsElement>(".task-progress-details")!.open).toBe(true);
    const select = async (value: string) => {
      if (trigger.getAttribute("aria-expanded") !== "true") {
        trigger.click();
        flush();
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
    expect(progress.querySelector<HTMLDetailsElement>(".task-progress-details")!.open).toBe(true);
    await select("settings");
    expect(settings).toHaveBeenCalledOnce();
    await select("dismiss");
    expect(dismiss).toHaveBeenCalledWith(card);
    expect(clear).not.toHaveBeenCalled();
    await select("refresh");
    expect(refresh).toHaveBeenCalledWith(card);
    await select("clear");
    expect(clear).toHaveBeenCalledWith(card);
    update({ presentation: false });
    flush();
    flush();
    menu.querySelector<HTMLButtonElement>('[data-value="hide"]')!.click();
    expect(hide).toHaveBeenCalledTimes(1);
  });
});

it("keeps Environment changes readable across disclosure toggles and omits empty Participants", async () => {
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
  heading.click();
  flush();
  expect(heading.getAttribute("aria-expanded")).toBe("false");
  expect(action().closest("[inert]")).not.toBeNull();
  heading.click();
  flush();
  expect(heading.getAttribute("aria-expanded")).toBe("true");
  expect(action().closest("[inert]")).toBeNull();
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
