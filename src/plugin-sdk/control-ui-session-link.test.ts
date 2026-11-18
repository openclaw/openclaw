/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { createSessionHeaderLink } from "./control-ui-session-link.js";
import type { ControlUiAccessory, ControlUiHost, ControlUiViewContext } from "./control-ui.js";

// Mirrors the 2026.10.1 Discord/Slack browser entries; the plugin-sdk test typecheck
// compiles this file, so the shipped consumer shape must still type-check.
const shippedAccessory: ControlUiAccessory = {
  id: "conversation-link",
  placement: "session-header",
  mount: createSessionHeaderLink(({ conversationLink }) => conversationLink),
};

function currentHostContext(): ControlUiViewContext<{ sessionKey: string; agentId?: string }> {
  return {
    host: {} as ControlUiHost,
    signal: new AbortController().signal,
    props: { sessionKey: "agent:main:main", agentId: "main" },
    presented: true,
    mountDefault: () => () => {},
  };
}

describe("createSessionHeaderLink", () => {
  it("mounts under current session-header props without rendering a link", () => {
    const container = document.createElement("div");
    const view = shippedAccessory.mount(container, currentHostContext());

    expect(container.querySelector("a")).toBeNull();
    view?.update?.(currentHostContext());
    expect(container.querySelector("a")).toBeNull();
    view?.dispose?.();
    expect(container.childElementCount).toBe(0);
  });
});
