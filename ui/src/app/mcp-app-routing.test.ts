import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpAppRouteFromSearch } from "../lib/mcp-app-route.ts";
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
    anchor.target = "_blank";
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
