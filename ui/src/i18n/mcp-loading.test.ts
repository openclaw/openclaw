/* @vitest-environment jsdom */

import { render } from "lit";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  captureI18nStateForTesting,
  createI18nManagerForTesting,
} from "./lib/translate.test-support.ts";
import { en } from "./locales/en.ts";

vi.hoisted(() => vi.resetModules());

const startupServers = structuredClone(en.mcpServers);
const startupPage = structuredClone(en.mcpPage);
let loadedServers = startupServers;
let loadedPage = startupPage;
let restoreI18n: () => Promise<void>;

beforeEach(() => {
  restoreI18n = captureI18nStateForTesting();
});
afterEach(async () => {
  en.mcpServers = structuredClone(startupServers);
  en.mcpPage = structuredClone(startupPage);
  await restoreI18n();
});
afterAll(() => {
  // Keep cached MCP consumers usable by later shared-worker tests.
  en.mcpServers = loadedServers;
  en.mcpPage = loadedPage;
});

it.each(["form", "validation"] as const)(
  "loads missing MCP fallback copy at the %s consumer",
  async (surface) => {
    const manager = createI18nManagerForTesting(async () => ({ common: { cancel: "Abbrechen" } }));
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
    loadedServers = structuredClone(en.mcpServers);
    loadedPage = structuredClone(en.mcpPage);
    expect(manager.t("mcpPage.operatorCommands")).toBe("MCP operator commands");
    expect(manager.t("common.cancel")).toBe("Abbrechen");
  },
);
