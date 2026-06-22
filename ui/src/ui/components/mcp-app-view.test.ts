/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway.ts";
import { setMcpAppContext } from "../mcp-app-context.ts";
import {
  buildMcpAppHostContext,
  McpAppView,
  resolveMcpAppIframeSandbox,
  resolveMcpAppSandboxMode,
} from "./mcp-app-view.ts";

afterEach(() => {
  setMcpAppContext(null, null);
});

describe("mcp-app-view helpers", () => {
  it("includes safe host context for MCP Apps", () => {
    const context = buildMcpAppHostContext({
      width: 320,
      height: 600,
    });

    expect(context.toolInfo).toBeUndefined();
    expect(context.displayMode).toBe("inline");
    expect(context.availableDisplayModes).toEqual(["inline"]);
    expect(context.containerDimensions).toMatchObject({ width: 320, height: 600 });
    expect(context.locale).toBeTruthy();
    expect(context.timeZone).toBeTruthy();
  });

  it("never upgrades MCP Apps to trusted sandbox mode", () => {
    expect(resolveMcpAppSandboxMode("trusted")).toBe("scripts");
    expect(resolveMcpAppSandboxMode("scripts")).toBe("scripts");
    expect(resolveMcpAppSandboxMode("strict")).toBe("strict");
  });

  it("does not grant popup permissions to MCP App iframes", () => {
    expect(resolveMcpAppIframeSandbox("trusted")).toBe("allow-scripts allow-forms");
    expect(resolveMcpAppIframeSandbox("scripts")).toBe("allow-scripts allow-forms");
    expect(resolveMcpAppIframeSandbox("strict")).toBe("allow-forms");
  });

  it("keeps imperatively mounted iframes across Lit state updates", async () => {
    const element = new McpAppView();
    document.body.append(element);
    await element.updateComplete;

    const mount = element.shadowRoot?.querySelector(".mcp-app-frame-mount");
    expect(mount).not.toBeNull();
    const iframe = document.createElement("iframe");
    mount!.append(iframe);

    (element as unknown as { _viewInitialized: boolean })._viewInitialized = true;
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector(".mcp-app-frame-mount iframe")).toBe(iframe);
    element.remove();
  });

  it("closes the app bridge if the iframe navigates after initial load", () => {
    const element = new McpAppView();
    const iframe = document.createElement("iframe");
    const closeTransport = vi.fn();
    document.body.append(iframe);

    Object.assign(
      element as unknown as { _iframe: HTMLIFrameElement; _closeTransport: () => void },
      {
        _iframe: iframe,
        _closeTransport: closeTransport,
      },
    );

    (
      element as unknown as { _closeAfterNavigation: (iframe: HTMLIFrameElement) => void }
    )._closeAfterNavigation(iframe);

    expect(closeTransport).toHaveBeenCalledOnce();
    expect(iframe.isConnected).toBe(false);
    expect((element as unknown as { _iframe: HTMLIFrameElement | null })._iframe).toBeNull();
    expect((element as unknown as { _error: string | null })._error).toBe(
      "MCP app iframe navigated",
    );
  });

  it("uses the current gateway client when proxying app bridge requests", async () => {
    const firstRequest = vi.fn();
    const secondRequest = vi.fn().mockResolvedValue({ content: [] });
    const element = new McpAppView();
    element.mcpServerName = "weather";
    element.mcpAppToolName = "forecast";
    element.mcpUiResourceUri = "ui://weather/forecast";
    element.mcpViewUrl = "/__openclaw__/canvas/documents/cv_weather/index.html";

    setMcpAppContext(
      { request: firstRequest } as unknown as GatewayBrowserClient,
      "agent:test:first",
    );
    setMcpAppContext(
      { request: secondRequest } as unknown as GatewayBrowserClient,
      "agent:test:second",
    );

    await (
      element as unknown as {
        _requestMcpProxy: (method: string, params: Record<string, unknown>) => Promise<unknown>;
      }
    )._requestMcpProxy("mcp.callTool", {
      toolName: "refresh",
      arguments: { city: "Pittsburgh" },
    });

    expect(firstRequest).not.toHaveBeenCalled();
    expect(secondRequest).toHaveBeenCalledWith("mcp.callTool", {
      sessionKey: "agent:test:second",
      serverName: "weather",
      appToolName: "forecast",
      uiResourceUri: "ui://weather/forecast",
      viewUrl: "/__openclaw__/canvas/documents/cv_weather/index.html",
      toolName: "refresh",
      arguments: { city: "Pittsburgh" },
    });

    await (
      element as unknown as {
        _requestMcpProxy: (method: string, params: Record<string, unknown>) => Promise<unknown>;
      }
    )._requestMcpProxy("mcp.listTools", { cursor: "page-2" });

    expect(secondRequest).toHaveBeenLastCalledWith("mcp.listTools", {
      sessionKey: "agent:test:second",
      serverName: "weather",
      appToolName: "forecast",
      uiResourceUri: "ui://weather/forecast",
      viewUrl: "/__openclaw__/canvas/documents/cv_weather/index.html",
      cursor: "page-2",
    });
  });
});
