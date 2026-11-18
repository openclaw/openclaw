import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "../../test-helpers/load-styles.ts";
import { composerInputHasFocus } from "../../lib/composer-input.ts";
import {
  composerFixture,
  mention,
  resetMentionComposerFixture,
} from "./chat-composer-mentions.test-support.ts";
import { focusBrowserAnnotationComposerAfterUpdate } from "./chat-pane-browser-annotation.ts";
import { registerChatPane } from "./chat-pane-elements.ts";
import { focusChatComposerFromKeydown } from "./chat-pane-shared.ts";
import { RouteDraftComposerFocus } from "./route-draft-focus-handoff.ts";

afterEach(resetMentionComposerFixture);

async function fixture(kind: "chat" | "new-session", rich: boolean) {
  const draft = rich ? "@Alex " : "hello ";
  const f = composerFixture(kind, draft, rich ? [mention("alex-one", 0, 5)] : []);
  vi.useRealTimers();
  if (rich) {
    await expect.poll(() => f.query('[data-composer-editor="true"]')).not.toBeNull();
  }
  const input = f.query("textarea") as HTMLTextAreaElement;
  const content = f.query(rich ? '[data-composer-editor="true"]' : "textarea") as HTMLElement;
  return { ...f, draft, input, content };
}

it.each([false, true])("keeps dropped files as attachments with rich=%s", async (rich) => {
  const f = await fixture("new-session", rich);
  const transfer = new DataTransfer();
  transfer.items.add(new File(["FILE_CONTENT"], "audit.txt", { type: "text/plain" }));
  const rect = f.content.getBoundingClientRect();
  f.content.dispatchEvent(
    new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientX: rect.left + 4,
      clientY: rect.top + 4,
    }),
  );
  await expect.poll(() => f.container.textContent).toContain("audit.txt");
  expect(f.value().draft).toBe(f.draft);
});

it.each(["chat", "new-session"] as const)(
  "still accepts ordinary text dropped into the rich %s composer",
  async (kind) => {
    const f = await fixture(kind, true);
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "Dropped words ");
    const rect = f.content.getBoundingClientRect();
    f.content.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: rect.left + 4,
        clientY: rect.top + 4,
      }),
    );
    await expect.poll(() => f.value().draft).toContain("Dropped words ");
    expect(f.value().draft).toContain("@Alex");
  },
);

it.each([false, true])(
  "transfers typing focus to the visible composer with rich=%s",
  async (rich) => {
    const f = await fixture("chat", rich);
    const chrome = document.createElement("button");
    chrome.textContent = "Outside composer";
    f.container.append(chrome);
    const transfer = (event: KeyboardEvent) =>
      focusChatComposerFromKeydown(f.container, event, f.input);
    f.container.addEventListener("keydown", transfer, true);
    onTestFinished(() => f.container.removeEventListener("keydown", transfer, true));
    await userEvent.click(chrome);
    await userEvent.keyboard("x");
    expect(composerInputHasFocus(f.input)).toBe(true);
    expect(f.value().draft).toContain("x");
  },
);

it.each([false, true])(
  "returns annotation focus to the visible composer with rich=%s",
  async (rich) => {
    const f = await fixture("chat", rich);
    const other = document.createElement("button");
    f.container.append(other);
    await userEvent.click(other);
    focusBrowserAnnotationComposerAfterUpdate({
      composer: () => f.input,
      updateComplete: Promise.resolve(),
    });
    await Promise.resolve();
    expect(composerInputHasFocus(f.input)).toBe(true);
  },
);

it("keeps route handoff focus through composer replacement but yields to another control", async () => {
  const f = await fixture("chat", true);
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const sessionKey = "agent:main:focus-handoff";
  const pane = Object.assign(document.createElement("section"), {
    active: true,
    sessionKey,
    composerElement: f.input,
  });
  f.container.before(pane);
  pane.append(f.container);
  onTestFinished(registerChatPane(pane));
  onTestFinished(() => pane.remove());
  const handoff = new RouteDraftComposerFocus(pane);
  onTestFinished(() => handoff.dispose());
  const source = { sessionKey, focusComposer: true, draft: "initial" };
  handoff.beforeDraftCleanup(source);
  handoff.rendered({ sessionKey }, sessionKey, null);
  expect(composerInputHasFocus(f.input)).toBe(true);
  const replacement = document.createElement("textarea");
  pane.append(replacement);
  pane.composerElement = replacement;
  await vi.advanceTimersByTimeAsync(250);
  expect(document.activeElement).toBe(replacement);
  const other = document.createElement("button");
  pane.append(other);
  other.focus();
  pane.composerElement = f.input;
  await vi.advanceTimersByTimeAsync(250);
  expect(document.activeElement).toBe(other);
});
