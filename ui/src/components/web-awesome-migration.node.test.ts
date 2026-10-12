// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(import.meta.dirname, "..");

function productionTypeScriptFiles(dir = sourceRoot): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return productionTypeScriptFiles(filePath);
    }
    if (!/\.tsx?$/u.test(entry.name) || entry.name.includes(".test.")) {
      return [];
    }
    return [filePath];
  });
}

function matchingFiles(pattern: RegExp, owners: readonly string[] = []): string[] {
  const matches: string[] = [];
  for (const filePath of productionTypeScriptFiles()) {
    const relativePath = path.relative(sourceRoot, filePath);
    // A renderer change may move an owner from .ts to .tsx without changing
    // which shared primitive owns accessibility and keyboard policy.
    const ownerPath = relativePath.replace(/\.tsx$/u, ".ts");
    if (!owners.includes(ownerPath) && pattern.test(readFileSync(filePath, "utf8"))) {
      matches.push(ownerPath);
    }
  }
  return matches.toSorted();
}

describe("shared control ownership", () => {
  it("keeps dialogs, menus, and tabs on shared primitives", () => {
    expect(matchingFiles(/<dialog\b/u, ["components/modal-dialog.ts"])).toEqual([]);
    expect(
      matchingFiles(/<[a-z][^>]*\srole=["'](?:menu|menubar|menuitem|tab|tablist)["']/u, [
        "components/menu-surface.ts",
        "components/web-awesome.ts",
        "components/panel-tab-strip.ts",
        "components/hub-tabs.ts",
      ]),
    ).toEqual([]);
    expect(
      matchingFiles(/<details\b[^>]*class=["'][^"']*(?:menu|select|popover|dropdown)/u, [
        "pages/chat/components/chat-effort-picker.ts",
        "pages/chat/components/chat-model-picker.ts",
      ]),
    ).toEqual([]);
  });

  it("limits custom comboboxes to approved searchable controls", () => {
    // Searchable controls own their keyboard policy; page consumers reuse them.
    expect(matchingFiles(/<[a-z][^>]*\srole=["'](?:combobox|listbox|option)["']/u)).toEqual([
      "components/command-palette-view.ts",
      "components/multi-select.ts",
      "components/select-picker.ts",
      "components/session-group-defaults-dialog.ts",
      "pages/chat/components/chat-composer-menu.ts",
      "pages/chat/components/chat-model-account-control.ts",
      "pages/chat/components/chat-model-picker-options.ts",
      "pages/chat/components/chat-model-picker.ts",
      "pages/new-session/checkout-chip.ts",
      "pages/new-session/place-browser.ts",
    ]);
  });

  it("limits custom dividers to docked multi-pane layouts", () => {
    // These layouts coordinate sidebar, inspector, and responsive dock state
    // across more than two panes.
    expect(matchingFiles(/<resizable-divider\b/u)).toEqual([
      "app/app-shell-view.ts",
      "components/assistant-panel-view.ts",
      "components/dock-layout-controller.ts",
      "components/dock-layout-solid.ts",
      "pages/chat/chat-page-pane-render.ts",
      "pages/chat/components/chat-resizable-divider.ts",
    ]);
  });
});
