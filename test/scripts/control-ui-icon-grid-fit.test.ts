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

describe("fixed icon-grid fit", () => {
  it("catches the shipped size override rather than flagging the safe base control", () => {
    const findings = scan(original).findings;
    expect(findings).toHaveLength(2);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "overflow",
          axis: "width",
          size: 26,
          padding: 12,
          border: 2,
          icon: 17,
          available: 12,
        }),
        expect.objectContaining({
          kind: "overflow",
          axis: "height",
          size: 26,
          padding: 12,
          border: 2,
          icon: 17,
          available: 12,
        }),
      ]),
    );
    expect(scan(original + ".toolbar > button {padding:0}").findings).toEqual([]);
    expect(scan(original.replace("width:26px; height:26px;", "")).findings).toEqual([]);
  });

  it("requires authored padding instead of trusting jsdom's zero native default", () => {
    const css = original.replace("padding:6px;", "");
    expect(scan(css).findings).toEqual([
      expect.objectContaining({
        kind: "native-padding",
        axis: "width",
        padding: null,
        available: null,
      }),
      expect.objectContaining({
        kind: "native-padding",
        axis: "height",
        padding: null,
        available: null,
      }),
    ]);
    expect(scan(css + ".icon {padding:0}").findings).toEqual([]);
  });

  it.each([
    ["flex centering", original.replace("inline-grid", "inline-flex")],
    ["content-box sizing", original + ".icon {box-sizing:content-box}"],
    [
      "minimum sizes",
      original + ".icon {min-width:32px;min-height:32px;max-width:20px;max-height:20px}",
    ],
    ["centered tracks", original + ".icon {justify-content:center;align-content:center}"],
    [
      "bounded tracks",
      original + ".icon {grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}",
    ],
  ])("does not treat %s as the implicit-grid defect", (_label, css) => {
    expect(scan(css).findings).toEqual([]);
  });

  it("does not treat unresolved padding as a known zero", () => {
    const result = scan(original.replace("padding:6px;", "padding:var(--control-padding);"));
    expect(result.findings).toEqual([]);
    expect(result.unresolved).toBeGreaterThan(0);
  });

  it.each([
    ["font-relative dimensions", ".icon {width:2em;font-size:20px}"],
    ["logical dimensions", ".icon {inline-size:40px}"],
    ["logical borders", ".icon {border-inline-width:2px}"],
    ["all reset", ".icon {all:unset}"],
    [
      "competing important widths",
      ".toolbar .icon {width:40px!important}.icon {width:24px!important}",
    ],
    ["always-applicable media correction", "@media all {.icon {padding:0}}"],
    ["supports correction", "@supports (display:grid) {.icon {padding:0}}"],
    ["nested-only padding", ".icon {&:hover {padding:0}}"],
  ])("defers %s rather than inventing a resolved geometry", (_name, correction) => {
    const result = scan(original + correction);
    expect(result.findings).toEqual([]);
    expect(result.unresolved).toBeGreaterThan(0);
  });

  it.each(["hover", "focus-visible", "active"])("defers top-level %s geometry", (state) => {
    const result = scan(
      original + ".toolbar > button {padding:0}.toolbar > button:" + state + " {padding:8px}",
    );
    expect(result.findings).toHaveLength(0);
    expect(result.checked).toBe(0);
    expect(result.unresolved).toBeGreaterThan(0);
  });

  it("defers cross-sheet ancestor, tag, ID, attribute, and SVG overrides", () => {
    const root = tempDirs.make("openclaw-icon-grid-cross-sheet-");
    const styles = path.join(root, "ui/src/styles");
    fs.mkdirSync(styles, { recursive: true });
    fs.writeFileSync(path.join(styles, "base.css"), base);
    fs.writeFileSync(path.join(styles, "components.css"), "");
    fs.writeFileSync(path.join(styles, "control.css"), original);
    fs.writeFileSync(
      path.join(root, "ui/src/control.ts"),
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

  it("respects fixed SVG max bounds and excludes nonparticipating or offset SVGs", () => {
    expect(scan(original + ".icon svg {max-width:8px;max-height:8px}").findings).toEqual([]);
    for (const declaration of [
      "display:none",
      "position:absolute",
      "transform:translateX(-2px)",
      "justify-self:start",
    ]) {
      const result = scan(original + ".icon svg {" + declaration + "}");
      expect(result.findings).toEqual([]);
      expect(result.unresolved).toBeGreaterThan(0);
    }
  });

  it("does not misclassify an inline padding reset as native padding", () => {
    const inline = {
      ...fixture,
      html: fixture.html.replace('class="icon"', 'class="icon" style="padding:0"'),
    };
    const result = scanIconGridFit(original, [inline], base);
    expect(result.findings).toEqual([]);
    expect(result.unresolved).toBeGreaterThan(0);
  });

  it("excludes empty extra grid items and unresolved selector-state bindings", () => {
    const dom = new JSDOM();
    try {
      const extra = 'html`<button class="icon"><span></span>${icons.refresh}</button>`';
      expect(collect(extra, "ui/src/extra.ts", dom.window.document)).toEqual([]);
      const source = 'html`<button class="icon" aria-pressed=${pressed}>${icons.refresh}</button>`';
      const fixtures = collect(source, "ui/src/state.ts", dom.window.document);
      const result = scanIconGridFit(
        original + '.icon:not([aria-pressed="true"]) {padding:8px}',
        fixtures,
        base,
      );
      expect(result.findings).toEqual([]);
      expect(result.unresolved).toBeGreaterThan(0);
    } finally {
      dom.window.close();
    }
  });

  it("collects literal ancestry and conditional icons, not dynamic class or text guesses", () => {
    const dom = new JSDOM();
    try {
      const source =
        'html`<header class="toolbar"><button class="icon">${busy ? icons.loader : icons.refresh}</button><button class="icon">Save ${icons.check}</button><button class="icon ${variant}">${icons.x}</button></header>`';
      const fixtures = collect(source, "ui/src/control.ts", dom.window.document);
      expect(fixtures).toHaveLength(1);
      const template = dom.window.document.createElement("template");
      template.innerHTML = fixtures[0]!.html;
      expect(template.content.querySelectorAll("[data-icon-grid-control]")).toHaveLength(1);
      expect(scanIconGridFit(original, fixtures, base).findings).toHaveLength(2);
    } finally {
      dom.window.close();
    }
  });

  it("preserves template locations and excludes custom render roots with the native AST", () => {
    const dom = new JSDOM();
    try {
      const source = [
        "class Control extends OpenClawLightDomElement {",
        "  render() {",
        '    return html`<button class="icon">${(busy ? icons.loader : icons.refresh)}</button>`;',
        "  }",
        "}",
      ].join("\n");
      expect(collect(source, "ui/src/control.ts", dom.window.document)).toEqual([
        expect.objectContaining({ file: "ui/src/control.ts", line: 3 }),
      ]);
      expect(
        collect(
          source.replace("OpenClawLightDomElement", "LitElement"),
          "ui/src/shadow.ts",
          dom.window.document,
        ),
      ).toEqual([]);
      expect(
        collect(
          source.replace("render()", "createRenderRoot()"),
          "ui/src/custom-root.ts",
          dom.window.document,
        ),
      ).toEqual([]);
    } finally {
      dom.window.close();
    }
  });

  it("audits current source and shared styles on each manual invocation", () => {
    const root = tempDirs.make("openclaw-icon-grid-");
    const styles = path.join(root, "ui/src/styles");
    fs.mkdirSync(styles, { recursive: true });
    fs.writeFileSync(path.join(styles, "base.css"), base);
    fs.writeFileSync(path.join(styles, "components.css"), "");
    const source = path.join(root, "ui/src/control.ts");
    fs.writeFileSync(
      source,
      'html`<header class="toolbar"><button class="icon">${icons.refresh}</button></header>`',
    );
    fs.writeFileSync(path.join(styles, "control.css"), original);
    const audit = () => auditIconButtons(root, ["ui/src/styles/control.css"]);
    const first = audit();
    expect(first.findings).toHaveLength(2);
    expect(first.findings[0]?.available).toBe(12);
    fs.writeFileSync(source, 'html`<button class="icon">${icons.refresh}</button>`');
    expect(audit().findings).toHaveLength(0);
    const added = path.join(root, "ui/src/added.ts");
    const cramped =
      'html`<header class="toolbar"><button class="icon">${icons.refresh}</button></header>`';
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
    const root = tempDirs.make("openclaw-icon-grid-order-");
    const styles = path.join(root, "ui/src/styles");
    fs.mkdirSync(styles, { recursive: true });
    fs.writeFileSync(path.join(styles, "base.css"), base + original);
    fs.writeFileSync(
      path.join(styles, "components.css"),
      ".toolbar > button {width:32px;height:32px}",
    );
    fs.writeFileSync(
      path.join(root, "ui/src/control.ts"),
      'html`<header class="toolbar"><button class="icon">${icons.refresh}</button></header>`',
    );
    const result = auditIconButtons(root, ["ui/src/styles/base.css"]);
    expect(result.findings).toHaveLength(0);
    expect(result.checkedAxes).toBe(2);
  });
});
