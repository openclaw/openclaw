import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { t } from "../i18n/index.ts";
import {
  buildMcpAppHostCapabilities,
  dispatchWidgetPrompt,
  negotiateMcpAppDisplayModes,
  WIDGET_PROMPT_EVENT,
} from "./mcp-app-security.ts";
import { resolveSandboxHostUrl } from "./sandbox-host.ts";

describe("MCP App sandbox security", () => {
  it("negotiates resource hints before initialization and App capabilities afterward", () => {
    const both = ["inline", "fullscreen"] as const;
    const fullscreen = { available: ["fullscreen"], initial: "fullscreen" };
    expect(negotiateMcpAppDisplayModes(undefined)).toEqual({ available: both, initial: "inline" });
    expect(negotiateMcpAppDisplayModes({ preferredDisplayMode: "fullscreen" })).toEqual(fullscreen);
    expect(
      negotiateMcpAppDisplayModes({
        availableDisplayModes: [...both],
        preferredDisplayMode: "fullscreen",
      }),
    ).toEqual({ available: both, initial: "fullscreen" });
    expect(negotiateMcpAppDisplayModes(undefined, ["fullscreen"])).toEqual(fullscreen);
    expect(() => negotiateMcpAppDisplayModes(undefined, ["pip"])).toThrow(
      "no available host display mode",
    );
  });
  it("advertises the CSP applied to MCP Apps", () => {
    expect(
      buildMcpAppHostCapabilities({ connectDomains: ["https://api.example.com"] }),
    ).toMatchObject({ sandbox: { csp: { connectDomains: ["https://api.example.com"] } } });
    expect(buildMcpAppHostCapabilities()).toMatchObject({ sandbox: { csp: {} } });
  });

  it("advertises update-model-context text support only when the handler path exists", () => {
    expect(buildMcpAppHostCapabilities(undefined, true, true)).toMatchObject({
      message: { text: {} },
      serverResources: {},
      updateModelContext: { text: {} },
    });
    const readOnly = buildMcpAppHostCapabilities(undefined, false, false);
    expect(readOnly).not.toHaveProperty("serverResources");
    expect(buildMcpAppHostCapabilities(undefined, true, false)).not.toHaveProperty(
      "updateModelContext",
    );
  });

  it("accepts only the dedicated-origin sandbox endpoint", () => {
    const gatewayUrl = "wss://gateway.example:8443/openclaw";
    const hostOrigin = "https://gateway.example:8443";
    const invalidMessage = t("mcpApp.errors.invalidSandboxUrl");
    const resolve = (
      value = "/mcp-app-sandbox",
      port = 8444,
      origin?: string,
      gateway = gatewayUrl,
      host = hostOrigin,
    ) => resolveSandboxHostUrl(value, port, origin, gateway, host, invalidMessage);
    expect(resolve("/mcp-app-sandbox?csp=abc")).toBe(
      "https://gateway.example:8444/mcp-app-sandbox?csp=abc",
    );
    expect(
      resolve(
        "/mcp-app-sandbox",
        18790,
        "https://apps.example.com",
        "wss://gateway.example",
        "https://gateway.example",
      ),
    ).toBe("https://apps.example.com/mcp-app-sandbox");
    const invalid: Parameters<typeof resolve>[] = [
      ["https://attacker.example/mcp-app-sandbox"],
      ["data:text/html;base64,cHJveHk="],
      ["/mcp-app-sandbox", 8443],
      ["/mcp-app-sandbox", 8444, hostOrigin, gatewayUrl, "https://control.example"],
    ];
    for (const args of invalid) {
      expect(() => resolve(...args)).toThrow("MCP App sandbox URL is invalid");
    }
  });

  it("keeps the per-view prompt budget across iframe remounts", async () => {
    const mountFrame = () => {
      const frame = document.body.appendChild(document.createElement("iframe"));
      frame.checkVisibility = () => true;
      Object.defineProperty(document, "activeElement", { get: () => frame, configurable: true });
      return frame;
    };
    const key = `agent:main:main\0view-${crypto.randomUUID()}`;
    const first = mountFrame();
    for (let index = 0; index < 10; index += 1) {
      expect(await dispatchWidgetPrompt(first, `Prompt ${index}`, key)).toBe(true);
    }

    first.remove();
    const replacement = mountFrame();
    expect(await dispatchWidgetPrompt(replacement, "Prompt after remount", key)).toBe(false);
    replacement.remove();
    delete (document as unknown as Record<string, unknown>).activeElement;
  });

  it("waits for widget confirmation and rejects a frame retired while it was pending", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    frame.checkVisibility = () => true;
    frame.focus();
    const received = vi.fn();
    frame.addEventListener(WIDGET_PROMPT_EVENT, received);
    const decision = createDeferred<boolean>();
    try {
      const pending = dispatchWidgetPrompt(
        frame,
        "Compare parts",
        crypto.randomUUID(),
        () => decision.promise,
      );
      expect(received).not.toHaveBeenCalled();
      frame.remove();
      decision.resolve(true);
      expect(await pending).toBe(false);
      expect(received).not.toHaveBeenCalled();
    } finally {
      decision.resolve(false);
      frame.remove();
    }
  });
});
