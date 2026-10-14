/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it("loads missing MCP fallback copy when validating a new server", async () => {
  const { manager } = await loadI18n({ common: { cancel: "Abbrechen" } });
  expect(manager.t("mcpServers.nameLabel")).toBe("mcpServers.nameLabel");
  await manager.setLocale("de");
  const { buildAddMcpServerPatch } = await import("../lib/config/mcp-servers.ts");
  expect(buildAddMcpServerPatch({ docs: {} }, "docs", {})).toEqual({
    error: "An MCP server named “docs” already exists.",
  });
  expect(manager.t("mcpPage.operatorCommands")).toBe("MCP operator commands");
  expect(manager.t("common.cancel")).toBe("Abbrechen");
});
