import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, server, userEvent } from "vitest/browser";
import { createSessionGoalFixture } from "../../../../src/gateway/session-goal.test-support.js";
import type { SessionGoal } from "../../api/types.ts";
import { ContentPresentation } from "../../lib/solid/presentation.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { mountSolid as mountSolidProps } from "../../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createComposerContainer,
  createComposerProps,
  renderComposerInto,
} from "./chat-composer.test-support.ts";
import type { ChatAttachmentControlsProps } from "./components/chat-attachment-controls.types.ts";
import { AttachmentPreview } from "./components/chat-attachments.tsx";
import { ChatGoal } from "./components/chat-composer-goal.tsx";
import { makeCapabilities } from "./components/chat-composer-menu.test-support.ts";
import { ComposerMenu } from "./components/chat-composer-menu.tsx";
import "../../styles/base.css";
import "../../styles/components.css";
import "../../styles/chat/composer.css";
import "../../styles/chat/composer-surface.css";
import "../../styles/chat/composer-context-strip.css";
import "../../styles/chat/composer-progress.css";
import "../../styles/chat/composer-queue.css";
import { resetChatComposerState } from "./components/chat-composer-state.ts";

const attachments = Array.from({ length: 7 }, (_, index) => ({
  id: `overflow-${index}`,
  fileName: `fixture-${index}.txt`,
  mimeType: "text/plain",
}));
const afterLayout = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

let container: HTMLDivElement;
const [presented, setPresented] = createSignal(true);
let attachmentsView: ReturnType<typeof mountSolidProps<ChatAttachmentControlsProps>> | undefined;
const query = (selector: string, root: ParentNode = container) =>
  root.querySelector<HTMLElement>(selector)!;
const rect = (selector: string, root: ParentNode = container) =>
  query(selector, root).getBoundingClientRect();
const click = (selector: string) => page.elementLocator(query(selector)).click();
const expectHit = (element: HTMLElement, x: number, y: number) =>
  expect(element.contains(document.elementFromPoint(x, y))).toBe(true);
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
function AttachmentFixture(props: ChatAttachmentControlsProps) {
  return (
    <ContentPresentation value={presented}>
      <AttachmentPreview {...props} />
    </ContentPresentation>
  );
}

const drawComposer = (input: Parameters<typeof renderComposerInto>[1]) =>
  renderComposerInto(container, input);

beforeEach(async () => {
  await page.viewport(1200, 800);
  container = createComposerContainer();
  container.className = "agent-chat__input";
  container.style.width = "760px";
  document.body.append(container);
  setPresented(true);
});

afterEach(() => {
  cleanupSolid();
  attachmentsView = undefined;
  container.remove();
  resetChatComposerState();
});

it.each([390, 2048])("fits skill rows at %ipx", async (width) => {
  await page.viewport(width, 1000);
  container.className = "";
  container.style.cssText = `position: fixed; bottom: 24px; left: 16px; width: ${Math.min(width - 32, 760)}px`;
  drawComposer(
    createComposerProps({
      capabilityMenu: makeCapabilities({
        basePath: "",
        skills: Array.from({ length: 16 }, (_, index) => {
          const name = index === 0 ? "A long skill name ".repeat(5) : `fixture-skill-${index}`;
          return {
            key: name,
            name,
            enabled: false,
            baseEnabled: false,
            missingDeps: true,
          };
        }),
      }),
    }),
  );
  await click(".agent-chat__attach-menu .agent-chat__input-btn--attach");
  await expect.poll(() => container.querySelector('[data-value="open-skills"]')).not.toBeNull();
  await click('[data-value="open-skills"]');
  await afterLayout();
  const dropdown = query(".agent-chat__capability-menu");
  const menu = query(".oc-menu", dropdown);
  const scroll = query(".agent-chat__capability-menu-scroll", menu);
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  for (const row of dropdown.querySelectorAll<HTMLElement>('[data-value^="skill:"]')) {
    expectInside(rect(".oc-menu-item__label", row), row.getBoundingClientRect(), true);
  }
  expect(menu.scrollWidth).toBeLessThanOrEqual(menu.clientWidth);
  expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(width);
});

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

