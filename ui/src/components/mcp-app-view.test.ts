import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import {
  buildMcpAppHostCapabilities,
  McpAppView,
  resolveMcpAppSandboxUrl,
} from "./mcp-app-view.ts";

const MCP_APP_VIEW_ELEMENT_NAME = `test-mcp-app-view-${crypto.randomUUID()}`;

// Keep the mounted view and i18n controller in the current module graph when
// the non-isolated runner has retained an earlier production registration.
class TestMcpAppView extends McpAppView {}

customElements.define(MCP_APP_VIEW_ELEMENT_NAME, TestMcpAppView);

describe("mcp-app-view security contract", () => {
  it("advertises the CSP actually applied to MCP Apps", () => {
    expect(
      buildMcpAppHostCapabilities({ connectDomains: ["https://api.example.com"] }),
    ).toMatchObject({
      sandbox: { csp: { connectDomains: ["https://api.example.com"] } },
    });
    expect(buildMcpAppHostCapabilities()).toMatchObject({ sandbox: { csp: {} } });
  });

  it("accepts only the dedicated-origin MCP App sandbox endpoint", () => {
    expect(
      resolveMcpAppSandboxUrl(
        "/mcp-app-sandbox?csp=abc",
        8444,
        undefined,
        "wss://gateway.example:8443/openclaw",
        "https://gateway.example:8443",
      ),
    ).toBe("https://gateway.example:8444/mcp-app-sandbox?csp=abc");
    expect(
      resolveMcpAppSandboxUrl(
        "/mcp-app-sandbox",
        18790,
        "https://apps.example.com",
        "wss://gateway.example",
        "https://gateway.example",
      ),
    ).toBe("https://apps.example.com/mcp-app-sandbox");
    expect(() =>
      resolveMcpAppSandboxUrl(
        "https://attacker.example/mcp-app-sandbox",
        8444,
        undefined,
        "wss://gateway.example:8443/openclaw",
        "https://gateway.example:8443",
      ),
    ).toThrow("MCP App sandbox URL is invalid");
    expect(() =>
      resolveMcpAppSandboxUrl(
        "data:text/html;base64,cHJveHk=",
        8444,
        undefined,
        "wss://gateway.example:8443/openclaw",
        "https://gateway.example:8443",
      ),
    ).toThrow("MCP App sandbox URL is invalid");
    expect(() =>
      resolveMcpAppSandboxUrl(
        "/mcp-app-sandbox",
        8443,
        undefined,
        "wss://gateway.example:8443/openclaw",
        "https://gateway.example:8443",
      ),
    ).toThrow("MCP App sandbox URL is invalid");
    expect(() =>
      resolveMcpAppSandboxUrl(
        "/mcp-app-sandbox",
        8444,
        "https://gateway.example:8443",
        "wss://gateway.example:8443/openclaw",
        "https://control.example",
      ),
    ).toThrow("MCP App sandbox URL is invalid");
  });
});

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
});
