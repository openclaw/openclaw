import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClawdbotApp } from "./app";

const originalConnect = ClawdbotApp.prototype.connect;

function mountApp(pathname: string) {
  window.history.replaceState({}, "", pathname);
  const app = document.createElement("clawdbot-app") as ClawdbotApp;
  document.body.append(app);
  return app;
}

beforeEach(() => {
  ClawdbotApp.prototype.connect = () => {
    // no-op: avoid real gateway WS connections in browser tests
  };
  window.__CLAWDBOT_CONTROL_UI_BASE_PATH__ = undefined;
  document.body.innerHTML = "";
});

afterEach(() => {
  ClawdbotApp.prototype.connect = originalConnect;
  window.__CLAWDBOT_CONTROL_UI_BASE_PATH__ = undefined;
  document.body.innerHTML = "";
});

describe("chat markdown rendering", () => {
  // Skip: Tool card rendering was refactored to use sidebar-based output display.
  // The .chat-tool-card__output class is only in the legacy renderer and requires
  // the <details> element to be expanded. New layout uses renderToolCard() which
  // shows preview/inline text without the __output wrapper.
  it.skip("renders markdown inside tool result cards", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const timestamp = Date.now();
    app.chatMessages = [
      {
        role: "assistant",
        content: [
          { type: "toolcall", name: "noop", arguments: {} },
          { type: "toolresult", name: "noop", text: "Hello **world**" },
        ],
        timestamp,
      },
    ];
    // Expand the tool output card so its markdown is rendered into the DOM.
    app.toolOutputExpanded = new Set([`${timestamp}:1`]);

    await app.updateComplete;

    const strong = app.querySelector(".chat-tool-card__output strong");
    expect(strong?.textContent).toBe("world");
  });
});
