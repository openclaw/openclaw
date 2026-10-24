import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, server, userEvent } from "vitest/browser";
import type { SessionGoal } from "../../api/types.ts";
import { ContentPresentation } from "../../lib/solid/presentation.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { mountSolid as mountSolidProps } from "../../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  composerContextWrapper,
  createComposerContainer,
  createComposerProps,
} from "./chat-composer.test-support.ts";
import type { ChatAttachmentControlsProps } from "./components/chat-attachment-controls.types.ts";
import { AttachmentPreview } from "./components/chat-attachments.tsx";
import { ChatGoal } from "./components/chat-composer-goal.tsx";
import { makeCapabilities } from "./components/chat-composer-menu.test-support.ts";
import { ComposerMenu } from "./components/chat-composer-menu.tsx";
import { createComposerQuestions } from "./components/chat-composer-questions.ts";
import { resetChatComposerState } from "./components/chat-composer-state.ts";
import type { ChatComposerProps } from "./components/chat-composer-types.ts";
import { ChatComposer } from "./components/chat-composer.tsx";
import { subscribeTranscriptScroll } from "./components/chat-transcript-scroll-events.ts";
import baseStyles from "../../styles/base.css?inline";
import contextStripStyles from "../../styles/chat/composer-context-strip.css?inline";
import goalStyles from "../../styles/chat/composer-progress.css?inline";
import queueStyles from "../../styles/chat/composer-queue.css?inline";
import composerSurfaceStyles from "../../styles/chat/composer-surface.css?inline";
import composerStyles from "../../styles/chat/composer.css?inline";
import componentStyles from "../../styles/components.css?inline";

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
  const [presented, setPresented] = createSignal(true);
  type ComposerFixtureProps = {
    input: ChatComposerProps;
    thread: boolean;
  };
  let composerView: ReturnType<typeof mountSolidProps<ComposerFixtureProps>> | undefined;
  let attachmentsView: ReturnType<typeof mountSolidProps<ChatAttachmentControlsProps>> | undefined;
  const query = <T extends Element = HTMLElement>(selector: string, root: ParentNode = container) =>
    root.querySelector<T>(selector)!;
  const rect = (selector: string, root: ParentNode = container) =>
    query(selector, root).getBoundingClientRect();
  const click = (selector: string) => page.elementLocator(query(selector)).click();
  async function resize(width: number, className = "", height = 900) {
    await page.viewport(width, height);
    container.className = className;
    container.style.width = `${Math.min(width - 32, 760)}px`;
  }
  function expectInside(inner: DOMRect, outer: DOMRect, vertical = false) {
    expect(inner.left).toBeGreaterThanOrEqual(outer.left);
    expect(inner.right).toBeLessThanOrEqual(outer.right);
    if (vertical) {
      expect(inner.top).toBeGreaterThanOrEqual(outer.top);
      expect(inner.bottom).toBeLessThanOrEqual(outer.bottom);
    }
  }
  const makeGoal = (overrides: Partial<SessionGoal> = {}): SessionGoal => ({
    schemaVersion: 1,
    id: "overflow-goal",
    objective: "Short objective",
    status: "complete",
    createdAt: 1000,
    updatedAt: 2000,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
    ...overrides,
  });

  function ComposerFixture(props: ComposerFixtureProps) {
    const Provider = composerContextWrapper(container)!;
    const questions = createComposerQuestions(props.input.paneId, () => props.input);
    return (
      <Provider>
        <ContentPresentation value={presented}>
          {props.thread ? <div class="chat-thread" /> : null}
          <ChatComposer {...props.input} questions={questions} />
        </ContentPresentation>
      </Provider>
    );
  }

  function AttachmentFixture(props: ChatAttachmentControlsProps) {
    return (
      <ContentPresentation value={presented}>
        <AttachmentPreview {...props} />
      </ContentPresentation>
    );
  }

  function drawComposer(input: ChatComposerProps, thread = false) {
    const props = { input: { ...input }, thread };
    if (composerView) {
      composerView.update(props);
    } else {
      composerView = mountSolidProps(ComposerFixture, props, container);
    }
  }

  beforeEach(async () => {
    await page.viewport(1200, 800);
    styles = document.createElement("style");
    styles.textContent = [
      baseStyles,
      componentStyles,
      composerStyles,
      composerSurfaceStyles,
      contextStripStyles,
      goalStyles,
    ].join("\n");
    document.head.append(styles);
    container = createComposerContainer();
    container.className = "agent-chat__input";
    container.style.width = "760px";
    document.body.append(container);
    setPresented(true);
  });

  afterEach(() => {
    cleanupSolid();
    composerView = undefined;
    attachmentsView = undefined;
    container.remove();
    styles.remove();
    resetChatComposerState();
  });

  it.each([390, 2048])(
    "keeps skill labels and dependency notes inside scrollable menu rows at %ipx",
    async (width) => {
      await page.viewport(width, 1000);
      container.className = "";
      container.style.cssText = `position: fixed; bottom: 24px; left: 16px; width: ${Math.min(width - 32, 760)}px`;
      const props = createComposerProps({
        capabilityMenu: makeCapabilities({
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
        }),
      });
      drawComposer(props);
      await click(".agent-chat__attach-menu .agent-chat__input-btn--attach");
      await expect.poll(() => container.querySelector('[data-value="open-skills"]')).not.toBeNull();
      await click('[data-value="open-skills"]');
      await afterLayout();
      const dropdown = query(".agent-chat__capability-menu");
      const menu = query(".oc-menu", dropdown);
      expect(menu.scrollHeight).toBeGreaterThan(menu.clientHeight);
      const rows = [...dropdown.querySelectorAll<HTMLElement>('[data-value^="skill:"]')];
      expect(rows).toHaveLength(16);

      for (const row of rows) {
        expectInside(
          rect(".agent-chat__capability-menu-label", row),
          row.getBoundingClientRect(),
          true,
        );
      }
      const name = query(".agent-chat__capability-menu-label > span", rows[1]);
      expect(name.getBoundingClientRect().height).toBeLessThan(
        2 * Number.parseFloat(getComputedStyle(name).lineHeight),
      );
      expect(menu.scrollWidth).toBeLessThanOrEqual(menu.clientWidth);
      expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    },
  );

  function drawAttachments(count: number) {
    const props = { attachments: attachments.slice(0, count) };
    if (attachmentsView) {
      attachmentsView.update(props);
    } else {
      attachmentsView = mountSolidProps(AttachmentFixture, props, container);
    }
  }

  function rail() {
    return query(".chat-attachments-preview");
  }

  it.each([390, 1440])(
    "keeps long reply context and its dismiss control inside the composer at %ipx",
    async (width) => {
      await resize(width);
      drawComposer(
        createComposerProps({
          goalDraftMode: { action: "start" },
          replyTarget: {
            messageId: "context-strip-reply",
            senderLabel: "A very long sender name ".repeat(12),
            text: "A long message excerpt that must leave room for cancellation. ".repeat(8),
          },
        }),
      );
      await afterLayout();

      const composer = query(".agent-chat__input");
      const reply = query(".chat-reply-preview");
      const goal = query(".agent-chat__goal-mode");
      const text = query(".chat-reply-preview__text", reply);
      const composerBox = composer.getBoundingClientRect();
      const replyBox = reply.getBoundingClientRect();
      const dismissBox = rect("button", reply);

      expect(dismissBox.width).toBeGreaterThan(0);
      expectInside(dismissBox, replyBox);
      expectInside(replyBox, composerBox);
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

  it("places stacked context before attachments and multiline input in RTL", async () => {
    await resize(390);
    container.dir = "rtl";
    drawComposer(
      createComposerProps({
        draft: "@Jordan Rivera\nReview the attached file.\nKeep this third line.",
        attachments: attachments.slice(0, 1),
        replyTarget: { messageId: "order-reply", text: "Original message" },
        goalDraftMode: { action: "start" },
        mentions: [{ profileId: "jordan", start: 0, end: 14 }],
      }),
    );
    await afterLayout();
    const strips = container.querySelectorAll<HTMLElement>(".composer-context-strip");
    expect(strips).toHaveLength(3);
    await waitForSolid(() => expect(query(".chat-attachment-thumb")).not.toBeNull());
    const attachmentBox = rect(".chat-attachment-thumb", rail());
    const textareaBox = rect("textarea");
    const composerBox = rect(".agent-chat__input");
    for (const strip of strips) {
      const box = strip.getBoundingClientRect();
      expect(box.height).toBeCloseTo(45, 0);
      expect(box.bottom).toBeLessThanOrEqual(attachmentBox.top);
      expectInside(box, composerBox);
      expect(getComputedStyle(strip).borderBottomWidth).toBe("1px");
    }
    expect(attachmentBox.height).toBeGreaterThan(0);
    expect(attachmentBox.bottom).toBeLessThanOrEqual(textareaBox.top);
  });

  it.each([
    [390, "rtl"],
    [1440, "ltr"],
  ] as const)("dismisses only the intended stacked context at %ipx in %s", async (width, dir) => {
    await resize(width);
    container.dir = dir;
    const onClearReply = vi.fn();
    const onGoalDraftModeChange = vi.fn();
    const onDraftChange = vi.fn();
    drawComposer(
      createComposerProps({
        draft: "@Jordan Rivera Review this file.",
        mentions: [{ profileId: "jordan", start: 0, end: 14 }],
        replyTarget: { messageId: "touch-reply", text: "Original message" },
        goalDraftMode: { action: "start" },
        onClearReply,
        onGoalDraftModeChange,
        onDraftChange,
      }),
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
      const button = query<HTMLButtonElement>(`${selector} button`);
      const box = button.getBoundingClientRect();
      expect(box.width).toBeGreaterThanOrEqual(24);
      expect(box.height).toBeGreaterThanOrEqual(24);
      expect(rect("svg", button)).toMatchObject({ width: 14, height: 14 });
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
    drawComposer(props);
    let strip = query('[role="status"]');
    const visibleNames = () =>
      [...strip.querySelectorAll<HTMLElement>(".composer-context-strip__person")]
        .filter((person) => !person.hidden)
        .map((person) => person.title);
    await expect.poll(visibleNames).toEqual(["@Jordan Rivera", "@Morgan Williams"]);
    for (const avatar of strip.querySelectorAll<HTMLElement>('[role="img"]')) {
      expect(avatar.getBoundingClientRect()).toMatchObject({ width: 16, height: 16 });
    }
    await document.fonts.ready;
    await afterLayout();
    const mutations = vi.fn();
    const observer = new MutationObserver(mutations);
    observer.observe(query(".composer-context-strip__people", strip), {
      subtree: true,
      attributes: true,
      // Avatar fallback classes can refresh independently of recipient sizing.
      attributeFilter: ["hidden", "style"],
      childList: true,
      characterData: true,
    });
    try {
      drawComposer({ ...props, draft: props.draft + " please review" });
      await afterLayout();
      expect(mutations).not.toHaveBeenCalled();
    } finally {
      observer.disconnect();
    }
    container.style.width = "300px";
    await expect.poll(visibleNames).toEqual(["@Jordan Rivera"]);
    let more = query(".composer-context-strip__more", strip);
    expect(more).toMatchObject({ hidden: false, textContent: "+1", title: "@Morgan Williams" });
    expect(strip.getBoundingClientRect().height).toBeCloseTo(41, 0);
    container.remove();
    container.style.width = "760px";
    await afterLayout();
    expect(visibleNames()).toEqual(["@Jordan Rivera"]);
    document.body.append(container);
    strip = query('[role="status"]');
    more = query(".composer-context-strip__more", strip);
    await expect.poll(visibleNames).toEqual(["@Jordan Rivera", "@Morgan Williams"]);
    expect(more.hidden).toBe(true);
    const longName = "Morgan Alexandra Penelope Williams ".repeat(3).trim();
    const draft = "@Jordan Rivera @" + longName;
    drawComposer({
      ...props,
      draft,
      mentions: [props.mentions![0]!, { profileId: "morgan", start: 15, end: draft.length }],
    });
    await expect.poll(visibleNames).toEqual(["@Jordan Rivera"]);
    expect(more).toMatchObject({ hidden: false, title: "@" + longName });
  });

  async function expectEdges(
    element: HTMLElement,
    scrollable: boolean,
    atStart = true,
    atEnd = !scrollable,
  ) {
    await expect
      .poll(() => element.dataset)
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
      const draw = () => drawComposer(props, true);
      draw();
      const textarea = query<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea");
      const placeholder = query(".agent-chat__composer-placeholder");
      const control = page.elementLocator(textarea);
      await afterLayout();
      expect(getComputedStyle(textarea).fieldSizing).toBe("content");
      const expectStableSize = async (draft: string) => {
        const mutations = vi.fn();
        const observer = new MutationObserver(mutations);
        observer.observe(textarea, { attributes: true, attributeFilter: ["style"] });
        const resized = vi.fn();
        const stop = subscribeTranscriptScroll(query(".chat-thread"), (observation) => {
          if (observation.type === "resize") {
            resized(observation);
          }
        });
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
        expect(getComputedStyle(placeholder)).toMatchObject({
          textOverflow: "ellipsis",
          overflowX: "hidden",
        });
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
      expect(textarea.getBoundingClientRect().height).toBeCloseTo(
        Number.parseFloat(getComputedStyle(textarea).maxHeight),
        0,
      );
      expect(textarea.scrollWidth).toBeLessThanOrEqual(textarea.clientWidth + 1);
      expect(container.getBoundingClientRect().width).toBe(width);
      await expectStableSize(`${draft}\nAnother line in the capped draft.`);

      await control.fill("");
      await afterLayout();
      expect(document.activeElement).toBe(textarea);
      expect(placeholder.checkVisibility()).toBe(true);
      expect(textarea.clientHeight).toBe(emptyHeight);
    },
  );

  it.each([false, true])(
    "updates attachment edges after resizing (reconnect=%s)",
    async (reconnect) => {
      drawAttachments(3);
      const element = rail();
      await afterLayout();
      await expectEdges(element, false);

      if (reconnect) {
        setPresented(false);
        flush();
      }
      container.style.width = "400px";
      if (reconnect) {
        await afterLayout();
        await expectEdges(element, false);
        setPresented(true);
        flush();
      }
      expect(rail()).toBe(element);
      expect(element.scrollWidth).toBeGreaterThan(element.clientWidth);
      await expectEdges(element, true);
      // The reconnect measurement can precede the native observer's first delivery.
      await afterLayout();
      container.style.width = "760px";
      await afterLayout();
      expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
      await expectEdges(element, false);
    },
  );

  it.each([
    [320, "active"],
    [390, "paused"],
    [560, "blocked"],
  ] as const)(
    "aligns the expanded %s px %s header and keeps controls above the objective",
    async (width, status) => {
      await resize(width, "agent-chat__composer-shell", 800);
      styles.textContent += queueStyles;
      const [expanded, setExpanded] = createSignal(false);
      const goal = makeGoal({
        id: "mobile-actions",
        objective: "Verify the deployment and summarize its health checks.\n".repeat(12),
        status,
        lastStatusNote: "Review the deployment results before continuing.",
        updatedAt: 61000,
        tokensUsed: 1500,
      });
      const onGoalAction = vi.fn();
      const onGoalEdit = vi.fn();
      mountSolid(
        () => (
          <div class="agent-chat__goal-float">
            <ChatGoal
              goal={goal}
              expanded={expanded()}
              canAct
              onGoalAction={onGoalAction}
              onGoalEdit={onGoalEdit}
              onExpandedChange={setExpanded}
            />
          </div>
        ),
        { container },
      );
      flush();
      const commands = query(".agent-chat__goal-command-actions");
      const visibleCommands = () =>
        [...commands.querySelectorAll<HTMLButtonElement>("button")]
          .filter((button) => button.checkVisibility())
          .map((button) => button.getAttribute("aria-label"));
      const collapsedCommands = status === "active" ? [] : ["Resume goal"];
      await afterLayout();
      expect(visibleCommands()).toEqual(collapsedCommands);
      await page.getByRole("button", { name: "Show goal details", exact: true }).click();
      await afterLayout();
      const objective = query(".agent-chat__goal-detail-objective");
      const commandBox = commands.getBoundingClientRect();
      expect(commandBox.height).toBeGreaterThan(0);
      expect(commandBox.bottom).toBeLessThanOrEqual(objective.getBoundingClientRect().top);
      const centers = [
        ".agent-chat__goal-icon svg",
        ".agent-chat__goal-label",
        ".agent-chat__goal-expand svg",
      ].map((selector) => {
        const box = rect(selector);
        return box.top + box.height / 2;
      });
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
      const cardBox = rect(".agent-chat__goal");
      // Exercise keyboard order before pointer activation establishes a native
      // navigation starting point on one of the slotted buttons.
      const clear = query<HTMLButtonElement>(".agent-chat__goal-clear", commands);
      clear.focus();
      expect(document.activeElement).toBe(clear);
      // Option-Tab includes buttons under Safari's default macOS keyboard settings.
      await userEvent.keyboard(
        server.browser === "webkit" && server.platform === "darwin"
          ? "{Alt>}{Shift>}{Tab}{/Shift}{/Alt}"
          : "{Shift>}{Tab}{/Shift}",
      );
      const action = status === "active" ? "pause" : "resume";
      expect(document.activeElement).toBe(query(`.agent-chat__goal-${action}`, commands));
      await userEvent.keyboard("{Enter}");
      expect(onGoalAction).toHaveBeenCalledExactlyOnceWith(goal.id, action);
      onGoalAction.mockClear();
      for (const button of commands.querySelectorAll<HTMLButtonElement>("button")) {
        const box = button.getBoundingClientRect();
        expectInside(box, cardBox);
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
        [goal.id, action],
        [goal.id, "clear"],
      ]);
      objective.scrollTop = objective.scrollHeight;
      await afterLayout();
      expect(commands.getBoundingClientRect().top).toBe(commandBox.top);
      await page.getByRole("button", { name: "Hide goal details", exact: true }).click();
      expect(visibleCommands()).toEqual(collapsedCommands);
    },
  );

  it.each(["attachments", "menu", "goal"] as const)(
    "updates retained %s edges when content grows, scrolls, and shrinks",
    async (kind) => {
      if (kind === "goal") {
        await page.viewport(480, 800);
        container.style.width = "400px";
      }
      const goal = makeGoal();
      const selector = {
        attachments: ".chat-attachments-preview",
        menu: ".slash-menu__scroll",
        goal: ".agent-chat__goal-detail-objective",
      }[kind];
      const [expanded, setExpanded] = createSignal(false);
      const [currentGoal, setGoal] = createSignal(goal, { equals: false });
      if (kind !== "attachments") {
        mountSolid(
          () =>
            kind === "goal" ? (
              <ChatGoal goal={currentGoal()} expanded canAct={false} onExpandedChange={() => {}} />
            ) : (
              <ComposerMenu id="overflow-menu" label="Fixture results" revision={expanded()}>
                {Array.from({ length: expanded() ? 20 : 1 }, (_, index) => (
                  <div style={{ height: "40px" }}>Result {index}</div>
                ))}
              </ComposerMenu>
            ),
          { container },
        );
      }
      const draw = (value: boolean) => {
        goal.objective = value ? "Fixture objective\n".repeat(30) : "Short objective";
        if (kind === "attachments") {
          drawAttachments(value ? 7 : 1);
        } else {
          setGoal(() => goal);
          setExpanded(value);
          flush();
        }
      };
      draw(false);
      const element = query(selector);
      await afterLayout();
      await expectEdges(element, false);

      draw(true);
      expect(query(selector)).toBe(element);
      const [size, viewport, position] =
        kind === "attachments"
          ? (["scrollWidth", "clientWidth", "scrollLeft"] as const)
          : (["scrollHeight", "clientHeight", "scrollTop"] as const);
      expect(element[size]).toBeGreaterThan(element[viewport]);
      await expectEdges(element, true);
      element[position] = element[size];
      await expectEdges(element, true, false, true);

      draw(false);
      expect(query(selector)).toBe(element);
      await expectEdges(element, false);
    },
  );
});
