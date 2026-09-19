import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { SessionGoal } from "../../api/types.ts";
import { renderComposerMenu } from "../../components/composer-menu.ts";
import { NewSessionComposerTextareaController } from "../new-session/composer-controller.ts";
import type { NewSessionComposerOptions } from "../new-session/composer-types.ts";
import { renderNewSessionComposer } from "../new-session/composer.ts";
import { createComposerProps } from "./chat-composer.test-support.ts";
import { renderAttachmentPreview } from "./components/chat-attachments.ts";
import { renderChatGoal } from "./components/chat-composer-goal.ts";
import { getChatComposerState, resetChatComposerState } from "./components/chat-composer-state.ts";
import { renderChatComposer } from "./components/chat-composer.ts";
import baseStyles from "../../styles/base.css?inline";
import contextStripStyles from "../../styles/chat/composer-context-strip.css?inline";
import goalStyles from "../../styles/chat/composer-progress.css?inline";
import composerSurfaceStyles from "../../styles/chat/composer-surface.css?inline";
import composerStyles from "../../styles/chat/composer.css?inline";
import newSessionStyles from "../../styles/new-session.css?inline";

const attachments = Array.from({ length: 7 }, (_, index) => ({
  id: `overflow-${index}`,
  fileName: `fixture-${index}.txt`,
  mimeType: "text/plain",
}));
const afterLayout = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

