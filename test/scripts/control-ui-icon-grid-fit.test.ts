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

describe("JSX icon-grid fixtures", () => {
  const imports =
    'import { Show, For, Show as If } from "solid-js"; import * as Solid from "solid-js";';
  const css = original.replaceAll(".toolbar > button", ".toolbar > .icon");

  function collectJsx(markup: string, document: Document) {
    return collect(`${imports}\nconst View = () => ${markup};`, "ui/src/control.tsx", document);
  }

  it("does not treat type-only imports as Solid renderers", () => {
    const dom = new JSDOM();
    try {
      for (const source of [
        'import type { Show } from "solid-js"; const View = () => <Show when={true}><button><svg /></button></Show>;',
        'import type * as Solid from "solid-js"; const View = () => <Solid.Show when={true}><button><svg /></button></Solid.Show>;',
        'import { type Show } from "solid-js"; const View = () => <Show when={true}><button><svg /></button></Show>;',
      ]) {
        expect(collect(source, "ui/src/control.tsx", dom.window.document)).toEqual([]);
      }
    } finally {
      dom.window.close();
    }
  });

  it("ignores unnamed array-binding slots when checking component shadowing", () => {
    const dom = new JSDOM();
    try {
      for (const source of [
        "const [, value] = items; const View = () => <button><svg /></button>;",
        "const { x: [, value] } = items; const View = () => <button><svg /></button>;",
        "function View([, value]) { return <button><svg /></button>; }",
      ]) {
        expect(collect(source, "ui/src/control.tsx", dom.window.document)).toHaveLength(1);
      }
    } finally {
      dom.window.close();
    }
  });

  it("preserves literal ancestors through JSX branches, Show, and For", () => {
    const dom = new JSDOM();
    try {
      const cases: [string, number][] = [
        ['<button class="icon">{icons.refresh}</button>', 1],
        ['<a class="icon"><svg /></a>', 1],
        ['<div class="icon" role="button">{icons.refresh}</div>', 1],
        ['<button class={["icon", { compact: true }]}><svg /></button>', 1],
        ['<Show when={ok}><button class="icon">{icons.refresh}</button></Show>', 1],
        ['<Show when={false}><button class="icon"><svg /></button></Show>', 0],
        ['<Show when="" fallback={<span />}><button class="icon"><svg /></button></Show>', 0],
        [
          '<Show when="ready" fallback={<a class="icon"><svg /></a>}><button class="icon"><svg /></button></Show>',
          1,
        ],
        [
          '<Show when fallback={<a class="icon"><svg /></a>}><button class="icon"><svg /></button></Show>',
          1,
        ],
        [
          '<Show when={true} fallback={<a class="icon"><svg /></a>}><button class="icon"><svg /></button></Show>',
          1,
        ],
        [
          '<Show when={false} fallback={<a class="icon"><svg /></a>}><button class="icon"><svg /></button></Show>',
          1,
        ],
        ['<Show when={selected}>{item => <button class="icon"><svg /></button>}</Show>', 1],
        ['<If when={ok}><button class="icon">{icons.refresh}</button></If>', 1],
        ['<Solid.Show when={ok}><button class="icon">{icons.refresh}</button></Solid.Show>', 1],
        ['<For each={[1]}>{item => <button class="icon">{icons.refresh}</button>}</For>', 1],
        ['<For each={[1, 2]}>{item => <button class="icon"><svg /></button>}</For>', 2],
        [
          '<For each={[]} fallback={<button class="icon"><svg /></button>}>{item => <span />}</For>',
          1,
        ],
        ['{ok && <button class="icon"><svg /></button>}', 1],
        ['{false && <button class="icon"><svg /></button>}', 0],
        ['{false ? <button class="icon"><svg /></button> : null}', 0],
        ['{false && <span />}{false && <span />}<button class="icon"><svg /></button>', 1],
        ['{true ? <button class="icon"><svg /></button> : <a class="icon"><svg /></a>}', 1],
        ['{ok ? <span /> : <span />}<button class="icon"><svg /></button>', 1],
        ['{ok ? <button class="icon"><svg /></button> : <a class="icon"><svg /></a>}', 2],
        [
          '<Show when={ok} fallback={<a class="icon"><svg /></a>}><button class="icon"><svg /></button></Show>',
          2,
        ],
        ['<button class="icon">{ok ? <svg /> : <svg />}</button>', 2],
        ['<button class="icon">{ok && <svg />}</button>', 1],
        ['<button class="icon"><svg /></button>{ok && <button class="icon"><svg /></button>}', 3],
        [
          '<button class="icon"><svg /></button><button class="icon">{ok ? <svg /> : <svg />}</button>',
          3,
        ],
        [
          '<For each={[1]}>{item => <Show when={item}>{ok && <button class="icon"><svg /></button>}</Show>}</For>',
          1,
        ],
      ];
      for (const [body, count] of cases) {
        const fixtures = collectJsx(
          `<header class="toolbar">${body}</header>`,
          dom.window.document,
        );
        let controls = 0;
        for (const entry of fixtures) {
          const template = dom.window.document.createElement("template");
          template.innerHTML = entry.html;
          controls += template.content.querySelectorAll("[data-icon-grid-control]").length;
          expect(entry.html, body).not.toContain("data-icon-grid-source");
        }
        expect(controls, body).toBe(count);
        expect(scanIconGridFit(css, fixtures, base).findings, body).toHaveLength(count * 2);
      }
      const adjacent = collectJsx(
        '<header class="toolbar">{ok ? <span /> : <span />}<button class="icon"><svg /></button></header>',
        dom.window.document,
      );
      expect(
        scanIconGridFit(
          original.replace(".toolbar > button", ".toolbar > span + button"),
          adjacent,
          base,
        ).findings,
      ).toHaveLength(2);
      const differentSiblings = collectJsx(
        '<header class="toolbar">{ok ? <span class="wide" /> : <span class="narrow" />}<button class="icon"><svg /></button></header>',
        dom.window.document,
      );
      expect(
        scanIconGridFit(
          original.replace(".toolbar > button", ".toolbar > .narrow + button"),
          differentSiblings,
          base,
        ).findings,
      ).toHaveLength(2);
      for (const middle of [
        "{ok && <span />}",
        "{ok ? <span /> : null}",
        "<Show when={ok}><span /></Show>",
      ]) {
        const optionalSibling = collectJsx(
          `<header class="toolbar"><span class="wide" />${middle}<button class="icon"><svg /></button></header>`,
          dom.window.document,
        );
        expect(
          scanIconGridFit(
            original.replace(".toolbar > button", ".toolbar > .wide + button"),
            optionalSibling,
            base,
          ).findings,
          middle,
        ).toHaveLength(2);
      }
      const repeated = collectJsx(
        '<header class="toolbar"><For each={[1, 2]}>{() => <span />}</For><button class="icon"><svg /></button></header>',
        dom.window.document,
      );
      expect(
        scanIconGridFit(
          original.replace(".toolbar > button", ".toolbar > span + span + button"),
          repeated,
          base,
        ).findings,
      ).toHaveLength(2);
      const voidSibling = collectJsx(
        '<header class="toolbar"><br /><button class="icon"><svg /></button></header>',
        dom.window.document,
      );
      expect(
        scanIconGridFit(
          original.replace(".toolbar > button", ".toolbar > br + br + button"),
          voidSibling,
          base,
        ).findings,
      ).toHaveLength(0);
      expect(
        scanIconGridFit(
          original.replace(".toolbar > button", ".toolbar > br + button"),
          voidSibling,
          base,
        ).findings,
      ).toHaveLength(2);
    } finally {
      dom.window.close();
    }
  });

  it("does not fabricate adjacent controls from per-item branches", () => {
    const dom = new JSDOM();
    try {
      for (const children of [
        '<For each={[true, false]}>{item => item ? <button class="icon"><svg /></button> : <span />}</For>',
        '<For each={[true, false]}>{item => item && <button class="icon"><svg /></button>}</For>',
        '<For each={[true, false]}>{item => <Show when={item}><button class="icon"><svg /></button></Show>}</For>',
      ]) {
        const fixtures = collectJsx(
          `<header class="toolbar">${children}</header>`,
          dom.window.document,
        );
        expect(
          scanIconGridFit(
            original.replace(".toolbar > button", ".toolbar > button + button"),
            fixtures,
            base,
          ).findings,
          children,
        ).toEqual([]);
      }
    } finally {
      dom.window.close();
    }
  });

  it("applies class-array overrides before splitting enabled class names", () => {
    const dom = new JSDOM();
    try {
      const cases: [string, string | null][] = [
        ['["icon", { icon: false }]', null],
        ['[{ icon: false }, ["icon"]]', "icon"],
        ['["icon label", { icon: false }]', "icon label"],
        ['["icon", { "icon label": false }]', "icon"],
        ['["icon", { icon: false }, { icon: true }]', "icon"],
        ["null", null],
        ["false", null],
        ["true", null],
        ["[]", null],
        ['""', ""],
      ];
      for (const [classes, expected] of cases) {
        const fixtures = collectJsx(
          `<button class={${classes}}><svg /></button>`,
          dom.window.document,
        );
        expect(fixtures, classes).toHaveLength(1);
        const template = dom.window.document.createElement("template");
        template.innerHTML = fixtures[0]!.html;
        expect(template.content.querySelector("button")?.getAttribute("class"), classes).toBe(
          expected,
        );
      }
      const literalName = collectJsx(
        '<button className="icon"><svg /></button>',
        dom.window.document,
      );
      const template = dom.window.document.createElement("template");
      template.innerHTML = literalName[0]!.html;
      expect(template.content.querySelector("button")?.getAttribute("class")).toBeNull();
      expect(template.content.querySelector("button")?.getAttribute("classname")).toBe("icon");
      expect(scanIconGridFit(original, literalName, base).findings).toEqual([]);
    } finally {
      dom.window.close();
    }
  });

  it("excludes unresolved JSX ancestry, geometry, and icon-only content", () => {
    const dom = new JSDOM();
    try {
      for (const markup of [
        '<header class={variant}><button class="icon"><svg /></button></header>',
        '<header style={style}><button class="icon"><svg /></button></header>',
        '<header {...props}><button class="icon"><svg /></button></header>',
        '<Wrapper><button class="icon"><svg /></button></Wrapper>',
        '<header><span class={variant} /><button class="icon"><svg /></button></header>',
        '<header><span {...props} /><button class="icon"><svg /></button></header>',
        '<header><span prop:textContent="label" /><button class="icon"><svg /></button></header>',
        '<button class="icon" innerHTML={html}><svg /></button>',
        '<><span {...props} /><button class="icon"><svg /></button></>',
        '<><span class={variant} /><button class="icon"><svg /></button></>',
        '<header><For each={items}>{() => <span />}</For><button class="icon"><svg /></button></header>',
        '<header><Show when={ok}><span /></Show><Show when={ok}><button class="icon"><svg /></button></Show></header>',
        '<For each={[1, 2]} {...{each: []}}>{() => <button class="icon"><svg /></button>}</For>',
        '<Show when={true} {...props}><button class="icon"><svg /></button></Show>',
        '(Show) => <Show when={true}><button class="icon"><svg /></button></Show>',
        '({ Show }) => <Show when={true}><button class="icon"><svg /></button></Show>',
        '(Solid) => <Solid.Show when={true}><button class="icon"><svg /></button></Solid.Show>',
        '<button><Show when={false} fallback="Save" /><svg /></button>',
        '<button><For each={[]} fallback="Save">{() => <span />}</For><svg /></button>',
        'false && <button class="icon"><svg /></button>',
        'false ? <button class="icon"><svg /></button> : null',
        'true || <button class="icon"><svg /></button>',
        '1 ?? <button class="icon"><svg /></button>',
        '<button class={["icon", { active: state }]}><svg /></button>',
        '<button class="icon"><svg class={variant} /></button>',
        '<button class="icon"><svg {...props} /></button>',
        '<button class="icon">Save <svg /></button>',
        '<button class="icon"><span /><svg /></button>',
        '<button class="icon">{arbitrary}</button>',
        '<section><style>{styles}</style><button class="icon"><svg /></button></section>',
      ]) {
        expect(collectJsx(markup, dom.window.document), markup).toEqual([]);
      }
      const fixtures = collectJsx(
        '<button class="icon" aria-pressed={pressed}><svg /></button>',
        dom.window.document,
      );
      const result = scanIconGridFit(
        original + '.icon:not([aria-pressed="true"]) {padding:0}',
        fixtures,
        base,
      );
      expect(result.findings).toEqual([]);
      expect(result.unresolved).toBe(2);
    } finally {
      dom.window.close();
    }
  });

  it("reports JSX source locations and discovers TSX controls without test fixtures", () => {
    const dom = new JSDOM();
    try {
      const fixtures = collectJsx(
        '\n<section>\n  <button class="icon"><svg /></button>\n</section>',
        dom.window.document,
      );
      const whitespace = collectJsx(
        '<section><span>\n  </span><button class="icon"><svg /></button></section>',
        dom.window.document,
      );
      const template = dom.window.document.createElement("template");
      template.innerHTML = whitespace[0]!.html;
      expect(template.content.querySelector("span")?.textContent).toBe("");
      expect(fixtures).toEqual([expect.objectContaining({ file: "ui/src/control.tsx", line: 3 })]);
    } finally {
      dom.window.close();
    }
    const { root } = createAuditFixture({ "control.css": css }, "");
    const markup =
      'const View = () => <header class="toolbar"><div role="button" class="icon">{icons.refresh}</div></header>;';
    for (const file of ["control.tsx", "control.test.tsx", "control.test-support.tsx"]) {
      fs.writeFileSync(path.join(root, "ui/src", file), markup);
    }
    const report = auditIconButtons(root, ["ui/src/styles/control.css"]);
    expect(report.sourceFixtures).toBe(1);
    expect(report.findings).toHaveLength(2);
    expect(report.findings[0]).toMatchObject({ file: "ui/src/control.tsx", available: 12 });
  });
});
