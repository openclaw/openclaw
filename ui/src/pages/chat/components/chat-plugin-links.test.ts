import { render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ControlUiHost,
  ControlUiLinkRoute,
} from "../../../../../src/plugin-sdk/control-ui.js";
import type { ControlUiPluginCapability } from "../../../plugins/control-ui-capability.ts";
import { routeControlUiChatLink } from "../../../plugins/control-ui-link-routing.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { renderChatThread } from "./chat-thread.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it("routes real Markdown clicks only after an owned destination accepts them", async () => {
  const abort = new AbortController();
  const host = { signal: abort.signal } as ControlUiHost;
  const resolve = vi.fn<ControlUiLinkRoute["resolve"]>((page) =>
    page.params?.record ? { id: "preview", params: page.params } : null,
  );
  const entry = (id: string, value: object, pluginId = "fixture") => ({
    key: `${pluginId}/${id}`,
    pluginId,
    value: { id, ...value },
    host,
    signal: abort.signal,
  });
  const pages = [entry("overview", {})];
  const panels = [entry("preview", {})];
  const routes = [entry("preview", { pageId: "overview", from: "chat", resolve })];
  const reportError = vi.fn();
  const plugins = {
    registrations: (kind: string) => ({ pages, panels, linkRoutes: routes })[kind],
    reportError,
  } as unknown as ControlUiPluginCapability;
  const open = vi.fn(() => true);
  const props = {
    ...threadProps("origin-pane", "agent:writer:source", [
      {
        role: "assistant",
        content:
          "[Document](/plugin?plugin=fixture&id=overview&p.agent=resource-owner&p.record=one)",
        timestamp: 1,
      },
    ]),
    onOpenPluginChatLink: (href: string) => routeControlUiChatLink(plugins, "", href, open),
  };
  const container = document.body.appendChild(document.createElement("div"));
  const transcript = createTestTranscript();
  render(renderChatThread(props, transcript), container);
  transcript.hostConnected();
  transcript.hostUpdated();
  await flushDeferredRowPrune();
  const anchor = container.querySelector<HTMLAnchorElement>('a[href*="plugin="]')!;
  expect(anchor).not.toBeNull();
  // Suppress jsdom's asynchronous navigation only after inspecting the real handler.
  const click = (init: MouseEventInit = {}) => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
    let accepted = false;
    const observe = () => {
      accepted = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", observe, { once: true });
    anchor.dispatchEvent(event);
    return accepted;
  };
  expect(click()).toBe(true);
  expect(open).toHaveBeenLastCalledWith("fixture", {
    id: "preview",
    params: { agent: "resource-owner", record: "one" },
  });
  for (const init of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ]) {
    expect(click(init)).toBe(false);
  }
  expect(open).toHaveBeenCalledTimes(1);
  anchor.target = "_blank";
  expect(click()).toBe(false);
  anchor.removeAttribute("target");
  anchor.download = "document";
  expect(click()).toBe(false);
  anchor.removeAttribute("download");
  open.mockReturnValue(false);
  expect(click()).toBe(false);
  open.mockReturnValue(true);
  const originalHref = anchor.href;
  for (const href of [
    "/plugin?plugin=fixture&id=overview",
    "/plugin?plugin=other&id=overview&p.record=one",
    "https://article.example/plugin?plugin=fixture&id=overview&p.record=one",
    "/wrong/plugin?plugin=fixture&id=overview&p.record=one",
  ]) {
    anchor.href = href;
    expect(click()).toBe(false);
  }
  anchor.href = originalHref;
  resolve.mockReturnValueOnce({ id: "other/preview" });
  expect(click()).toBe(false);
  resolve.mockImplementationOnce(() => {
    throw new Error("Cannot resolve");
  });
  expect(click()).toBe(false);
  expect(reportError).toHaveBeenCalledOnce();
  panels.length = 0;
  expect(click()).toBe(false);
  panels.push(entry("preview", {}));
  pages.length = 0;
  expect(click()).toBe(false);
  pages.push(entry("overview", {}));
  expect(
    routeControlUiChatLink(
      plugins,
      "/console",
      "/console/plugin?plugin=fixture&id=overview&p.record=two",
      open,
    ),
  ).toBe(true);
  expect(open).toHaveBeenLastCalledWith("fixture", { id: "preview", params: { record: "two" } });
  expect(routeControlUiChatLink(plugins, "/console", originalHref, open)).toBe(false);
  abort.abort();
  expect(click()).toBe(false);
  transcript.hostDisconnected();
});
