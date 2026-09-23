import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import type { SessionGoal } from "../../api/types.ts";
import { renderComposerMenu } from "../../components/composer-menu.ts";
import { createComposerProps } from "./chat-composer.test-support.ts";
import { renderAttachmentPreview } from "./components/chat-attachments.ts";
import { clearGoalElapsedTimers, renderChatGoal } from "./components/chat-composer-goal.ts";
import { getChatComposerState, resetChatComposerState } from "./components/chat-composer-state.ts";
import { renderChatComposer } from "./components/chat-composer.ts";
import { subscribeTranscriptScroll } from "./components/chat-transcript-scroll-events.ts";
import baseStyles from "../../styles/base.css?inline";
import contextStripStyles from "../../styles/chat/composer-context-strip.css?inline";
import goalStyles from "../../styles/chat/composer-progress.css?inline";
import queueStyles from "../../styles/chat/composer-queue.css?inline";
import composerSurfaceStyles from "../../styles/chat/composer-surface.css?inline";
import composerStyles from "../../styles/chat/composer.css?inline";

const attachments = Array.from({ length: 7 }, (_, index) => ({
  id: `overflow-${index}`,
  fileName: `fixture-${index}.txt`,
  mimeType: "text/plain",
}));
const afterLayout = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

describe("composer overflow presentation", () => {
  let container: HTMLDivElement;
  let styles: HTMLStyleElement;

  beforeEach(async () => {
    await page.viewport(1200, 800);
    styles = document.createElement("style");
    styles.textContent = [
      baseStyles,
      composerStyles,
      composerSurfaceStyles,
      contextStripStyles,
      goalStyles,
    ].join("\n");
    document.head.append(styles);
    container = document.createElement("div");
    container.className = "agent-chat__input";
    container.style.width = "760px";
    document.body.append(container);
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
    styles.remove();
    resetChatComposerState();
    clearGoalElapsedTimers();
  });

  it.each([390, 2048])(
    "keeps skill labels and dependency notes inside scrollable menu rows at %ipx",
    async (width) => {
      await page.viewport(width, 1000);
      container.className = "";
      container.style.cssText = `position: fixed; bottom: 24px; left: 16px; width: ${Math.min(width - 32, 760)}px`;
      const props = createComposerProps({
        onRequestUpdate: () => render(renderChatComposer(props), container),
        capabilityMenu: {
          basePath: "",
          skills: [
            "apple-notes",
            "apple-reminders",
            "bear-notes",
            "A skill with a long descriptive name that wraps across multiple lines",
            ...Array.from({ length: 12 }, (_, index) => `fixture-skill-${index}`),
          ].map((name) => ({
            key: name,
            name,
            enabled: false,
            baseEnabled: false,
            missingDeps: true,
          })),
          skillsLoading: false,
          skillsError: false,
          mcpServers: [],
          toolsEffectiveResult: null,
          toolsEffectiveLoading: false,
          toolsEffectiveError: false,
          toolAccessMutationBlockedReason: null,
          webSearchBaseEnabled: true,
          mutationBlockedReason: null,
          canAdmin: true,
          adminBlockedReason: null,
          onLoadSkills: vi.fn(),
          onPatchToolOverrides: vi.fn(),
          onNavigate: vi.fn(),
        },
      });
      render(renderChatComposer(props), container);
      await page
        .elementLocator(
          container.querySelector<HTMLElement>('.agent-chat__attach-menu > [slot="trigger"]')!,
        )
        .click();
      await page
        .elementLocator(container.querySelector<HTMLElement>('[value="open-skills"]')!)
        .click();
      await afterLayout();
      const dropdown = container.querySelector<HTMLElement>(".agent-chat__capability-menu")!;
      const menu = dropdown.shadowRoot!.querySelector<HTMLElement>('[part="menu"]')!;
      expect(menu.scrollHeight).toBeGreaterThan(menu.clientHeight);
      const rows = [...dropdown.querySelectorAll<HTMLElement>('[value^="skill:"]')];
      expect(rows).toHaveLength(16);

      for (const row of rows) {
        const box = row.getBoundingClientRect();
        const label = row
          .querySelector<HTMLElement>(".agent-chat__capability-menu-label")!
          .getBoundingClientRect();
        expect(label.top).toBeGreaterThanOrEqual(box.top);
        expect(label.bottom).toBeLessThanOrEqual(box.bottom);
        expect(label.left).toBeGreaterThanOrEqual(box.left);
        expect(label.right).toBeLessThanOrEqual(box.right);
      }
      const name = rows[1]!.querySelector<HTMLElement>(
        ".agent-chat__capability-menu-label > span",
      )!;
      expect(name.getBoundingClientRect().height).toBeLessThan(
        2 * Number.parseFloat(getComputedStyle(name).lineHeight),
      );
      expect(menu.scrollWidth).toBeLessThanOrEqual(menu.clientWidth);
      expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    },
  );

  function drawAttachments(count: number) {
    return render(renderAttachmentPreview({ attachments: attachments.slice(0, count) }), container);
  }

  function rail() {
    return container.querySelector<HTMLElement>(".chat-attachments-preview")!;
  }

  it.each([390, 1440])(
    "keeps long reply context and its dismiss control inside the composer at %ipx",
    async (width) => {
      await page.viewport(width, 900);
      container.className = "";
      container.style.width = `${Math.min(width - 32, 760)}px`;
      render(
        renderChatComposer(
          createComposerProps({
            goalDraftMode: { action: "start" },
            replyTarget: {
              messageId: "context-strip-reply",
              senderLabel: "A very long sender name ".repeat(12),
              text: "A long message excerpt that must leave room for cancellation. ".repeat(8),
            },
          }),
        ),
        container,
      );
      await afterLayout();

      const composer = container.querySelector<HTMLElement>(".agent-chat__input")!;
      const reply = container.querySelector<HTMLElement>(".chat-reply-preview")!;
      const goal = container.querySelector<HTMLElement>(".agent-chat__goal-mode")!;
      const text = reply.querySelector<HTMLElement>(".chat-reply-preview__text")!;
      const dismiss = reply.querySelector<HTMLButtonElement>("button")!;
      const composerBox = composer.getBoundingClientRect();
      const replyBox = reply.getBoundingClientRect();
      const dismissBox = dismiss.getBoundingClientRect();

      expect(dismissBox.width).toBeGreaterThan(0);
      expect(dismissBox.left).toBeGreaterThanOrEqual(replyBox.left);
      expect(dismissBox.right).toBeLessThanOrEqual(replyBox.right);
      expect(replyBox.left).toBeGreaterThanOrEqual(composerBox.left);
      expect(replyBox.right).toBeLessThanOrEqual(composerBox.right);
      expect(composer.scrollWidth).toBeLessThanOrEqual(composer.clientWidth + 1);
      expect(text.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
      expect(text.scrollHeight).toBeLessThanOrEqual(text.clientHeight + 1);

      const surface = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          border: style.border,
          borderRadius: style.borderRadius,
          padding: style.padding,
          margin: style.margin,
        };
      };
      expect(surface(reply)).toEqual(surface(goal));
      expect(replyBox.height).toBeCloseTo(goal.getBoundingClientRect().height, 0);
    },
  );

  it.each([
    ["reply", "ltr"],
    ["goal", "ltr"],
    ["mentions", "ltr"],
    ["combined", "rtl"],
  ] as const)(
    "places %s context before attachments and multiline input in %s",
    async (kind, dir) => {
      await page.viewport(390, 900);
      container.className = "";
      container.dir = dir;
      container.style.width = "358px";
      render(
        renderChatComposer(
          createComposerProps({
            draft: "@Jordan Rivera\nReview the attached file.\nKeep this third line.",
            attachments: attachments.slice(0, 1),
            ...(kind === "reply" || kind === "combined"
              ? {
                  replyTarget: { messageId: "order-reply", text: "Original message" },
                }
              : {}),
            ...(kind === "goal" || kind === "combined"
              ? { goalDraftMode: { action: "start" as const } }
              : {}),
            ...(kind === "mentions" || kind === "combined"
              ? {
                  mentions: [{ profileId: "jordan", start: 0, end: 14 }],
                }
              : {}),
          }),
        ),
        container,
      );
      await afterLayout();
      const strips = container.querySelectorAll<HTMLElement>(".composer-context-strip");
      expect(strips).toHaveLength(kind === "combined" ? 3 : 1);
      const attachmentBox = rail().querySelector(".chat-attachment-thumb")!.getBoundingClientRect();
      const textareaBox = container.querySelector("textarea")!.getBoundingClientRect();
      const composerBox = container.querySelector(".agent-chat__input")!.getBoundingClientRect();
      for (const strip of strips) {
        const box = strip.getBoundingClientRect();
        expect(box.height).toBeCloseTo(45, 0);
        expect(box.bottom).toBeLessThanOrEqual(attachmentBox.top);
        expect(box.left).toBeGreaterThanOrEqual(composerBox.left);
        expect(box.right).toBeLessThanOrEqual(composerBox.right);
        expect(getComputedStyle(strip).borderBottomWidth).toBe("1px");
      }
      expect(attachmentBox.height).toBeGreaterThan(0);
      expect(attachmentBox.bottom).toBeLessThanOrEqual(textareaBox.top);
    },
  );

  it.each([
    [390, "ltr"],
    [390, "rtl"],
    [1440, "ltr"],
    [1440, "rtl"],
  ] as const)("dismisses only the intended stacked context at %ipx in %s", async (width, dir) => {
    await page.viewport(width, 900);
    container.className = "";
    container.dir = dir;
    container.style.width = `${Math.min(width - 32, 760)}px`;
    const onClearReply = vi.fn();
    const onGoalDraftModeChange = vi.fn();
    const onDraftChange = vi.fn();
    render(
      renderChatComposer(
        createComposerProps({
          draft: "@Jordan Rivera Review this file.",
          mentions: [{ profileId: "jordan", start: 0, end: 14 }],
          replyTarget: { messageId: "touch-reply", text: "Original message" },
          goalDraftMode: { action: "start" },
          onClearReply,
          onGoalDraftModeChange,
          onDraftChange,
        }),
      ),
      container,
    );
    await afterLayout();

    const contexts = [
      [".agent-chat__goal-mode", onGoalDraftModeChange, [null]],
      [
        '.composer-context-strip[role="status"]',
        onDraftChange,
        ["@Jordan Rivera Review this file.", []],
      ],
      [".chat-reply-preview:not([role])", onClearReply, []],
    ] as const;
    const targetSize = width === 390 ? 44 : 24;
    for (const [selector, callback, args] of contexts) {
      const button = container.querySelector<HTMLButtonElement>(`${selector} button`)!;
      const box = button.getBoundingClientRect();
      expect(box.width).toBeGreaterThanOrEqual(24);
      expect(box.height).toBeGreaterThanOrEqual(24);
      const icon = button.querySelector("svg")!.getBoundingClientRect();
      expect(icon.width).toBe(14);
      expect(icon.height).toBe(14);
      const center = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      const inset = targetSize / 2 - 0.5;
      const points =
        width === 390
          ? [
              [-inset, -inset],
              [-inset, inset],
              [inset, -inset],
              [inset, inset],
            ]
          : [
              [-inset, 0],
              [inset, 0],
              [0, -inset],
              [0, inset],
            ];
      for (const [x, y] of points) {
        expect(button.contains(document.elementFromPoint(center.x + x!, center.y + y!))).toBe(true);
      }

      const containerBox = container.getBoundingClientRect();
      await page.elementLocator(container).click({
        position: {
          x: center.x - inset - containerBox.left,
          y: center.y - (width === 390 ? inset : 0) - containerBox.top,
        },
      });
      expect(callback).toHaveBeenCalledExactlyOnceWith(...args);
      for (const [, otherCallback] of contexts) {
        if (otherCallback !== callback) {
          expect(otherCallback).not.toHaveBeenCalled();
        }
      }
      callback.mockClear();
    }
  });

  it("restores full mention names after narrowing and reconnecting the composer", async () => {
    container.className = "";
    const props = createComposerProps({
      draft: "@Jordan Rivera @Morgan Williams",
      mentions: [
        { profileId: "jordan", start: 0, end: 14 },
        { profileId: "morgan", start: 15, end: 31 },
      ],
    });
    const part = render(renderChatComposer(props), container);
    const strip = container.querySelector<HTMLElement>('[role="status"]')!;
    const visibleNames = () =>
      [...strip.querySelectorAll<HTMLElement>(".composer-context-strip__person")]
        .filter((person) => !person.hidden)
        .map((person) => person.title);
    await expect.poll(visibleNames).toEqual(["@Jordan Rivera", "@Morgan Williams"]);
    for (const avatar of strip.querySelectorAll<HTMLElement>('[role="img"]')) {
      expect(avatar.getBoundingClientRect().width).toBe(16);
      expect(avatar.getBoundingClientRect().height).toBe(16);
    }
    await document.fonts.ready;
    await afterLayout();
    const mutations = vi.fn();
    const observer = new MutationObserver(mutations);
    observer.observe(strip.querySelector(".composer-context-strip__people")!, {
      subtree: true,
      attributes: true,
      // Avatar fallback classes can refresh independently of recipient sizing.
      attributeFilter: ["hidden", "style"],
      childList: true,
      characterData: true,
    });
    try {
      render(renderChatComposer({ ...props, draft: props.draft + " please review" }), container);
      await afterLayout();
      expect(mutations).not.toHaveBeenCalled();
    } finally {
      observer.disconnect();
    }
    container.style.width = "300px";
    await expect.poll(visibleNames).toEqual(["@Jordan Rivera"]);
    const more = strip.querySelector<HTMLElement>(".composer-context-strip__more")!;
    expect(more.hidden).toBe(false);
    expect(more.textContent).toBe("+1");
    expect(more.title).toBe("@Morgan Williams");
    expect(strip.getBoundingClientRect().height).toBeCloseTo(41, 0);
    part.setConnected(false);
    container.style.width = "760px";
    part.setConnected(true);
    await expect.poll(visibleNames).toEqual(["@Jordan Rivera", "@Morgan Williams"]);
    expect(more.hidden).toBe(true);
    const longName = "Morgan Alexandra Penelope Williams ".repeat(3).trim();
    const draft = "@Jordan Rivera @" + longName;
    render(
      renderChatComposer({
        ...props,
        draft,
        mentions: [props.mentions![0]!, { profileId: "morgan", start: 15, end: draft.length }],
      }),
      container,
    );
    await expect.poll(visibleNames).toEqual(["@Jordan Rivera"]);
    expect(more.hidden).toBe(false);
    expect(more.title).toBe("@" + longName);
  });

  async function expectEdges(
    element: HTMLElement,
    scrollable: boolean,
    atStart = true,
    atEnd = !scrollable,
  ) {
    await expect
      .poll(() => ({
        scrollable: element.dataset.scrollable,
        atStart: element.dataset.atStart,
        atEnd: element.dataset.atEnd,
      }))
      .toMatchObject({
        scrollable: String(scrollable),
        atStart: String(atStart),
        atEnd: String(atEnd),
      });
    expect(getComputedStyle(element).maskImage === "none").toBe(!scrollable);
  }

  it.each([
    { viewport: 1200, width: 760 },
    { viewport: 390, width: 342 },
  ])(
    "ellipsizes empty focused and blurred composers at $viewport px without clipping drafts",
    async ({ viewport, width }) => {
      await page.viewport(viewport, 800);
      container.classList.add("chat");
      container.style.width = `${width}px`;
      const props = createComposerProps({
        assistantName: "A deliberately long assistant name ".repeat(8),
        onDraftChange: (draft) => {
          props.draft = draft;
          draw();
        },
      });
      const draw = () =>
        render(
          html`<div class="chat-thread"></div>
            ${renderChatComposer(props)}`,
          container,
        );
      draw();
      const textarea = container.querySelector<HTMLTextAreaElement>(
        ".agent-chat__composer-combobox > textarea",
      )!;
      const placeholder = container.querySelector<HTMLElement>(
        ".agent-chat__composer-placeholder",
      )!;
      const control = page.elementLocator(textarea);
      await afterLayout();
      const expectStableSize = async (draft: string) => {
        const mutations = vi.fn();
        const observer = new MutationObserver(mutations);
        observer.observe(textarea, { attributes: true, attributeFilter: ["style"] });
        const resized = vi.fn();
        const stop = subscribeTranscriptScroll(
          container.querySelector<HTMLElement>(".chat-thread")!,
          resized,
        );
        const height = textarea.clientHeight;
        try {
          await control.fill(draft);
          await afterLayout();
          expect(textarea.clientHeight).toBe(height);
          expect(mutations).not.toHaveBeenCalled();
          expect(resized).not.toHaveBeenCalled();
        } finally {
          observer.disconnect();
          stop();
        }
      };

      expect(placeholder).not.toBeNull();
      expect(placeholder.textContent).toBe(textarea.placeholder);
      expect(placeholder.getAttribute("aria-hidden")).toBe("true");
      expect(textarea.getAttribute("aria-label")).toBeTruthy();
      for (const focused of [false, true]) {
        if (focused) {
          await control.click();
        } else {
          textarea.blur();
        }
        await afterLayout();
        expect(document.activeElement === textarea).toBe(focused);
        expect(placeholder.checkVisibility()).toBe(true);
        expect(placeholder.scrollWidth).toBeGreaterThan(placeholder.clientWidth);
        expect(getComputedStyle(placeholder).textOverflow).toBe("ellipsis");
        expect(getComputedStyle(placeholder).overflowX).toBe("hidden");
        expect(getComputedStyle(textarea, "::placeholder").color).toBe("rgba(0, 0, 0, 0)");
        expect(placeholder.getBoundingClientRect().right).toBeLessThanOrEqual(
          textarea.getBoundingClientRect().right + 1,
        );
      }

      const emptyHeight = textarea.clientHeight;
      await expectStableSize("A short editable draft.");
      const draft =
        "A typed line that wraps within the available composer width. ".repeat(8) +
        "\nA second editable line.";
      await control.fill(draft);
      await afterLayout();
      expect(textarea.value).toBe(draft);
      expect(props.draft).toBe(draft);
      expect(placeholder.checkVisibility()).toBe(false);
      expect(getComputedStyle(textarea).whiteSpace).toBe("pre-wrap");
      expect(textarea.clientHeight).toBeGreaterThan(emptyHeight);
      expect(textarea.scrollHeight).toBeGreaterThan(textarea.clientHeight);
      await expectStableSize(`${draft}\nAnother line in the capped draft.`);

      await control.fill("");
      await afterLayout();
      expect(document.activeElement).toBe(textarea);
      expect(placeholder.checkVisibility()).toBe(true);
      expect(textarea.clientHeight).toBe(emptyHeight);
    },
  );

  it("updates retained attachment edges when files are appended, scrolled, and removed", async () => {
    drawAttachments(1);
    const element = rail();
    await afterLayout();
    await expectEdges(element, false);

    drawAttachments(7);
    expect(rail()).toBe(element);
    expect(element.scrollWidth).toBeGreaterThan(element.clientWidth);
    await expectEdges(element, true);
    element.scrollLeft = element.scrollWidth;
    await expectEdges(element, true, false, true);

    drawAttachments(1);
    await expectEdges(element, false);
  });

  it("updates retained attachment edges when the composer narrows and widens", async () => {
    drawAttachments(3);
    const element = rail();
    await afterLayout();
    await expectEdges(element, false);

    container.style.width = "400px";
    expect(rail()).toBe(element);
    expect(element.scrollWidth).toBeGreaterThan(element.clientWidth);
    await expectEdges(element, true);

    container.style.width = "760px";
    await expectEdges(element, false);
  });

  it("resumes overflow observation when a retained composer reconnects", async () => {
    const part = drawAttachments(3);
    const element = rail();
    await afterLayout();
    await expectEdges(element, false);

    part.setConnected(false);
    container.style.width = "400px";
    await afterLayout();
    await expectEdges(element, false);

    part.setConnected(true);
    expect(rail()).toBe(element);
    await expectEdges(element, true);
    container.style.width = "760px";
    await expectEdges(element, false);
  });

  it.each([
    [320, "active"],
    [390, "paused"],
    [560, "blocked"],
  ] as const)(
    "aligns the expanded %s px %s header and keeps controls above the objective",
    async (width, status) => {
      await page.viewport(width, 800);
      styles.textContent += queueStyles;
      container.className = "agent-chat__composer-shell";
      container.style.width = `${width - 32}px`;
      const state = getChatComposerState("mobile-actions");
      const goal: SessionGoal = {
        schemaVersion: 1,
        id: "mobile-actions",
        objective: "Verify the deployment and summarize its health checks.\n".repeat(12),
        status,
        lastStatusNote: "Review the deployment results before continuing.",
        createdAt: 1000,
        updatedAt: 61000,
        tokenStart: 0,
        tokensUsed: 1500,
        continuationTurns: 0,
      };
      const onGoalAction = vi.fn();
      const onGoalEdit = vi.fn();
      const draw = () =>
        render(
          html`<div class="agent-chat__goal-float">
            ${renderChatGoal(state, goal, {
              canAct: true,
              onGoalAction,
              onGoalEdit,
              requestUpdate: draw,
            })}
          </div>`,
          container,
        );
      draw();
      const commands = container.querySelector<HTMLElement>(".agent-chat__goal-command-actions")!;
      expect(getComputedStyle(commands).display).toBe("none");
      await page.getByRole("button", { name: "Show goal details", exact: true }).click();
      await afterLayout();
      const objective = container.querySelector<HTMLElement>(".agent-chat__goal-detail-objective")!;
      const commandBox = commands.getBoundingClientRect();
      expect(commandBox.height).toBeGreaterThan(0);
      expect(commandBox.bottom).toBeLessThanOrEqual(objective.getBoundingClientRect().top);
      const centers = [
        ".agent-chat__goal-icon svg",
        ".agent-chat__goal-label",
        ".agent-chat__goal-expand svg",
      ].map((selector) => {
        const box = container.querySelector(selector)!.getBoundingClientRect();
        return box.top + box.height / 2;
      });
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
      const cardBox = container.querySelector(".agent-chat__goal")!.getBoundingClientRect();
      for (const button of commands.querySelectorAll<HTMLButtonElement>("button")) {
        const box = button.getBoundingClientRect();
        expect(box.left).toBeGreaterThanOrEqual(cardBox.left);
        expect(box.right).toBeLessThanOrEqual(cardBox.right);
        expect(box.height).toBeGreaterThanOrEqual(24);
        expect(box.height).toBeLessThanOrEqual(30);
        expect(
          button.contains(
            document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2),
          ),
        ).toBe(true);
        await page.elementLocator(button).click();
      }
      expect(onGoalEdit).toHaveBeenCalledWith(goal);
      expect(onGoalAction.mock.calls).toEqual([
        [goal.id, status === "active" ? "pause" : "resume"],
        [goal.id, "clear"],
      ]);
      await userEvent.tab({ shift: true });
      expect(document.activeElement).toBe(
        commands.querySelector(
          status === "active" ? ".agent-chat__goal-pause" : ".agent-chat__goal-resume",
        ),
      );
      await userEvent.keyboard("{Enter}");
      expect(onGoalAction).toHaveBeenLastCalledWith(
        goal.id,
        status === "active" ? "pause" : "resume",
      );
      objective.scrollTop = objective.scrollHeight;
      await afterLayout();
      expect(commands.getBoundingClientRect().top).toBe(commandBox.top);
      await page.getByRole("button", { name: "Hide goal details", exact: true }).click();
      expect(getComputedStyle(commands).display).toBe("none");
    },
  );

  it("preserves expanded mobile goal edges as its objective changes and scrolls", async () => {
    await page.viewport(480, 800);
    container.style.width = "400px";
    const state = getChatComposerState("overflow-goal");
    state.goalExpandedId = "overflow-goal";
    const goal: SessionGoal = {
      schemaVersion: 1,
      id: "overflow-goal",
      objective: "Fixture objective\n".repeat(30),
      status: "complete",
      createdAt: 1000,
      updatedAt: 2000,
      tokenStart: 0,
      tokensUsed: 0,
      continuationTurns: 0,
    };
    const drawGoal = () =>
      render(
        renderChatGoal(state, goal, {
          canAct: false,
          requestUpdate: () => {},
        }),
        container,
      );
    drawGoal();
    const element = container.querySelector<HTMLElement>(".agent-chat__goal-detail-objective")!;
    expect(element.scrollHeight).toBeGreaterThan(element.clientHeight);
    await expectEdges(element, true);
    element.scrollTop = element.scrollHeight;
    await expectEdges(element, true, false, true);

    goal.objective = "Short objective";
    drawGoal();
    expect(container.querySelector(".agent-chat__goal-detail-objective")).toBe(element);
    await expectEdges(element, false);
  });

  it("updates menu edges when retained results grow, scroll, and shrink", async () => {
    const drawMenu = (count: number) =>
      render(
        renderComposerMenu({
          id: "overflow-menu",
          label: "Fixture results",
          content: Array.from(
            { length: count },
            (_, index) => html`<div style="height: 40px">Result ${index}</div>`,
          ),
        }),
        container,
      );
    drawMenu(1);
    const element = container.querySelector<HTMLElement>(".slash-menu__scroll")!;
    await afterLayout();
    await expectEdges(element, false);

    drawMenu(20);
    expect(container.querySelector(".slash-menu__scroll")).toBe(element);
    expect(element.scrollHeight).toBeGreaterThan(element.clientHeight);
    await expectEdges(element, true);
    element.scrollTop = element.scrollHeight;
    await expectEdges(element, true, false, true);

    drawMenu(1);
    await expectEdges(element, false);
  });
});
