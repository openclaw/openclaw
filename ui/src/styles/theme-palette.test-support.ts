import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";

// Include lazy palettes and merge repeated :root blocks without erasing tokens.
export function readThemeBlocks(stylesDir: string): Map<string, Map<string, string>> {
  const themesDir = path.join(stylesDir, "..", "..", "public", "themes");
  const files = [
    path.join(stylesDir, "base.css"),
    ...fs
      .readdirSync(themesDir)
      .filter((name) => name.endsWith(".css"))
      .toSorted()
      .map((name) => path.join(themesDir, name)),
  ];
  const blocks = new Map<string, Map<string, string>>();
  postcss.parse(files.map((file) => fs.readFileSync(file, "utf8")).join("\n")).walkRules((rule) => {
    const selector = rule.selector;
    if (
      !/^:root(?::where\(\[data-theme-mode="light"\]\)|\[data-theme(?:-mode)?="[^"]+"\])?$/u.test(
        selector,
      )
    ) {
      return;
    }
    const tokens = blocks.get(selector) ?? new Map<string, string>();
    for (const node of rule.nodes) {
      if (node.type === "decl" && node.prop.startsWith("--")) {
        tokens.set(node.prop, node.value.trim());
      }
    }
    blocks.set(selector, tokens);
  });
  return blocks;
}
