import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import { McpAppView, waitForMcpAppHandlerRegistration } from "./mcp-app-view.ts";

const MCP_APP_VIEW_ELEMENT_NAME = `test-mcp-app-view-${crypto.randomUUID()}`;

// Keep the mounted view and i18n controller in the current module graph when
// the non-isolated runner has retained an earlier production registration.
class TestMcpAppView extends McpAppView {}

customElements.define(MCP_APP_VIEW_ELEMENT_NAME, TestMcpAppView);

describe("mcp-app-view localization", () => {
  afterEach(async () => {
    document.body.replaceChildren();
    await i18n.setLocale("en");
  });

  it("renders gateway failures with localized copy", async () => {
    i18n.registerTranslation("pt-BR", {
      mcpApp: {
        title: "Aplicativo MCP",
        unavailable: "Aplicativo MCP indisponível: {error}",
      },
    });
    await i18n.setLocale("pt-BR");

    const view = document.createElement(MCP_APP_VIEW_ELEMENT_NAME) as McpAppView;
    view.sessionKey = "agent:main:main";
    view.viewId = "view-1";
    document.body.append(view);

    await expect
      .poll(() => view.shadowRoot?.querySelector(".error")?.textContent)
      .toBe("Aplicativo MCP indisponível: MCP App gateway unavailable");
  });

  it("crosses two paint boundaries before delivering initial tool notifications", async () => {
    const frames: FrameRequestCallback[] = [];
    const pending = waitForMcpAppHandlerRegistration((callback) => {
      frames.push(callback);
      return frames.length;
    });
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });

    frames.shift()?.(0);
    await Promise.resolve();
    expect(resolved).toBe(false);

    frames.shift()?.(16);
    await pending;
    expect(resolved).toBe(true);
  });

  it("uses a delayed fallback when animation frames are suspended", async () => {
    const frames: FrameRequestCallback[] = [];
    let fallback: (() => void) | undefined;
    const pending = waitForMcpAppHandlerRegistration(
      (callback) => {
        frames.push(callback);
        return frames.length;
      },
      (callback, delayMs) => {
        expect(delayMs).toBe(1_000);
        fallback = callback;
        return 1;
      },
    );

    expect(frames).toHaveLength(1);
    fallback?.();
    await pending;
  });
});
