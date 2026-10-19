import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createBrowserClient,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
  flushBrowserResponses as flush,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";
import "./browser-panel.ts";

function paste(text: string, types = ["text/plain"]) {
  const event = new Event("paste", { bubbles: true, composed: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { types, getData: (type: string) => (type === "text/plain" ? text : "<b>ignored</b>") },
  });
  return event;
}

function sendInput(
  input: HTMLTextAreaElement,
  type: "beforeinput" | "input",
  inputType: string,
  data: string | null = null,
  options: InputEventInit = {},
) {
  input.dispatchEvent(
    new InputEvent(type, {
      inputType,
      data,
      bubbles: true,
      cancelable: type === "beforeinput",
      ...options,
    }),
  );
}

function key(input: HTMLTextAreaElement, options: KeyboardEventInit) {
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...options }));
}
function button(panel: HTMLElement, label: string) {
  return panel.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
}

setupBrowserPanelTestCleanup();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", createStorageMock());
});

async function mount({ evaluateDisabled = false, clickable = false } = {}) {
  stubScreenshotMedia();
  const request = vi.fn(
    async (_method: string, _params?: BrowserRequestEnvelope): Promise<unknown> => ({ ok: true }),
  );
  const url = "https://example.test/page";
  const gateway = createBrowserClient(async (envelope) => {
    if (envelope.path === "/tabs") {
      return {
        running: true,
        tabs: [
          createBrowserPanelTestTab("form-tab", url, "Form"),
          createBrowserPanelTestTab("previous-tab", url, "Other"),
        ],
      };
    }
    if (envelope.path === "/screenshot") {
      return { path: "/fresh.png", targetId: envelope.body?.targetId, url };
    }
    if (envelope.path === "/act" && envelope.body?.kind === "evaluate") {
      if (evaluateDisabled) {
        throw new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "Evaluation disabled",
          details: { code: "ACT_EVALUATE_DISABLED" },
        });
      }
      return createBrowserPanelTestMetrics(url, "Form");
    }
    if (envelope.path === "/tabs/focus") {
      return { ok: true };
    }
    return request("browser.request", envelope);
  });
  const panel = document.createElement("openclaw-browser-panel");
  panel.available = true;
  panel.embedded = true;
  panel.presented = true;
  panel.client = gateway.client;
  panel.preferredTab = {
    tab: { profile: "work", target: "node", node: "browser-node", targetId: "form-tab" },
    revision: "initial",
  };
  mountSolid(() => panel);
  await waitForSolid(() => expect(panel.querySelector(".bp-shot")).not.toBeNull());
  const input = panel.querySelector<HTMLTextAreaElement>(".bp-input")!;
  if (clickable) {
    vi.spyOn(panel.querySelector(".bp-stage")!, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 100, 100),
    );
  }
  return { panel, request, input, actions: () => request.mock.calls.map(([, p]) => p?.body) };
}

it.each([
  { outcome: "accepted", text: "  hello 🦞\n世界 <b>text</b>\t  " },
  { outcome: "failed", text: "synthetic password" },
])("consumes paste and redacts $outcome errors", async ({ outcome, text }) => {
  const { panel, request } = await mount({ evaluateDisabled: true });
  expect(button(panel, "Inspect element").disabled).toBe(true);
  if (outcome === "failed") {
    request.mockRejectedValueOnce(new Error(`Request failed: ${text}`));
  }
  const event = paste(text, ["text/plain", "text/html"]);
  const bubbled = vi.fn();
  panel.addEventListener("paste", bubbled);
  panel.querySelector(".bp-viewport")!.dispatchEvent(event);
  await flush();

  expect(event.defaultPrevented).toBe(true);
  expect(bubbled).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledExactlyOnceWith("browser.request", {
    method: "POST",
    path: "/act",
    target: "node",
    node: "browser-node",
    query: { profile: "work" },
    body: { kind: "insertText", targetId: "form-tab", text },
  });
  if (outcome === "failed") {
    await panel.updateComplete;
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain("Could not paste");
    expect(panel.textContent).not.toContain(text);
  }
});

it("forwards soft-keyboard text and editing without printable keydown events", async () => {
  const { input, actions } = await mount();
  for (const [inputType, data] of [
    ["insertText", "hello 🦞"],
    ["deleteContentBackward", null],
    ["insertLineBreak", null],
  ]) {
    key(input, { key: "Unidentified", keyCode: 229 });
    sendInput(input, "beforeinput", inputType!, data);
    await flush();
  }
  expect(actions()).toMatchObject([
    { kind: "insertText", targetId: "form-tab", text: "hello 🦞" },
    { kind: "press", targetId: "form-tab", key: "Backspace" },
    { kind: "press", targetId: "form-tab", key: "Enter" },
  ]);
  expect(input.value).toBe("");
});

it("does not append a local autocorrection to text already sent remotely", async () => {
  const { panel, request, input } = await mount();
  sendInput(input, "beforeinput", "insertText", "teh");
  await flush();
  input.value = "the";
  sendInput(input, "input", "insertReplacementText", "the");
  await flush();
  await panel.updateComplete;
  expect(request).toHaveBeenCalledTimes(1);
  expect(input.value).toBe("");
  expect(input.getAttribute("autocorrect")).toBe("off");
  expect(panel.querySelector('[role="status"]')?.textContent).toContain("Edit the text directly");
});