it.each([
  [390, "rtl"],
  [1440, "ltr"],
] as const)("fits and dismisses stacked context at %ipx (%s)", async (width, dir) => {
  await resize(width);
  container.dir = dir;
  const dismissed: string[] = [];
  const draft = "@Jordan Rivera\nReview the attached file.\nKeep this third line.";
  const props = createComposerProps({
    draft,
    attachments: attachments.slice(0, 1),
    mentions: [{ profileId: "jordan", start: 0, end: 14 }],
    replyTarget: {
      messageId: "touch-reply",
      senderLabel: "A very long sender name ".repeat(12),
      text: "A long message excerpt that must leave room for cancellation. ".repeat(8),
    },
    goalDraftMode: { action: "start" },
    onClearReply: () => dismissed.push("reply"),
    onGoalDraftModeChange: () => dismissed.push("goal"),
    onDraftChange: () => dismissed.push("mentions"),
  });
  drawComposer({ ...props });
  await afterLayout();
  await waitForSolid(() => expect(query(".chat-attachment-thumb")).not.toBeNull());
  const attachmentBox = rect(".chat-attachment-thumb", rail());
  const composer = query(".agent-chat__input");
  const strips = container.querySelectorAll<HTMLElement>(".composer-context-strip");
  for (const strip of strips) {
    const box = strip.getBoundingClientRect();
    expectInside(box, composer.getBoundingClientRect());
    expect(box.bottom).toBeLessThanOrEqual(attachmentBox.top);
  }
  expect(attachmentBox.height).toBeGreaterThan(0);
  expect(attachmentBox.bottom).toBeLessThanOrEqual(rect("textarea").top);
  expect(composer.scrollWidth).toBeLessThanOrEqual(composer.clientWidth + 1);
  const reply = query(".chat-reply-preview:not([role])");
  const text = query(".chat-reply-preview__text", reply);
  expectInside(rect("button", reply), reply.getBoundingClientRect());
  expect(text.getBoundingClientRect().width).toBeGreaterThan(0);
  expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
  expect(text.scrollHeight).toBeLessThanOrEqual(text.clientHeight + 1);

  const contexts = [
    [".agent-chat__goal-mode", "goal"],
    ['.composer-context-strip[role="status"]', "mentions"],
    [".chat-reply-preview:not([role])", "reply"],
  ] as const;
  for (const [selector, context] of contexts) {
    const button = query(`${selector} button`);
    const box = button.getBoundingClientRect();
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.height).toBeGreaterThanOrEqual(24);
    const center = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const inset = (width === 390 ? 44 : 24) / 2 - 0.5;
    const corners = [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ];
    const edges = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    const points = width === 390 ? corners : edges;
    for (const [x, y] of points) {
      expectHit(button, center.x + x! * inset, center.y + y! * inset);
    }

    const containerBox = container.getBoundingClientRect();
    await page.elementLocator(container).click({
      position: {
        x: center.x - inset - containerBox.left,
        y: center.y - (width === 390 ? inset : 0) - containerBox.top,
      },
    });
    expect(dismissed).toEqual([context]);
    dismissed.length = 0;
    drawComposer({ ...props });
    await afterLayout();
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
  await document.fonts.ready;
  await afterLayout();
  const people = [...strip.querySelectorAll(".composer-context-strip__person")];
  drawComposer({ ...props, draft: props.draft + " please review" });
  await afterLayout();
  for (const [index, person] of people.entries()) {
    expect(strip.querySelectorAll(".composer-context-strip__person")[index]).toBe(person);
  }
  expect(visibleNames()).toEqual(["@Jordan Rivera", "@Morgan Williams"]);
  container.style.width = "300px";
  await expect.poll(visibleNames).toEqual(["@Jordan Rivera"]);
  let more = query(".composer-context-strip__more", strip);
  expect(more).toMatchObject({ hidden: false, textContent: "+1", title: "@Morgan Williams" });
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
    .poll(() => [element.dataset.scrollable, element.dataset.atStart, element.dataset.atEnd])
    .toEqual([scrollable, atStart, atEnd].map(String));
  expect(getComputedStyle(element).maskImage === "none").toBe(!scrollable);
}

it.each([
  { viewport: 1200, width: 760 },
  { viewport: 390, width: 342 },
])("sizes drafts and ellipsizes placeholders at $viewport px", async ({ viewport, width }) => {
  await page.viewport(viewport, 800);
  container.classList.add("chat");
  container.style.width = `${width}px`;
  const props = createComposerProps({
    assistantName: "A deliberately long assistant name ".repeat(8),
    onDraftChange: (draft) => {
      props.draft = draft;
    },
  });
  drawComposer(props);
  const textarea = container.querySelector<HTMLTextAreaElement>(
    ".agent-chat__composer-combobox > textarea",
  )!;
  const placeholder = query(".agent-chat__composer-placeholder");
  const control = page.elementLocator(textarea);
  await afterLayout();
  const expectStableSize = async (draft: string) => {
    const height = textarea.clientHeight;
    await control.fill(draft);
    await afterLayout();
    expect(textarea.clientHeight).toBe(height);
  };

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
    expect(placeholder.getBoundingClientRect().right).toBeLessThanOrEqual(
      textarea.getBoundingClientRect().right + 1,
    );
  }

  const emptyHeight = textarea.clientHeight;
  await expectStableSize("A short editable draft.");
  const draft =
    "A typed line that wraps within the available composer width. ".repeat(12) +
    "\nA second editable line.";
  await control.fill(draft);
  await afterLayout();
  expect([textarea.value, props.draft]).toEqual([draft, draft]);
  expect(placeholder.checkVisibility()).toBe(false);
  expect(textarea.clientHeight).toBeGreaterThan(emptyHeight);
  expect(textarea.scrollHeight).toBeGreaterThan(textarea.clientHeight);
  expect(textarea.getBoundingClientRect().height).toBeCloseTo(
    Number.parseFloat(getComputedStyle(textarea).maxHeight),
    0,
  );
  expect(textarea.scrollWidth).toBeLessThanOrEqual(textarea.clientWidth + 1);
  await expectStableSize(`${draft}\nAnother line in the capped draft.`);

  await control.fill("");
  await afterLayout();
  expect(document.activeElement).toBe(textarea);
  expect(placeholder.checkVisibility()).toBe(true);
  expect(textarea.clientHeight).toBe(emptyHeight);
});

