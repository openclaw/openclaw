import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "../../styles.css";
import "../../styles/chat.ts";
import { connectShellViewport, shellViewport } from "../../app/shell-viewport.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import {
  connectPaneTestView,
  createTestChatPane,
  getPaneTestRuntime,
} from "./chat-pane.test-support.ts";

it("publishes keyboard transitions to the mobile composer without transcript geometry updates", async () => {
  const viewport = Object.assign(new EventTarget(), {
    height: document.documentElement.clientHeight,
    offsetTop: 0,
    scale: 1,
  });
  vi.stubGlobal("visualViewport", viewport);
  const disconnect = connectShellViewport();
  const { pane } = createTestChatPane({ client: createGatewayBrowserClientFixture() });
  const runtime = getPaneTestRuntime(pane);
  runtime.mergedChrome = true;
  pane.style.cssText = "display: block; width: 430px; height: 600px";
  onTestFinished(() => {
    pane.element.remove();
    disconnect();
    vi.unstubAllGlobals();
  });
  connectPaneTestView(pane);
  document.body.append(pane.element);
  await pane.updateComplete;
  await expect.poll(() => pane.querySelector("textarea")).not.toBeNull();
  const textarea = expectDefined(pane.querySelector("textarea"), "mobile composer input");
  const shell = expectDefined(
    pane.querySelector<HTMLElement>(".agent-chat__composer-shell"),
    "mobile composer shell",
  );
  textarea.focus();
  await expect.poll(() => shell.dataset.composerEditing).toBe("true");
  expect(runtime.mobilePresentation.suspended).toBe(true);

  viewport.height = document.documentElement.clientHeight - 200;
  viewport.dispatchEvent(new Event("resize"));
  await expect.poll(() => shellViewport.snapshot?.keyboardVisible).toBe(true);
  await expect.poll(() => shell.dataset.composerKeyboard).toBe("true");
  expect(runtime.mobilePresentation.suspended).toBe(true);

  // The retained pane can leave mobile mode while its keyboard closes.
  runtime.mergedChrome = false;
  await pane.updateComplete;
  expect(pane.querySelector(".sidebar-region--mobile-host")).toBeNull();

  // Browser chrome still occludes the canvas after keyboard detection clears.
  viewport.height = document.documentElement.clientHeight - 40;
  viewport.dispatchEvent(new Event("resize"));
  await expect.poll(() => shellViewport.snapshot?.keyboardVisible).toBe(false);
  runtime.mergedChrome = true;
  await pane.updateComplete;
  await expect.poll(() => shell.dataset.composerKeyboard).toBeUndefined();
  await expect.poll(() => shell.dataset.composerEditing).toBe("false");
  expect(runtime.mobilePresentation.suspended).toBe(true);
});

it("keeps the mobile composer open while a typed draft waits", async () => {
  const { pane } = createTestChatPane({ client: createGatewayBrowserClientFixture() });
  const runtime = getPaneTestRuntime(pane);
  runtime.mergedChrome = true;
  pane.style.cssText = "display: block; width: 430px; height: 600px";
  const outside = document.body.appendChild(document.createElement("button"));
  outside.textContent = "Outside composer";
  onTestFinished(() => {
    pane.element.remove();
    outside.remove();
  });
  connectPaneTestView(pane);
  document.body.append(pane.element);
  await pane.updateComplete;
  await expect.poll(() => pane.querySelector("textarea")).not.toBeNull();
  const textarea = expectDefined(pane.querySelector("textarea"), "mobile composer input");
  const shell = expectDefined(
    pane.querySelector<HTMLElement>(".agent-chat__composer-shell"),
    "mobile composer shell",
  );
  const input = expectDefined(
    shell.querySelector<HTMLElement>(".agent-chat__input"),
    "mobile composer surface",
  );
  const toolbar = expectDefined(
    shell.querySelector<HTMLElement>(".agent-chat__composer-controls"),
    "mobile composer toolbar",
  );
  const toolbarShown = () => getComputedStyle(toolbar).display !== "none";
  expect(shell.dataset.mobileComposer).toBe("true");
  expect(input.dataset.composerLayout).toBe("single-line");
  expect(toolbarShown()).toBe(false);

  textarea.focus();
  await userEvent.keyboard("Finish this later");
  await expect.poll(() => shell.dataset.composerEditing).toBe("true");
  outside.focus();
  await expect.poll(() => shell.dataset.composerEditing).toBe("false");
  expect(textarea.value).toBe("Finish this later");
  expect(input.dataset.composerLayout).toBeUndefined();
  expect(toolbarShown()).toBe(true);
  // The open toolbar stays inside the writing surface, not above it.
  const surface = input.getBoundingClientRect();
  const controls = toolbar.getBoundingClientRect();
  expect(controls.top).toBeGreaterThanOrEqual(surface.top);
  expect(controls.bottom).toBeLessThanOrEqual(surface.bottom);

  textarea.focus();
  await userEvent.clear(textarea);
  outside.focus();
  await expect.poll(() => input.dataset.composerLayout).toBe("single-line");
  expect(toolbarShown()).toBe(false);
});
