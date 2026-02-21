import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const EXPORT_HTML_DIR = join(dirname(fileURLToPath(import.meta.url)), "export-html");

function loadTemplate(fileName: string): string {
  return readFileSync(join(EXPORT_HTML_DIR, fileName), "utf-8");
}

describe("export-session HTML template (#22595)", () => {
  it("template.html contains single-line {{MARKED_JS}}, {{HIGHLIGHT_JS}}, and {{JS}} placeholders", () => {
    const template = loadTemplate("template.html");

    expect(template).toContain("{{MARKED_JS}}");
    expect(template).toContain("{{HIGHLIGHT_JS}}");
    expect(template).toContain("{{JS}}");
  });

  it("vendor JS is embedded after placeholder replacement", () => {
    const template = loadTemplate("template.html");
    const markedJs = loadTemplate(join("vendor", "marked.min.js"));
    const hljsJs = loadTemplate(join("vendor", "highlight.min.js"));
    const templateJs = loadTemplate("template.js");

    const result = template
      .replace("{{JS}}", templateJs)
      .replace("{{MARKED_JS}}", markedJs)
      .replace("{{HIGHLIGHT_JS}}", hljsJs);

    expect(result).toContain(markedJs.slice(0, 80));
    expect(result).toContain(hljsJs.slice(0, 80));
    expect(result).toContain(templateJs.slice(0, 80));
    expect(result).not.toContain("{{MARKED_JS}}");
    expect(result).not.toContain("{{JS}}");
  });
});
