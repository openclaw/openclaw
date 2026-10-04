import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { auditIconButtons } from "../../scripts/audit-control-ui-icon-buttons.mts";
import {
  collectIconFixtures,
  type IconFixture,
} from "../../scripts/lib/control-ui-icon-fixtures.mts";
import { scanIconGridFit } from "../../scripts/lib/control-ui-icon-grid-fit.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function collect(source: string, file: string, document: Document): IconFixture[] {
  return collectIconFixtures(parser.parseSourceFile(file, source), file, document);
}
const base = "* { box-sizing: border-box; }";
const fixture: IconFixture = {
  file: "ui/src/control.ts",
  line: 1,
  html: '<header class="toolbar"><button class="icon" data-icon-grid-control><svg></svg></button></header>',
};
const original = `
  .icon { display:inline-grid; place-items:center; width:32px; height:32px; padding:6px; border:1px solid var(--border); }
  .icon svg { width:17px; height:17px; }
  .toolbar > button { width:26px; height:26px; }
`;

function scan(css: string) {
  return scanIconGridFit(css, [fixture], base);
}

const cramped =
  'html`<header class="toolbar"><button class="icon">${icons.refresh}</button></header>`';

function createAuditFixture(sheets: Record<string, string> = {}, markup = cramped) {
  const root = tempDirs.make("openclaw-icon-grid-");
  const styles = path.join(root, "ui/src/styles");
  const source = path.join(root, "ui/src/control.ts");
  fs.mkdirSync(styles, { recursive: true });
  for (const [name, css] of Object.entries({
    "base.css": base,
    "components.css": "",
    "control.css": original,
    ...sheets,
  })) {
    fs.writeFileSync(path.join(styles, name), css);
  }
  fs.writeFileSync(source, markup);
  return { root, styles, source };
}