it.each([
  [320, "active"],
  [560, "blocked"],
] as const)("lays out expanded goal controls at %ipx (%s)", async (width, status) => {
  await resize(width, "agent-chat__composer-shell", 800);
  const [expanded, setExpanded] = createSignal(false);
  const goal: SessionGoal = createSessionGoalFixture("overflow-goal", "Short objective", {
    status,
    lastStatusNote: "Review the deployment results before continuing.",
    createdAt: 1000,
    updatedAt: 2000,
  });
  const [currentGoal, setGoal] = createSignal(goal, { equals: false });
  const drawObjective = (objective: string) => {
    goal.objective = objective;
    setGoal(() => goal);
    flush();
  };
  const onGoalAction = vi.fn();
  mountSolid(
    () => (
      <div class="agent-chat__goal-float">
        <ChatGoal
          goal={currentGoal()}
          expanded={expanded()}
          canAct
          onGoalAction={onGoalAction}
          onGoalEdit={vi.fn()}
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
  await expectEdges(objective, false);
  drawObjective("Verify the deployment and summarize its health checks.\n".repeat(30));
  expect(query(".agent-chat__goal-detail-objective")).toBe(objective);
  expect(objective.scrollHeight).toBeGreaterThan(objective.clientHeight);
  await expectEdges(objective, true);
  const commandBox = commands.getBoundingClientRect();
  expect(commandBox.height).toBeGreaterThan(0);
  expect(commandBox.bottom).toBeLessThanOrEqual(objective.getBoundingClientRect().top);
  const centers = ["icon svg", "label", "expand svg"].map((part) => {
    const box = rect(`.agent-chat__goal-${part}`);
    return box.top + box.height / 2;
  });
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
  const cardBox = rect(".agent-chat__goal");
  const clear = query(".agent-chat__goal-clear", commands);
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
  for (const button of commands.querySelectorAll<HTMLButtonElement>("button")) {
    const box = button.getBoundingClientRect();
    expectInside(box, cardBox);
    expect(box.height).toBeGreaterThanOrEqual(24);
    expectHit(button, box.left + box.width / 2, box.top + box.height / 2);
  }
  objective.scrollTop = objective.scrollHeight;
  await expectEdges(objective, true, false, true);
  expect(commands.getBoundingClientRect().top).toBe(commandBox.top);
  drawObjective("Short objective");
  expect(query(".agent-chat__goal-detail-objective")).toBe(objective);
  await expectEdges(objective, false);
  await page.getByRole("button", { name: "Hide goal details", exact: true }).click();
  expect(visibleCommands()).toEqual(collapsedCommands);
});

it.each(["attachments", "menu"] as const)("updates retained %s scroll edges", async (kind) => {
  const selector = {
    attachments: ".chat-attachments-preview",
    menu: ".slash-menu__scroll",
  }[kind];
  const [expanded, setExpanded] = createSignal(false);
  if (kind === "menu") {
    mountSolid(
      () => (
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
    if (kind === "attachments") {
      drawAttachments(value ? 7 : 1);
    } else {
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
  if (kind === "attachments") {
    drawAttachments(3);
    setPresented(false);
    flush();
    container.style.width = "400px";
    await afterLayout();
    await expectEdges(element, false);
    setPresented(true);
    flush();
    expect(rail()).toBe(element);
    expect(element.scrollWidth).toBeGreaterThan(element.clientWidth);
    await expectEdges(element, true);
    await afterLayout();
    container.style.width = "760px";
    await afterLayout();
    expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    await expectEdges(element, false);
  }
});
