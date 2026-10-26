/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import { registerModalSurface } from "../../components/overlay-registry.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import {
  configureNativeKeyTarget,
  nativeControlNavigationCases,
} from "./test-helpers/chat-scroll-input.tsx";

function createFocusedPane(platform = "Win32") {
  const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  onTestFinished(() => platformSpy.mockRestore());
  const { pane, state } = createTestChatPane({
    client: createGatewayBrowserClientFixture(),
  });
  Object.assign(pane, { active: true, presented: true });
  const composer = document.createElement("div");
  composer.className = "agent-chat__composer-combobox";
  const textarea = composer.appendChild(document.createElement("textarea"));
  getChatComposerState(pane.presentationId).composerTextarea = textarea;
  pane.append(composer);
  const press = (keys: KeyboardEventInit = {}, target?: HTMLElement) => {
    const event = new KeyboardEvent("keydown", {
      key: "x",
      bubbles: true,
      composed: true,
      cancelable: true,
      ...keys,
    });
    if (target) {
      target.addEventListener("keydown", (key) => pane.handleDocumentKeydown(key));
      target.focus();
      target.dispatchEvent(event);
    } else {
      pane.handleDocumentKeydown(event);
    }
    return event;
  };
  return { pane, state, textarea, press, focus: vi.spyOn(textarea, "focus") };
}

function bodyElement<K extends keyof HTMLElementTagNameMap>(tag: K) {
  const element = document.body.appendChild(document.createElement(tag));
  onTestFinished(() => element.remove());
  return element;
}

