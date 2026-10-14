/* @vitest-environment jsdom */

import { render } from "lit";
import { expect, it } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it.each(["form", "validation"] as const)(
  "loads missing MCP fallback copy at the %s consumer",
  async (surface) => {
    const { manager } = await loadI18n({ common: { cancel: "Abbrechen" } });
    expect(manager.t("mcpServers.nameLabel")).toBe("mcpServers.nameLabel");
    await manager.setLocale("de");
    if (surface === "form") {
      const { renderMcpServerForm } = await import("../components/mcp-server-form.ts");
      const container = document.createElement("div");
      render(renderMcpServerForm({ busy: false, onSubmit() {}, onCancel() {} }), container);
      expect(container.textContent).toContain("Name");
      expect(container.textContent).toContain("URL or command");
      expect(container.textContent).toContain("Cancel");
    } else {
      const { buildAddMcpServerPatch } = await import("../lib/config/mcp-servers.ts");
      expect(buildAddMcpServerPatch({ docs: {} }, "docs", {})).toEqual({
        error: "An MCP server named “docs” already exists.",
      });
    }
    expect(manager.t("mcpPage.operatorCommands")).toBe("MCP operator commands");
    expect(manager.t("common.cancel")).toBe("Abbrechen");
  },
);
