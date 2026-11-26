/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it.each(["form", "validation"] as const)(
  "loads missing MCP fallback copy at the %s consumer",
  async (surface) => {
    const { en, manager } = await loadI18n({
      common: { cancel: "Abbrechen" },
      mcpServers: { nameLabel: "Bezeichnung" },
    });
    const servers = en.mcpServers;
    const page = en.mcpPage;
    expect(manager.t("mcpServers.nameLabel")).toBe("mcpServers.nameLabel");
    await manager.setLocale("de");
    if (surface === "form") {
      const { createComponent, flush } = await import("solid-js");
      const { mountSolid } = await import("../test-helpers/mount-solid.ts");
      const { McpServersForm } = await import("../components/mcp-servers-form.tsx");
      const { container, unmount } = mountSolid(() =>
        createComponent(McpServersForm, {
          busy: false,
          disabled: false,
          blockedReason: null,
          onSubmit() {},
          onCancel() {},
        }),
      );
      try {
        flush();
        expect(container.textContent).toContain("Name");
        expect(container.textContent).toContain("URL or command");
        expect(container.textContent).toContain("Cancel");
      } finally {
        unmount();
      }
    } else {
      const { buildAddMcpServerPatch } = await import("../lib/config/mcp-servers.ts");
      expect(buildAddMcpServerPatch({ docs: {} }, "docs", {})).toEqual({
        error: "An MCP server named “docs” already exists.",
      });
      expect(manager.t("mcpServers.removeConfirmTitle")).toBe("mcpServers.removeConfirmTitle");
      expect(manager.t("mcpServers.targetLabel")).toBe("mcpServers.targetLabel");
      expect(manager.t("mcpPage.runtimeHint")).toBe("mcpPage.runtimeHint");
    }
    expect(manager.t("mcpPage.settings")).toBe("Settings");
    expect(manager.t("mcpPage.apps")).toBe("MCP Apps");
    expect(manager.t("mcpPage.operatorCommands")).toBe("Command line");
    expect(manager.t("common.cancel")).toBe("Abbrechen");

    const { registerMcpManagementEnglish } = await import("./locales/en-mcp-management.ts");
    registerMcpManagementEnglish();
    const { registerMcpEnglish } = await import("./locales/en-mcp.ts");
    registerMcpEnglish();
    expect(en.mcpServers).toBe(servers);
    expect(en.mcpPage).toBe(page);
    expect(manager.t("mcpServers.nameLabel")).toBe("Bezeichnung");
    expect(manager.t("mcpServers.targetLabel")).toBe("URL or command");
    expect(manager.t("mcpServers.removeConfirmTitle", { name: "docs" })).toBe("Remove docs?");
    expect(manager.t("mcpPage.runtimeHint")).toBe(
      "With automatic reload enabled, connections rebuild on next use.",
    );
    expect(manager.t("common.cancel")).toBe("Abbrechen");
    expect(manager.getLocale()).toBe("de");
  },
);