it.each([
  ["range", "Home", () => <input type="range" />, false],
  ["input", "ArrowUp", () => <input />, false],
  [
    "handled widget",
    "PageUp",
    () => <div onKeyDown={(event: KeyboardEvent) => event.preventDefault()}>Widget</div>,
    false,
  ],
  ["transcript", "Home", () => <span>History</span>, true],
  ...nativeControlNavigationCases
    .filter((testCase) => {
      const [name, key] = testCase;
      const fixture = testCase[4];
      return (
        (key === "Home" || (key === "PageUp" && /^(Win32 input|video)/.test(name))) &&
        !name.startsWith("Linux ") &&
        !name.startsWith("audio ") &&
        !(name.startsWith("video ") && (fixture.shiftKey || fixture.ctrlKey))
      );
    })
    .map(
      ([name, key, content, controlOwned, fixture]) =>
        [name, key, content, !controlOwned, fixture] as const,
    ),
] as const)(
  "loads older history only when %s yields navigation",
  async (_name, key, content, loadsHistory, fixture = {}) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });
    const request = vi.fn(async () => ({ messages: [], hasMore: false }));
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
    });
    vi.spyOn(pane.transcript, "isPositionSettled", "get").mockReturnValue(true);
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2 };
    pane.historyAutoLoadBlocked = true;
    const { container } = mountSolid(() => (
      <div onKeyDown={(event) => pane.handleTranscriptHistoryIntent(event)}>{content()}</div>
    ));
    const thread = container.querySelector("div")!;
    pane.historySentinel = thread.appendChild(document.createElement("div"));
    pane.historySentinel.className = "chat-history-sentinel";
    vi.spyOn(pane.transcript, "scrollElement", "get").mockReturnValue(thread);
    onTestFinished(configureNativeKeyTarget(thread.firstElementChild!, fixture));
    thread.firstElementChild!.dispatchEvent(
      new KeyboardEvent("keydown", { ...fixture, key, bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(loadsHistory ? 1 : 0);
    expect(pane.historyAutoLoadBlocked).toBe(!loadsHistory);
  },
);

it("distinguishes an open disclosure from an open overlay", () => {
  const { press, focus } = createFocusedPane();
  const details = bodyElement("details");
  details.open = true;
  const summary = details.appendChild(document.createElement("summary"));
  press({}, summary);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  focus.mockClear();
  const dialog = bodyElement("dialog");
  dialog.open = true;
  press({}, dialog.appendChild(document.createElement("button")));
  expect(focus).not.toHaveBeenCalled();
});

it("does not steal typing focus from a shadow-root confirmation", async () => {
  onTestFinished(installDialogPolyfill());
  const { press, focus } = createFocusedPane();
  const container = bodyElement("div");
  const shadow = container.attachShadow({ mode: "open" });
  const modal = shadow.appendChild(document.createElement("openclaw-modal-dialog"));
  const cancel = modal.appendChild(document.createElement("button"));

  const { dialog } = await getRenderedModalDialog(shadow);
  expect(dialog.open).toBe(true);
  expect(dialog.getRootNode()).toBe(shadow);
  expect(document.querySelector("dialog[open]")).toBeNull();
  press({}, cancel);
  expect(focus).not.toHaveBeenCalled();
});

it("does not steal typing focus from a light-DOM confirmation", () => {
  const { press, focus } = createFocusedPane();
  const modal = bodyElement("div");
  modal.setAttribute("aria-modal", "true");
  onTestFinished(registerModalSurface(modal));
  press();
  expect(focus).not.toHaveBeenCalled();
});

it.each(["MacIntel", "Win32"])(
  "hands native paste to the composer on %s without canceling the browser action",
  (platform) => {
    const { pane, press, focus } = createFocusedPane(platform);
    const transcript = pane.appendChild(document.createElement("div"));
    const event = press(
      {
        key: "v",
        code: "KeyV",
        metaKey: platform === "MacIntel",
        ctrlKey: platform !== "MacIntel",
        shiftKey: platform === "MacIntel",
      },
      transcript,
    );
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(event.defaultPrevented).toBe(false);
  },
);

it.each([
  { name: "Control on Mac", platform: "MacIntel", ctrlKey: true },
  { name: "Command on Windows", platform: "Win32", metaKey: true },
  { name: "both primary modifiers", ctrlKey: true, metaKey: true },
  { name: "Alt", ctrlKey: true, altKey: true },
  { name: "another shortcut", ctrlKey: true, key: "c" },
])("leaves $name with its existing owner", ({ name: _name, platform = "Win32", ...keys }) => {
  const { press, focus } = createFocusedPane(platform);
  press({ key: "v", code: "KeyV", shiftKey: true, ...keys });
  expect(focus).not.toHaveBeenCalled();
});

it.each([
  "<input>",
  "<textarea></textarea>",
  '<div contenteditable="true"><span></span></div>',
  '<div role="textbox"><span></span></div>',
  '<div role="combobox"><span></span></div>',
  "<div data-chat-autotype-exempt><span></span></div>",
])("keeps paste in %s", (markup) => {
  const { press, focus } = createFocusedPane();
  const fixture = bodyElement("div");
  fixture.innerHTML = markup;
  const target = fixture.querySelector<HTMLElement>("span, button, input, textarea")!;
  press({ key: "v", ctrlKey: true, shiftKey: true }, target);
  expect(focus).not.toHaveBeenCalled();
});

type FocusedPane = ReturnType<typeof createFocusedPane>;
it.each<[string, (context: FocusedPane, event: KeyboardEvent) => void]>([
  ["inactive", ({ pane }) => Object.assign(pane, { active: false })],
  ["hidden", ({ pane }) => Object.assign(pane, { presented: false })],
  ["disabled", ({ textarea }) => Object.assign(textarea, { disabled: true })],
  ["readonly", ({ textarea }) => Object.assign(textarea, { readOnly: true })],
  ["inert", ({ pane }) => pane.setAttribute("inert", "")],
  ["handled", (_context, event) => event.preventDefault()],
])("does not redirect paste when the session composer is %s", (_name, prepare) => {
  const context = createFocusedPane();
  const event = new KeyboardEvent("keydown", {
    key: "v",
    ctrlKey: true,
    shiftKey: true,
    cancelable: true,
  });
  prepare(context, event);
  context.pane.handleDocumentKeydown(event);
  expect(context.focus).not.toHaveBeenCalled();
});
