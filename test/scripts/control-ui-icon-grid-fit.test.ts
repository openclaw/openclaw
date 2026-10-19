import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { auditIconButtons } from "../../scripts/audit-control-ui-icon-buttons.mts";
import {
  collectIconFixtures,
  type IconFixture,
} from "../../scripts/lib/control-ui-icon-fixtures.mts";
import {
  createIconStyleContext,
  scanIconGridFit,
} from "../../scripts/lib/control-ui-icon-grid-fit.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());
let dom: JSDOM | undefined;
const getDocument = () => (dom ??= new JSDOM()).window.document;
function contents(html: string) {
  const template = getDocument().createElement("template");
  template.innerHTML = html;
  return template.content;
}
afterEach(() => {
  dom?.window.close();
  dom = undefined;
});

function collect(source: string, file: string, document = getDocument()): IconFixture[] {
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
const icon = '<button class="icon"><svg /></button>';
const link = '<a class="icon"><svg /></a>';
const refresh = '<button class="icon">{icons.refresh}</button>';
const header = (body: string) => `<header class="toolbar">${body}</header>`;
const buttonIn = (html: string) => contents(html).querySelector("button");
const show = (when: string, body = icon, fallback = "") =>
  `<Show when=${when}${fallback ? ` fallback={${fallback}}` : ""}>${body}</Show>`;

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
      ..."display:none;position:absolute;transform:translateX(-2px);justify-self:start"
        .split(";")
        .map((declaration) => ".icon svg {" + declaration + "}"),
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
      ),
    );
  });

  it("expands parsed nesting tokens without changing literal or escaped ampersands", () => {
    const { root, styles } = createAuditFixture({
      "other.css": String.raw`
        .toolbar > .icon {
          :is([data-label="é&"] &, &.active) { padding: 0; }
          .literal\& & + & { padding: 0; }
        }
      `,
    });
    const context = createIconStyleContext(root)(path.join(styles, "control.css"));
    expect(context.otherRules.flatMap((rule) => rule.selectors)).toEqual([
      ':is([data-label="é&"] .toolbar > .icon, .toolbar > .icon.active)',
      String.raw`.literal\& .toolbar > .icon + .toolbar > .icon`,
    ]);
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
    const source = `class Control extends OpenClawLightDomElement {
  render() {
    return html\`<button class="icon">\${(busy ? icons.loader : icons.refresh)}</button>\`;
  }
}`;
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
      const fixtures = collect(markup, file, getDocument());
      expect(fixtures, name).toEqual(
        line === null ? [] : [expect.objectContaining({ file, line })],
      );
      if (line !== null) {
        expect(fixtures, name).toHaveLength(1);
        expect(
          contents(fixtures[0]!.html).querySelectorAll("[data-icon-grid-control]"),
          name,
        ).toHaveLength(1);
        expect(scanIconGridFit(original, fixtures, base).findings, name).toHaveLength(findings);
      }
    }
  });

  it("audits current source and shared styles on each manual invocation", () => {
    const { root, styles, source } = createAuditFixture();
    const audit = () => auditIconButtons(root, ["ui/src/styles/control.css"]);
    const update = (file: string, nextSource: string | undefined, count: number) => {
      if (nextSource === undefined) {
        fs.unlinkSync(file);
      } else {
        fs.writeFileSync(file, nextSource);
      }
      expect(audit().findings).toHaveLength(count);
    };
    const first = audit();
    expect(first.findings).toHaveLength(2);
    expect(first.findings[0]?.available).toBe(12);
    update(source, 'html`<button class="icon">${icons.refresh}</button>`', 0);
    const added = path.join(root, "ui/src/added.ts");
    update(added, cramped, 2);
    update(added, undefined, 0);
    update(source, cramped, 2);
    const sibling = path.join(styles, "other.css");
    update(sibling, ".shell .icon {padding:0}", 0);
    update(sibling, undefined, 2);
    update(path.join(styles, "base.css"), base + ".icon {min-width:32px;min-height:32px}", 0);
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

  function collectJsx(markup: string) {
    return collect(`${imports}\nconst View = () => ${markup};`, "ui/src/control.tsx");
  }

  function expectSibling(body: string, selector: string, count = 2) {
    const fixtures = collectJsx(header(body));
    const sheet = original.replace(".toolbar > button", `.toolbar > ${selector} + button`);
    expect(scanIconGridFit(sheet, fixtures, base).findings, body).toHaveLength(count);
  }

  it("preserves literal ancestors through JSX branches, Show, and For", () => {
    const cases: [string, number][] = [
      [refresh, 1],
      [link, 1],
      ['<div class="icon" role="button">{icons.refresh}</div>', 1],
      ['<button class={["icon", { compact: true }]}><svg /></button>', 1],
      [show("{ok}", refresh), 1],
      [show("{false}"), 0],
      [show('""', icon, "<span />"), 0],
      [show('"ready"', icon, link), 1],
      [`<Show when fallback={${link}}>${icon}</Show>`, 1],
      [show("{true}", icon, link), 1],
      [show("{false}", icon, link), 1],
      [show("{selected}", `{item => ${icon}}`), 1],
      [`<If when={ok}>${refresh}</If>`, 1],
      [`<Solid.Show when={ok}>${refresh}</Solid.Show>`, 1],
      [`<For each={[1]}>{item => ${refresh}}</For>`, 1],
      [`<For each={[1, 2]}>{item => ${icon}}</For>`, 2],
      [`<For each={[]} fallback={${icon}}>{item => <span />}</For>`, 1],
      [`{ok && ${icon}}`, 1],
      [`{false && ${icon}}`, 0],
      [`{false ? ${icon} : null}`, 0],
      [`{false && <span />}{false && <span />}${icon}`, 1],
      [`{true ? ${icon} : ${link}}`, 1],
      [`{ok ? <span /> : <span />}${icon}`, 1],
      [`{ok ? ${icon} : ${link}}`, 2],
      [show("{ok}", icon, link), 2],
      ['<button class="icon">{ok ? <svg /> : <svg />}</button>', 2],
      ['<button class="icon">{ok && <svg />}</button>', 1],
      [`${icon}{ok && ${icon}}`, 3],
      [`${icon}<button class="icon">{ok ? <svg /> : <svg />}</button>`, 3],
      [`<For each={[1]}>{item => ${show("{item}", `{ok && ${icon}}`)}}</For>`, 1],
    ];
    for (const [body, count] of cases) {
      const fixtures = collectJsx(header(body));
      let controls = 0;
      for (const entry of fixtures) {
        controls += contents(entry.html).querySelectorAll("[data-icon-grid-control]").length;
        expect(entry.html, body).not.toContain("data-icon-grid-source");
      }
      expect(controls, body).toBe(count);
      expect(scanIconGridFit(css, fixtures, base).findings, body).toHaveLength(count * 2);
    }
    expectSibling(`{ok ? <span /> : <span />}${icon}`, "span");
    expectSibling(`{ok ? <span class="wide" /> : <span class="narrow" />}${icon}`, ".narrow");
    const siblings = ["{ok && <span />}", "{ok ? <span /> : null}", show("{ok}", "<span />")];
    for (const middle of siblings) {
      expectSibling(`<span class="wide" />${middle}${icon}`, ".wide");
    }
    expectSibling(`<For each={[1, 2]}>{() => <span />}</For>${icon}`, "span + span");
    expectSibling(`<br />${icon}`, "br + br", 0);
    expectSibling(`<br />${icon}`, "br");
  });

  it("applies class-array overrides before splitting enabled class names", () => {
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
      const fixtures = collectJsx(`<button class={${classes}}><svg /></button>`);
      expect(fixtures, classes).toHaveLength(1);
      expect(buttonIn(fixtures[0]!.html)?.getAttribute("class"), classes).toBe(expected);
    }
    const literalName = collectJsx('<button className="icon"><svg /></button>');
    const button = buttonIn(literalName[0]!.html);
    expect(button?.getAttribute("class")).toBeNull();
    expect(button?.getAttribute("classname")).toBe("icon");
    expect(scanIconGridFit(original, literalName, base).findings).toEqual([]);
  });

  it("excludes unresolved JSX ancestry, geometry, and icon-only content", () => {
    for (const markup of [
      ...["class={variant}", "style={style}", "{...props}"].map(
        (attrs) => `<header ${attrs}>${icon}</header>`,
      ),
      `<Wrapper>${icon}</Wrapper>`,
      ...["class={variant}", "{...props}", 'prop:textContent="label"'].map(
        (attrs) => `<header><span ${attrs} />${icon}</header>`,
      ),
      '<button class="icon" innerHTML={html}><svg /></button>',
      ...["{...props}", "class={variant}"].map((attrs) => `<><span ${attrs} />${icon}</>`),
      `<header><For each={items}>{() => <span />}</For>${icon}</header>`,
      header(show("{ok}", "<span />") + show("{ok}")),
      `<For each={[1, 2]} {...{each: []}}>{() => ${icon}}</For>`,
      `<Show when={true} {...props}>${icon}</Show>`,
      ...["(Show)", "({ Show })"].map((arg) => `${arg} => ${show("{true}")}`),
      `(Solid) => <Solid.Show when={true}>${icon}</Solid.Show>`,
      '<button><Show when={false} fallback="Save" /><svg /></button>',
      '<button><For each={[]} fallback="Save">{() => <span />}</For><svg /></button>',
      ...["false &&", "true ||", "1 ??"].map((prefix) => `${prefix} ${icon}`),
      `false ? ${icon} : null`,
      '<button class={["icon", { active: state }]}><svg /></button>',
      '<button class="icon"><svg class={variant} /></button>',
      '<button class="icon"><svg {...props} /></button>',
      '<button class="icon">Save <svg /></button>',
      '<button class="icon"><span /><svg /></button>',
      '<button class="icon">{arbitrary}</button>',
      '<section><style>{styles}</style><button class="icon"><svg /></button></section>',
    ]) {
      expect(collectJsx(markup), markup).toEqual([]);
    }
    const fixtures = collectJsx('<button class="icon" aria-pressed={pressed}><svg /></button>');
    const result = scanIconGridFit(
      original + '.icon:not([aria-pressed="true"]) {padding:0}',
      fixtures,
      base,
    );
    expect(result.findings).toEqual([]);
    expect(result.unresolved).toBe(2);
  });

  it("reports JSX source locations and discovers TSX controls without test fixtures", () => {
    const fixtures = collectJsx('\n<section>\n  <button class="icon"><svg /></button>\n</section>');
    const whitespace = collectJsx(`<section><span>\n  </span>${icon}</section>`);
    expect(contents(whitespace[0]!.html).querySelector("span")?.textContent).toBe("");
    expect(fixtures).toEqual([expect.objectContaining({ file: "ui/src/control.tsx", line: 3 })]);
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
