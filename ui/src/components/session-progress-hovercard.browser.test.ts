import { expect, it, vi } from "vitest";
import type { ControlUiSessionAccessory } from "../../../src/plugin-sdk/control-ui.js";
import { createInitializationContext } from "../pages/chat/chat-application-context.test-support.ts";
import type {
  ControlUiContributions,
  ControlUiRegistration,
} from "../plugins/control-ui-capability.ts";
import { createTestControlUiPluginHost } from "../test-helpers/control-ui-plugin-host.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import type { SessionProgressHovercardProvider } from "./session-progress-hovercard.runtime.tsx";
import "./session-progress-hovercard.runtime.tsx";

it("settles an empty focused preview without remounting or starving the renderer", async () => {
  const host = document.createElement(
    "openclaw-session-progress-hovercard-provider",
  ) as SessionProgressHovercardProvider;
  const link = document.createElement("a");
  link.className = "markdown-session-link";
  link.dataset.sessionKey = "agent:main:empty-preview";
  link.href = "/chat/main/empty-preview";
  link.textContent = "Empty preview";
  host.append(link);
  let mounts = 0;
  let notifyMount: (() => void) | undefined;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && node.matches(".session-progress-hovercard")) {
          mounts += 1;
          notifyMount?.();
        }
      }
    }
  });
  observer.observe(document.body, { childList: true });
  document.body.append(host);
  try {
    await host.updateComplete;
    flush();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const mounted = new Promise<void>((resolve) => {
        notifyMount = resolve;
      });
      link.focus();
      // Focus opens on a timer; animation frames alone do not order its completion.
      await mounted;
      notifyMount = undefined;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      expect(mounts).toBe(attempt);
      expect(document.querySelector(".session-progress-hovercard")).toBeNull();
      expect(document.activeElement).toBe(link);
      link.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      link.blur();
    }
  } finally {
    observer.disconnect();
    host.remove();
    await host.updateComplete;
  }
});

it("shows an SDK-only preview through the host context and retires its withdrawn content", async () => {
  const owner = new AbortController();
  const listeners = new Set<() => void>();
  let registered = true;
  const accessory: ControlUiSessionAccessory = {
    id: "task",
    placement: "session-hovercard",
    mount(container, context) {
      const button = document.createElement("button");
      button.textContent = "Inspect synthetic task";
      container.append(button);
      context.props.onPresenceChange?.(true);
      const stopControls = context.props.registerControls?.(() => [button]);
      return {
        dispose() {
          stopControls?.();
          container.replaceChildren();
        },
      };
    },
  };
  const context = createInitializationContext();
  const host = createTestControlUiPluginHost(context, "fixture");
  const registration = {
    key: "fixture/task" as const,
    pluginId: "fixture",
    host,
    signal: owner.signal,
    value: accessory,
  };
  const registry: {
    [K in keyof ControlUiContributions]: ControlUiRegistration<ControlUiContributions[K]>[];
  } = {
    pages: [],
    navigation: [],
    panels: [],
    actions: [],
    accessories: [registration],
    textReferences: [],
    widgets: [],
    inlineViews: [],
    replacements: [],
  };
  const registrations = vi
    .spyOn(context.plugins, "registrations")
    .mockImplementation((kind) => (registered ? registry[kind] : []));
  const subscription = vi.spyOn(context.plugins, "subscribe").mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const provider = document.createElement(
    "openclaw-session-progress-hovercard-provider",
  ) as SessionProgressHovercardProvider;
  provider.context = context;
  provider.gateway = context.gateway;
  const link = document.createElement("a");
  link.className = "markdown-session-link";
  link.dataset.sessionKey = "agent:main:synthetic-task";
  link.href = "/chat/main/synthetic-task";
  link.textContent = "Synthetic task";
  provider.append(link);
  document.body.append(provider);
  try {
    await provider.updateComplete;
    link.focus();
    await expect
      .poll(() => document.querySelector(".session-progress-hovercard button")?.textContent)
      .toBe("Inspect synthetic task");
    expect(document.querySelector<HTMLElement>(".session-hovercard")?.hidden).toBe(false);
    registered = false;
    owner.abort();
    listeners.forEach((listener) => listener());
    flush();
    await expect.poll(() => document.querySelector(".session-progress-hovercard")).toBeNull();
    expect(document.activeElement).toBe(link);
  } finally {
    owner.abort();
    provider.remove();
    await provider.updateComplete;
    registrations.mockRestore();
    subscription.mockRestore();
  }
});
