import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpAppRouteFromSearch, parseMcpAppLink } from "../lib/mcp-app-route.ts";
import { startMcpAppRouting } from "./mcp-app-link-routing.ts";

describe("MCP app link routing", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.replaceChildren();
  });

  it("passes the marketplace plugin identity through the real click boundary", async () => {
    const navigate = vi.fn();
    cleanup = startMcpAppRouting({ navigate }).dispose;
    const anchor = document.createElement("a");
    anchor.href = "codex://plugins/vendor-parts@team/app/cad.library?path=%2Fselected%3Fid%3D42";
    document.body.append(anchor);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    expect(anchor.dispatchEvent(click)).toBe(false);
    anchor.href = "https://example.com/changed-after-click";
    await vi.dynamicImportSettled();
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate.mock.calls[0]?.[0]).toBe("apps");
    expect(mcpAppRouteFromSearch(navigate.mock.calls[0]?.[1].search)).toEqual({
      kind: "plugin",
      pluginId: "vendor-parts",
      marketplace: "team",
      toolName: "cad.library",
      deepLink: "/selected?id=42",
    });
  });

  it("routes ordinary chat links even when their renderer requests a new tab", async () => {
    const navigate = vi.fn();
    cleanup = startMcpAppRouting({ navigate }).dispose;
    const anchor = document.createElement("a");
    anchor.href = "codex://plugins/parts@team/app/cad.library?path=%2Fparts%3Ftag%3Dbolt";
    anchor.target = "_blank";
    const event = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true });
    vi.spyOn(event, "composedPath").mockReturnValue([anchor, document]);
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.dynamicImportSettled();
    expect(navigate).toHaveBeenCalledWith("apps", {
      search: "?tool=cad.library&path=%2Fparts%3Ftag%3Dbolt&plugin=parts&marketplace=team",
    });
  });

  it("does not hijack ordinary URLs, downloads, or modified navigation", async () => {
    const navigate = vi.fn();
    cleanup = startMcpAppRouting({ navigate }).dispose;
    const anchor = document.createElement("a");
    for (const href of [
      "https://example.com/x",
      "mailto:hello@example.com",
      "/relative",
      "https://chatgpt.com/other",
      "https://chatgpt.com/plugins/parts",
      "https://chatgpt.com/plugins/",
      "https://chatgpt.com/plugins/x/app",
    ]) {
      anchor.href = href;
      const event = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true });
      vi.spyOn(event, "composedPath").mockReturnValue([anchor, document]);
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    anchor.href = "chatgpt://plugins/parts/app/cad.library";
    const event = new MouseEvent("click", {
      button: 0,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    vi.spyOn(event, "composedPath").mockReturnValue([anchor, document]);
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    anchor.download = "plugin";
    const download = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true });
    vi.spyOn(download, "composedPath").mockReturnValue([anchor, document]);
    document.dispatchEvent(download);
    expect(download.defaultPrevented).toBe(false);
    await vi.dynamicImportSettled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("intercepts accepted parser fixtures and leaves ordinary links alone", () => {
    const navigate = vi.fn();
    cleanup = startMcpAppRouting({ navigate }).dispose;
    const clickIsIntercepted = (href: string) => {
      const anchor = document.createElement("a");
      anchor.href = href;
      document.body.append(anchor);
      const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      const defaultAllowed = anchor.dispatchEvent(click);
      anchor.remove();
      return !defaultAllowed;
    };
    for (const href of [
      "codex://plugins/parts%40work/app/cad%2Flibrary?path=%2Fparts%3Ftag%3Dbolt%26sort%3Dasc",
      "https://chatgpt.com/plugins/parts/app/cad.library",
      "codex://plugins/vendor-parts@team%20market/app/cad.library?path=%2Fparts%3Ftag%3Dbolt",
      "chatgpt://plugins/parts/app/cad.library",
      "openclaw://plugins/parts/app/cad.library",
      "HTTPS://CHATGPT.COM:443/plugins/parts/app/cad.library",
      "CODEX://plugins/parts/app/cad.library",
      "openclaw://plugins/parts/app/cad.library/?path=%2Fparts",
      "https://chatgpt.com/plugins/parts/app/cad.library/?path=%2Fparts",
    ]) {
      expect(parseMcpAppLink(href)).not.toBeNull();
      expect(clickIsIntercepted(href)).toBe(true);
    }
    for (const href of [
      "https://example.com/x",
      "mailto:hello@example.com",
      "/relative",
      "https://chatgpt.com/other",
      "https://chatgpt.com/plugins/parts",
      "https://chatgpt.com/plugins/",
      "https://chatgpt.com/plugins/x/app",
    ]) {
      expect(clickIsIntercepted(href)).toBe(false);
    }
  });

  it("drops malformed plugin links after interception", async () => {
    const navigate = vi.fn();
    cleanup = startMcpAppRouting({ navigate }).dispose;
    const anchor = document.createElement("a");
    anchor.href = "codex://plugins/%zz/app/library";
    const event = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true });
    vi.spyOn(event, "composedPath").mockReturnValue([anchor, document]);
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.dynamicImportSettled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not navigate after the routing owner is disposed while loading", async () => {
    const navigate = vi.fn();
    cleanup = startMcpAppRouting({ navigate }).dispose;
    const anchor = document.createElement("a");
    anchor.href = "codex://plugins/parts/app/library";
    const event = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true });
    vi.spyOn(event, "composedPath").mockReturnValue([anchor, document]);
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    cleanup();
    await vi.dynamicImportSettled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
