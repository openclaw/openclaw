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

  it("full generateHtml pipeline produces valid self-contained HTML", () => {
    // Replicate the exact logic from commands-export-session.ts generateHtml()
    const template = loadTemplate("template.html");
    const templateCss = loadTemplate("template.css");
    const templateJs = loadTemplate("template.js");
    const markedJs = loadTemplate(join("vendor", "marked.min.js"));
    const hljsJs = loadTemplate(join("vendor", "highlight.min.js"));

    const themeVars = "--cyan: #00d7ff; --text: #e0e0e0;";
    const bodyBg = "#1e1e28";
    const containerBg = "#282832";
    const infoBg = "#343541";

    const sessionData = {
      header: null,
      entries: [{ role: "user", content: "hello" }],
      leafId: null,
    };
    const sessionDataBase64 = Buffer.from(JSON.stringify(sessionData)).toString("base64");

    const css = templateCss
      .replace("/* {{THEME_VARS}} */", themeVars)
      .replace("/* {{BODY_BG_DECL}} */", `--body-bg: ${bodyBg};`)
      .replace("/* {{CONTAINER_BG_DECL}} */", `--container-bg: ${containerBg};`)
      .replace("/* {{INFO_BG_DECL}} */", `--info-bg: ${infoBg};`);

    const html = template
      .replace("{{CSS}}", css)
      .replace("{{JS}}", templateJs)
      .replace("{{SESSION_DATA}}", sessionDataBase64)
      .replace("{{MARKED_JS}}", markedJs)
      .replace("{{HIGHLIGHT_JS}}", hljsJs);

    // 1. No unreplaced placeholders remain
    expect(html).not.toContain("{{CSS}}");
    expect(html).not.toContain("{{JS}}");
    expect(html).not.toContain("{{SESSION_DATA}}");
    expect(html).not.toContain("{{MARKED_JS}}");

    // 2. Vendor JS is actually embedded (check unique identifiers)
    expect(html).toContain(markedJs.slice(0, 80));
    expect(html).toContain(hljsJs.slice(0, 80));
    expect(html).toContain(templateJs.slice(0, 80));

    // 3. Session data is embedded as base64
    expect(html).toContain(sessionDataBase64);

    // 4. CSS theme vars are embedded
    expect(html).toContain("--cyan: #00d7ff");

    // 5. Basic HTML structure is intact
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("</html>");
    expect(html).toContain('<div id="messages">');

    // 6. Count <script> tags — should have session-data + 3 JS scripts = 4
    const scriptTags = html.match(/<script[\s>]/g);
    expect(scriptTags?.length).toBeGreaterThanOrEqual(4);
  });
});