it.each(["committed", "route changed", "capture mode"])("commits IME: %s", async (outcome) => {
  const { panel, request, input, actions } = await mount();
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  key(input, { key: "a", isComposing: true });
  input.value = "に";
  sendInput(input, "input", "insertCompositionText", "に", { isComposing: true });
  expect(input.value).toBe("に");
  expect(request).not.toHaveBeenCalled();
  if (outcome === "route changed") {
    panel.sessionKey = "replacement-session";
    panel.handleToggleRequest(
      new CustomEvent("openclaw:browser-toggle", { detail: { open: false } }),
    );
  } else if (outcome === "capture mode") {
    button(panel, "Annotate page").click();
  }
  input.value = "日本語";
  input.dispatchEvent(new CompositionEvent("compositionend", { data: "日本語", bubbles: true }));
  sendInput(input, "beforeinput", "insertFromComposition", "日本語");
  sendInput(input, "input", "insertFromComposition", "日本語");
  await flush();
  expect(input.value).toBe("");
  if (outcome === "committed") {
    expect(request.mock.calls[0]?.[0]).toBe("browser.request");
    expect(actions()).toEqual([{ kind: "insertText", text: "日本語", targetId: "form-tab" }]);
  } else {
    expect(request).not.toHaveBeenCalled();
  }
});

it("uses input for uncancelable commits and preserves text/edit order across async requests", async () => {
  const { request, input, actions } = await mount();
  const insert = createDeferred<unknown>();
  request.mockImplementationOnce(async () => insert.promise);
  sendInput(input, "beforeinput", "insertText", "hello", { cancelable: false });
  expect(request).not.toHaveBeenCalled();
  input.value = "hello";
  sendInput(input, "input", "insertText", "hello");
  sendInput(input, "beforeinput", "deleteContentBackward");
  expect(input.value).toBe("");
  expect(request).toHaveBeenCalledTimes(1);
  insert.resolve({ ok: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(actions()).toMatchObject([
    { kind: "insertText", text: "hello" },
    { kind: "press", key: "Backspace" },
  ]);
});

it.each(["failure", "route change", "new click"])("paste waits for click: %s", async (outcome) => {
  const { panel, request, input, actions } = await mount({ clickable: true });
  const click = createDeferred<unknown>();
  request.mockImplementationOnce(async () => click.promise);
  input.click();
  input.dispatchEvent(paste("for the clicked field"));
  expect(request).toHaveBeenCalledTimes(1);
  expect(actions()[0]).toMatchObject({ kind: "clickCoords" });
  if (outcome === "route change") {
    panel.sessionKey = "replacement-session";
    await panel.updateComplete;
  }
  if (outcome === "new click") {
    input.click();
  }
  if (outcome === "failure") {
    click.reject(new Error("Click failed"));
  } else {
    click.resolve({ ok: true });
  }
  await vi.advanceTimersByTimeAsync(0);
  const insertions = actions().filter((body) => body?.kind === "insertText");
  expect(insertions).toHaveLength(outcome === "new click" ? 1 : 0);
  if (outcome === "new click") {
    expect(actions()).toMatchObject([
      { kind: "clickCoords" },
      { kind: "insertText", text: "for the clicked field" },
      { kind: "clickCoords" },
    ]);
  }
});

it.each([false, true])("queues clicks before typing (pending text: %s)", async (pendingText) => {
  const { request, input, actions } = await mount({ clickable: true });
  const precedingText = createDeferred<unknown>();
  const firstClick = createDeferred<unknown>();
  if (pendingText) {
    request.mockImplementationOnce(async () => precedingText.promise);
  }
  request.mockImplementationOnce(async () => firstClick.promise);
  if (pendingText) {
    input.dispatchEvent(paste("previous field"));
  }
  input.click();
  input.click();
  key(input, { key: "a", cancelable: true });
  expect(request).toHaveBeenCalledTimes(1);
  precedingText.resolve({ ok: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(pendingText ? 2 : 1);
  firstClick.resolve({ ok: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(actions()).toMatchObject([
    ...(pendingText ? [{ kind: "insertText", text: "previous field" }] : []),
    { kind: "clickCoords" },
    { kind: "clickCoords" },
    { kind: "press", key: "a" },
  ]);
});

it("requires a successful click after a settled focus failure before pasting", async () => {
  const { request, input, actions } = await mount({ clickable: true });
  request.mockRejectedValueOnce(new Error("Click failed"));
  input.click();
  await vi.advanceTimersByTimeAsync(0);
  input.dispatchEvent(paste("do not send to the previous field"));
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(1);

  input.click();
  await vi.advanceTimersByTimeAsync(0);
  input.dispatchEvent(paste("correct field"));
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(3);
  expect(actions()[2]).toMatchObject({ kind: "insertText", text: "correct field" });
});

it.each(["empty", "files", "disconnected", "changing tab", "captured view"])(
  "does not send %s clipboard input",
  async (reason) => {
    const { panel, request } = await mount();
    if (reason === "disconnected") {
      panel.remove();
    }
    if (reason === "changing tab") {
      panel.selectHostedTab("previous-tab");
    }
    if (reason === "captured view") {
      button(panel, "Annotate page").click();
      await panel.updateComplete;
      expect(panel.querySelector(".bp-input")).toBeNull();
    }
    const text = reason === "empty" ? "" : "ignored";
    const types = reason === "files" ? ["Files"] : ["text/plain"];
    panel.querySelector(".bp-viewport")!.dispatchEvent(paste(text, types));
    expect(request).not.toHaveBeenCalled();
  },
);