describe("fixed icon-grid fit", () => {
  it("catches the shipped size override rather than flagging the safe base control", () => {
    const findings = scan(original).findings;
    expect(findings).toHaveLength(2);
    for (const axis of ["width", "height"]) {
      expect(findings).toContainEqual(
        expect.objectContaining({
          kind: "overflow",
          axis,
          size: 26,
          padding: 12,
          border: 2,
          icon: 17,
          available: 12,
        }),
      );
    }
    expect(scan(original + ".toolbar > button {padding:0}").findings).toEqual([]);
    expect(scan(original.replace("width:26px; height:26px;", "")).findings).toEqual([]);
  });

  it("requires authored padding instead of trusting jsdom's zero native default", () => {
    const css = original.replace("padding:6px;", "");
    expect(scan(css).findings).toEqual(
      ["width", "height"].map((axis) =>
        expect.objectContaining({ kind: "native-padding", axis, padding: null, available: null }),
      ),
    );
    expect(scan(css + ".icon {padding:0}").findings).toEqual([]);
  });

  it("excludes controls without the implicit-grid defect", () => {
    for (const css of [
      original.replace("inline-grid", "inline-flex"),
      ...[
        ".icon {box-sizing:content-box}",
        ".icon {min-width:32px;min-height:32px;max-width:20px;max-height:20px}",
        ".icon {justify-content:center;align-content:center}",
        ".icon {grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}",
        ".icon svg {max-width:8px;max-height:8px}",
      ].map((correction) => original + correction),
    ]) {
      expect(scan(css).findings, css).toEqual([]);
    }
  });

  it("defers unresolved geometry instead of inventing a fit", () => {
    const dom = new JSDOM();
    try {
      const defer = (css: string, fixtures = [fixture]) => {
        const result = scanIconGridFit(css, fixtures, base);
        expect(result.findings, css).toEqual([]);
        expect(result.unresolved, css).toBeGreaterThan(0);
        return result;
      };
      for (const correction of [
        ".icon {width:2em;font-size:20px}",
        ".icon {inline-size:40px}",
        ".icon {border-inline-width:2px}",
        ".icon {all:unset}",
        ".toolbar .icon {width:40px!important}.icon {width:24px!important}",
        "@media all {.icon {padding:0}}",
        ".icon {&:hover {padding:0}}",
        ...[
          "display:none",
          "position:absolute",
          "transform:translateX(-2px)",
          "justify-self:start",
        ].map((declaration) => ".icon svg {" + declaration + "}"),
      ]) {
        defer(original + correction);
      }
      defer(original.replace("padding:6px;", "padding:var(--control-padding);"));
      expect(
        defer(original + ".toolbar > button {padding:0}.toolbar > button:hover {padding:8px}")
          .checked,
      ).toBe(0);
      defer(original, [
        {
          ...fixture,
          html: fixture.html.replace('class="icon"', 'class="icon" style="padding:0"'),
        },
      ]);
      defer(
        original + '.icon:not([aria-pressed="true"]) {padding:8px}',
        collect(
          'html`<button class="icon" aria-pressed=${pressed}>${icons.refresh}</button>`',
          "ui/src/state.ts",
          dom.window.document,
        ),
      );
    } finally {
      dom.window.close();
    }
  });

  it("defers cross-sheet ancestor, tag, ID, attribute, and SVG overrides", () => {
    const { root, styles } = createAuditFixture(
      {},
      'html`<header class="toolbar"><button class="icon" id="action" title="Preview">${icons.refresh}</button></header>`',
    );
    for (const correction of [
      ".toolbar > button {padding:0}",
      "button {padding:0!important}",
      "#action {padding:0}",
      'button[title="Preview"] {padding:0}',
      "svg {max-width:8px;max-height:8px}",
    ]) {
      fs.writeFileSync(path.join(styles, "other.css"), correction);
      const result = auditIconButtons(root, ["ui/src/styles/control.css"]);
      expect(result.findings).toHaveLength(0);
      expect(result.unresolvedAxes).toBeGreaterThan(0);
    }
  });

  it("collects only static icon witnesses and preserves their native AST locations", () => {
    const dom = new JSDOM();
    try {
      const source = [
        "class Control extends OpenClawLightDomElement {",
        "  render() {",
        '    return html`<button class="icon">${(busy ? icons.loader : icons.refresh)}</button>`;',
        "  }",
        "}",
      ].join("\n");
      const cases: [string, string, number | null, number][] = [
        ["control", source, 3, 0],
        ["shadow", source.replace("OpenClawLightDomElement", "LitElement"), null, 0],
        ["custom-root", source.replace("render()", "createRenderRoot()"), null, 0],
        ["extra", 'html`<button class="icon"><span></span>${icons.refresh}</button>`', null, 0],
        [
          "literal",
          'html`<header class="toolbar"><button class="icon">${busy ? icons.loader : icons.refresh}</button><button class="icon">Save ${icons.check}</button><button class="icon ${variant}">${icons.x}</button></header>`',
          1,
          2,
        ],
      ];
      for (const [name, markup, line, findings] of cases) {
        const file = `ui/src/${name}.ts`;
        const fixtures = collect(markup, file, dom.window.document);
        expect(fixtures, name).toEqual(
          line === null ? [] : [expect.objectContaining({ file, line })],
        );
        if (line !== null) {
          expect(fixtures, name).toHaveLength(1);
          const template = dom.window.document.createElement("template");
          template.innerHTML = fixtures[0]!.html;
          expect(template.content.querySelectorAll("[data-icon-grid-control]"), name).toHaveLength(
            1,
          );
          expect(scanIconGridFit(original, fixtures, base).findings, name).toHaveLength(findings);
        }
      }
    } finally {
      dom.window.close();
    }
  });

  it("audits current source and shared styles on each manual invocation", () => {
    const { root, styles, source } = createAuditFixture();
    const audit = () => auditIconButtons(root, ["ui/src/styles/control.css"]);
    const first = audit();
    expect(first.findings).toHaveLength(2);
    expect(first.findings[0]?.available).toBe(12);
    fs.writeFileSync(source, 'html`<button class="icon">${icons.refresh}</button>`');
    expect(audit().findings).toHaveLength(0);
    const added = path.join(root, "ui/src/added.ts");
    fs.writeFileSync(added, cramped);
    expect(audit().findings).toHaveLength(2);
    fs.unlinkSync(added);
    expect(audit().findings).toHaveLength(0);
    fs.writeFileSync(source, cramped);
    expect(audit().findings).toHaveLength(2);
    const sibling = path.join(styles, "other.css");
    fs.writeFileSync(sibling, ".shell .icon {padding:0}");
    expect(audit().findings).toHaveLength(0);
    fs.unlinkSync(sibling);
    expect(audit().findings).toHaveLength(2);
    fs.writeFileSync(
      path.join(styles, "base.css"),
      base + ".icon {min-width:32px;min-height:32px}",
    );
    expect(audit().findings).toHaveLength(0);
  });

  it("does not append the base sheet again after component overrides", () => {
    const { root } = createAuditFixture({
      "base.css": base + original,
      "components.css": ".toolbar > button {width:32px;height:32px}",
      "control.css": "",
    });
    const result = auditIconButtons(root, ["ui/src/styles/base.css"]);
    expect(result.findings).toHaveLength(0);
    expect(result.checkedAxes).toBe(2);
  });
});
