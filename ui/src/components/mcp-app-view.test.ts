import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import "./mcp-app-view.ts";

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

    const view = document.createElement("mcp-app-view");
    view.sessionKey = "agent:main:main";
    view.viewId = "view-1";
    document.body.append(view);

    await expect
      .poll(() => view.shadowRoot?.querySelector(".error")?.textContent)
      .toBe("Aplicativo MCP indisponível: MCP App gateway unavailable");
  });
});