function expectEditorLineVisible(textarea: HTMLTextAreaElement, lineIndex = 0) {
  const box = textarea.getBoundingClientRect();
  const style = getComputedStyle(textarea);
  const top =
    box.top +
    Number.parseFloat(style.paddingTop) +
    lineIndex * Number.parseFloat(style.lineHeight) -
    textarea.scrollTop;
  const bottom = top + Number.parseFloat(style.lineHeight);
  expect(top).toBeGreaterThanOrEqual(box.top);
  expect(bottom).toBeLessThanOrEqual(box.bottom);
  for (const y of [top + 0.5, bottom - 0.5]) {
    expect(document.elementFromPoint(box.left + 8, y)).toBe(textarea);
  }
}

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
  });

  it.each([
    { width: 1440, height: 900, context: "combined", textScale: 100 },
    { width: 390, height: 844, context: "combined", textScale: 100 },
    { width: 844, height: 390, context: "combined", textScale: 100 },
    { width: 844, height: 320, context: "combined", textScale: 100 },
    { width: 844, height: 260, context: "combined", textScale: 100 },
    { width: 844, height: 500, context: "combined", textScale: 100 },
    { width: 844, height: 501, context: "combined", textScale: 100 },
    { width: 844, height: 320, context: "reply", textScale: 100 },
    { width: 844, height: 260, context: "image", textScale: 100 },
    { width: 844, height: 260, context: "combined", textScale: 140 },
  ])(
    "keeps typed text and actions reachable with $context at $width x $height and $textScale% text",
    async ({ width, height, context, textScale }) => {
      await page.viewport(width!, height!);
      container.className = "";
      container.style.cssText =
        "position:fixed;inset:56px 0 0;display:flex;align-items:flex-end;overflow:hidden";
      container.style.setProperty("--control-ui-text-scale", String(textScale / 100));
      const props = createComposerProps({ onOpenImage: vi.fn() });
      const draw = () => render(renderChatComposer(props), container);
      props.onDraftChange = (draft) => {
        props.draft = draft;
        draw();
      };
      props.onRequestUpdate = draw;
      props.onClearReply = () => {
        props.replyTarget = null;
        draw();
      };
      props.onAttachmentsChange = (next) => {
        props.attachments = next;
        draw();
      };
      draw();
      await afterLayout();
      const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
      await page.elementLocator(textarea).click();
      if (context !== "image") {
        props.replyTarget = { messageId: "reply", text: "Original message" };
      }
      if (context !== "reply") {
        props.attachments = [
          {
            id: "image",
            mimeType: "image/png",
            fileName: "fixture.png",
            dataUrl:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          },
        ];
      }
      draw();
      await afterLayout();
      await userEvent.keyboard("x");
      await afterLayout();
      expect(textarea.value).toBe("x");
      expect(document.activeElement).toBe(textarea);
      const editor = textarea.getBoundingClientRect();
      const style = getComputedStyle(textarea);
      const lineY =
        editor.top + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.lineHeight) / 2;
      expectEditorLineVisible(textarea);
      const footer = container.querySelector<HTMLElement>(".agent-chat__composer-footer")!;
      expect(lineY).toBeLessThan(footer.getBoundingClientRect().top);
      const send = container.querySelector<HTMLButtonElement>(".chat-send-btn")!;
      const sendBox = send.getBoundingClientRect();
      expect(sendBox.bottom).toBeLessThanOrEqual(height!);
      expect(
        send.contains(
          document.elementFromPoint(
            sendBox.left + sendBox.width / 2,
            sendBox.top + sendBox.height / 2,
          ),
        ),
      ).toBe(true);
      if (width === 844 && height === 260 && context === "combined") {
        await page.elementLocator(document.body).hover({ position: { x: 0, y: 0 } });
        await userEvent.keyboard("{Control>}a{/Control}/");
        await afterLayout();
        const activeOption = document.getElementById(
          textarea.getAttribute("aria-activedescendant")!,
        );
        expect(activeOption).not.toBeNull();
        const activeBox = activeOption!.getBoundingClientRect();
        expect(
          activeOption!.contains(
            document.elementFromPoint(
              activeBox.left + activeBox.width / 2,
              activeBox.top + activeBox.height / 2,
            ),
          ),
        ).toBe(true);
        for (const nextHeight of [500, 501, 500, 260]) {
          await page.viewport(844, nextHeight);
          await afterLayout();
          expect(textarea.value).toBe("/");
          expect(document.activeElement).toBe(textarea);
          expect(textarea.getAttribute("aria-activedescendant")).toBe(activeOption!.id);
          const optionBox = activeOption!.getBoundingClientRect();
          expect(
            activeOption!.contains(
              document.elementFromPoint(
                optionBox.left + optionBox.width / 2,
                optionBox.top + optionBox.height / 2,
              ),
            ),
          ).toBe(true);
          const actionBox = send.getBoundingClientRect();
          expect(
            send.contains(
              document.elementFromPoint(
                actionBox.left + actionBox.width / 2,
                actionBox.top + actionBox.height / 2,
              ),
            ),
          ).toBe(true);
        }
        const editBox = textarea.getBoundingClientRect();
        expect(
          document.elementFromPoint(
            editBox.left + 8,
            editBox.top +
              Number.parseFloat(getComputedStyle(textarea).paddingTop) +
              Number.parseFloat(getComputedStyle(textarea).lineHeight) / 2,
          ),
        ).toBe(textarea);
        expectEditorLineVisible(textarea);
        const menuSend = send.getBoundingClientRect();
        expect(menuSend.bottom).toBeLessThanOrEqual(height);
        expect(
          send.contains(
            document.elementFromPoint(
              menuSend.left + menuSend.width / 2,
              menuSend.top + menuSend.height / 2,
            ),
          ),
        ).toBe(true);
        await userEvent.keyboard("{Escape}{Control>}a{/Control}x");
      }
      if (context !== "reply") {
        await page
          .elementLocator(container.querySelector<HTMLElement>(".chat-attachment-thumb img")!)
          .click();
        expect(props.onOpenImage).toHaveBeenCalledOnce();
        await page
          .elementLocator(container.querySelector<HTMLButtonElement>(".chat-attachment-remove")!)
          .click();
        expect(container.querySelector(".chat-attachments-preview")).toBeNull();
      }
      if (context !== "image") {
        await page
          .elementLocator(container.querySelector<HTMLButtonElement>(".chat-reply-preview button")!)
          .click();
        expect(container.querySelector(".chat-reply-preview")).toBeNull();
      }
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(textarea);
      await userEvent.keyboard("y");
      expect(textarea.value).toBe("xy");
      await page.elementLocator(send).click();
      expect(props.onSend).toHaveBeenCalledOnce();
    },
  );

  function drawNewSessionComposer() {
    styles.textContent += newSessionStyles;
    container.className = "";
    container.style.cssText =
      "position:fixed;inset:56px 0 0;display:flex;align-items:flex-end;overflow:hidden";
    const controller = new NewSessionComposerTextareaController();
    onTestFinished(() => controller.disconnect());
    const draw = () => render(renderNewSessionComposer(options), container);
    const options: NewSessionComposerOptions = {
      renderCritters: () => nothing,
      attachments: [],
      canSubmit: true,
      getAttachments: () => options.attachments,
      message: "",
      pendingAttachmentReads: 0,
      readSignal: new AbortController().signal,
      requiresModifier: false,
      requestUpdate: draw,
      submitting: false,
      textareaController: controller,
      onAttachmentsChange: (next) => {
        options.attachments = next;
        draw();
      },
      onPendingReadsChange: () => {},
      onInput: (message) => {
        options.message = message;
        draw();
      },
      onOpenImage: vi.fn(),
      onSubmit: vi.fn(),
    };
    draw();
    return { options, draw, textarea: container.querySelector<HTMLTextAreaElement>("textarea")! };
  }

  it.each([
    [1440, 900],
    [390, 844],
    [844, 260],
  ])(
    "keeps New Session editing and attachment actions reachable at %ix%i",
    async (width, height) => {
      await page.viewport(width!, height!);
      const { options, draw, textarea } = drawNewSessionComposer();
      await afterLayout();
      await page.elementLocator(textarea).click();
      options.attachments = [
        {
          id: "new-image",
          fileName: "fixture.png",
          mimeType: "image/png",
          dataUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        },
      ];
      draw();
      await afterLayout();
      await userEvent.keyboard("x");
      await afterLayout();
      expect(textarea.value).toBe("x");
      expectEditorLineVisible(textarea);
      const start = container.querySelector<HTMLButtonElement>(".chat-send-btn")!;
      expect(start.getBoundingClientRect().bottom).toBeLessThanOrEqual(height!);
      if (width === 1440) {
        await userEvent.keyboard("{Control>}a{/Control}/");
        await afterLayout();
        const option = document.getElementById(textarea.getAttribute("aria-activedescendant")!);
        expect(option).not.toBeNull();
        const optionBox = option!.getBoundingClientRect();
        expect(
          option!.contains(
            document.elementFromPoint(
              optionBox.left + optionBox.width / 2,
              optionBox.top + optionBox.height / 2,
            ),
          ),
        ).toBe(true);
        const startBox = start.getBoundingClientRect();
        expect(
          start.contains(
            document.elementFromPoint(
              startBox.left + startBox.width / 2,
              startBox.top + startBox.height / 2,
            ),
          ),
        ).toBe(true);
        await userEvent.keyboard("{Escape}");
        expect(document.activeElement).toBe(textarea);
        await userEvent.keyboard("{Control>}a{/Control}x");
      }
      await page
        .elementLocator(container.querySelector<HTMLElement>(".chat-attachment-thumb img")!)
        .click();
      expect(options.onOpenImage).toHaveBeenCalledOnce();
      await page
        .elementLocator(container.querySelector<HTMLButtonElement>(".chat-attachment-remove")!)
        .click();
      expect(container.querySelector(".chat-attachments-preview")).toBeNull();
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(textarea);
      await userEvent.keyboard("y");
      expect(textarea.value).toBe("xy");
      await page.elementLocator(start).click();
      expect(options.onSubmit).toHaveBeenCalledOnce();
    },
  );

  it("keeps the active last line visible when a tall New Session editor gains landscape space", async () => {
    await page.viewport(844, 390);
    const { textarea } = drawNewSessionComposer();
    await afterLayout();
    const message = Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join("\n");
    await page.elementLocator(textarea).fill(message);
    await userEvent.keyboard("{End}x");
    await afterLayout();
    expectEditorLineVisible(textarea, 11);
    expect(textarea.selectionStart).toBe(message.length + 1);

    await page.viewport(844, 500);
    await afterLayout();
    expectEditorLineVisible(textarea, 11);
    expect(textarea.value).toBe(`${message}x`);
    expect(textarea.selectionStart).toBe(message.length + 1);
    expect(textarea.selectionEnd).toBe(message.length + 1);
    expect(document.activeElement).toBe(textarea);
  });

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
    const part = render(
      renderChatComposer(
        createComposerProps({
          draft: "@Jordan Rivera @Morgan Williams",
          mentions: [
            { profileId: "jordan", start: 0, end: 14 },
            { profileId: "morgan", start: 15, end: 31 },
          ],
        }),
      ),
      container,
    );
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
