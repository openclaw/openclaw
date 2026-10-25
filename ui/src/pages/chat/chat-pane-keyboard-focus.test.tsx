/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import { registerModalSurface } from "../../components/overlay-registry.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import { isSidebarSlotVisible } from "./sidebar-layout.ts";
import {
  configureNativeKeyTarget,
  nativeControlNavigationCases,
} from "./test-helpers/chat-scroll-input.tsx";

function createFocusedPane() {
  const { pane, state } = createTestChatPane({
    client: createGatewayBrowserClientFixture(),
    sessions: createSessionCapabilityFixture(),
  });
  Object.assign(pane, { active: true, presented: true });
  const composer = document.createElement("div");
  composer.className = "agent-chat__composer-combobox";
  const textarea = composer.appendChild(document.createElement("textarea"));
  getChatComposerState(pane.presentationId).composerTextarea = textarea;
  pane.append(composer);
  return { pane, state, textarea, focus: vi.spyOn(textarea, "focus") };
}

function typingTarget(pane: ReturnType<typeof createFocusedPane>["pane"], target: HTMLElement) {
  target.addEventListener("keydown", (event) => pane.handleDocumentKeydown(event));
  target.focus();
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true, composed: true }));
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
        ["ArrowUp", "Home", "PageUp"].includes(key) &&
        !name.startsWith("Linux ") &&
        !name.startsWith("audio ") &&
        !(name.startsWith("video ") && (fixture.shiftKey || fixture.ctrlKey)) &&
        !(name.startsWith("Mac ") && key === "PageUp")
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
      sessions: createSessionCapabilityFixture(),
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

it("keeps the letter-to-composer contract when a button is focused", () => {
  const { pane, focus } = createFocusedPane();
  typingTarget(pane, bodyElement("button"));
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
});

it("distinguishes an open disclosure from an open overlay", () => {
  const { pane, focus } = createFocusedPane();
  const details = bodyElement("details");
  details.open = true;
  const summary = details.appendChild(document.createElement("summary"));
  typingTarget(pane, summary);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  focus.mockClear();
  const dialog = bodyElement("dialog");
  dialog.open = true;
  typingTarget(pane, dialog.appendChild(document.createElement("button")));
  expect(focus).not.toHaveBeenCalled();
});

it("does not steal typing focus from a shadow-root confirmation", async () => {
  onTestFinished(installDialogPolyfill());
  const { pane, focus } = createFocusedPane();
  const container = bodyElement("div");
  const shadow = container.attachShadow({ mode: "open" });
  const modal = shadow.appendChild(document.createElement("openclaw-modal-dialog"));
  const cancel = modal.appendChild(document.createElement("button"));

  const { dialog } = await getRenderedModalDialog(shadow);
  expect(dialog.open).toBe(true);
  expect(dialog.getRootNode()).toBe(shadow);
  expect(document.querySelector("dialog[open]")).toBeNull();
  cancel.addEventListener("keydown", (event) => pane.handleDocumentKeydown(event));
  cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "x", cancelable: true }));
  expect(focus).not.toHaveBeenCalled();
});

it("does not steal typing focus from a light-DOM confirmation", () => {
  const { pane, focus } = createFocusedPane();
  const modal = bodyElement("div");
  modal.setAttribute("aria-modal", "true");
  onTestFinished(registerModalSurface(modal));
  pane.handleDocumentKeydown(new KeyboardEvent("keydown", { key: "x", cancelable: true }));
  expect(focus).not.toHaveBeenCalled();
});

it("uses current panel availability before consuming its keyboard shortcut", () => {
  const { pane, state } = createFocusedPane();
  const shortcut = () =>
    new KeyboardEvent("keydown", { key: "`", code: "Backquote", ctrlKey: true, cancelable: true });
  state.terminalAvailable = false;
  const unavailable = shortcut();
  pane.handleDocumentKeydown(unavailable);
  expect(unavailable.defaultPrevented).toBe(false);
  expect(isSidebarSlotVisible(state.sidebarLayout, "terminal")).toBe(false);

  state.terminalAvailable = true;
  const available = shortcut();
  pane.handleDocumentKeydown(available);
  expect(available.defaultPrevented).toBe(true);
  expect(isSidebarSlotVisible(state.sidebarLayout, "terminal")).toBe(true);
});

it.each([
  { platform: "MacIntel", shiftKey: false },
  { platform: "MacIntel", shiftKey: true },
  { platform: "Win32", shiftKey: false },
  { platform: "Win32", shiftKey: true },
])(
  "hands native paste to the composer on $platform with Shift=$shiftKey without canceling the browser action",
  ({ platform, shiftKey }) => {
    const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    onTestFinished(() => platformSpy.mockRestore());
    const { pane, focus } = createFocusedPane();
    const transcript = pane.appendChild(document.createElement("div"));
    const event = new KeyboardEvent("keydown", {
      key: "v",
      code: "KeyV",
      metaKey: platform === "MacIntel",
      ctrlKey: platform !== "MacIntel",
      shiftKey,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    transcript.addEventListener("keydown", (key) => pane.handleDocumentKeydown(key));
    transcript.dispatchEvent(event);
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
  const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  onTestFinished(() => platformSpy.mockRestore());
  const { pane, focus } = createFocusedPane();
  pane.handleDocumentKeydown(
    new KeyboardEvent("keydown", { key: "v", code: "KeyV", shiftKey: true, ...keys }),
  );
  expect(focus).not.toHaveBeenCalled();
});

it.each([
  { name: "input", markup: "<input>" },
  { name: "textarea", markup: "<textarea></textarea>" },
  { name: "contenteditable", markup: '<div contenteditable="true"><span></span></div>' },
  { name: "textbox", markup: '<div role="textbox"><span></span></div>' },
  { name: "combobox", markup: '<div role="combobox"><span></span></div>' },
  { name: "exempt editor", markup: "<div data-chat-autotype-exempt><span></span></div>" },
  { name: "dialog", markup: "<dialog open><button></button></dialog>" },
])("keeps paste in $name", ({ markup }) => {
  const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  onTestFinished(() => platformSpy.mockRestore());
  const { pane, focus } = createFocusedPane();
  const fixture = bodyElement("div");
  fixture.innerHTML = markup;
  const target = fixture.querySelector<HTMLElement>("span, button, input, textarea")!;
  target.addEventListener("keydown", (event) => pane.handleDocumentKeydown(event));
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "v", ctrlKey: true, shiftKey: true, bubbles: true }),
  );
  expect(focus).not.toHaveBeenCalled();
});

it.each(["inactive", "hidden", "disabled", "readonly", "inert", "handled"])(
  "does not redirect paste when the session composer is %s",
  (state) => {
    const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    onTestFinished(() => platformSpy.mockRestore());
    const { pane, textarea, focus } = createFocusedPane();
    if (state === "inactive") {
      pane.active = false;
    }
    if (state === "hidden") {
      pane.presented = false;
    }
    if (state === "disabled") {
      textarea.disabled = true;
    }
    if (state === "readonly") {
      textarea.readOnly = true;
    }
    if (state === "inert") {
      pane.setAttribute("inert", "");
    }
    const event = new KeyboardEvent("keydown", {
      key: "v",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    if (state === "handled") {
      event.preventDefault();
    }
    pane.handleDocumentKeydown(event);
    expect(focus).not.toHaveBeenCalled();
  },
);
