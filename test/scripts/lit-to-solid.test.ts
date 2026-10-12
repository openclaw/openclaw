import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import * as ts from "typescript/unstable/ast";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { convertLitToSolid } from "../../scripts/codemods/lit-to-solid.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { corpus, fixtureSource } from "../fixtures/lit-to-solid/corpus.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const parser = createNativeTypeScriptParser();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterAll(() => parser.close());

// Parentheses and JSX expression wrappers around JSX have identical output.
// Keep literal bytes and all other node shapes so whitespace and bindings remain golden.
function canonical(node: ts.Node): unknown {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "attributeValue" &&
    node.arguments.length === 1
  ) {
    return canonical(node.arguments[0]!);
  }
  if (
    ts.isCallExpression(node) &&
    ((ts.isIdentifier(node.expression) && node.expression.text === "String") ||
      node.expression.getText() === "globalThis.String") &&
    node.arguments.length === 1
  ) {
    let value = node.arguments[0]!;
    while (ts.isParenthesizedExpression(value)) {
      value = value.expression;
    }
    if (
      ts.isBinaryExpression(value) &&
      value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      ts.isStringLiteral(value.right) &&
      value.right.text === ""
    ) {
      return canonical(value.left);
    }
  }
  // The generated normalization preserves Lit boolean child text. Its runtime
  // contract is tested separately; the goldens compare the underlying values.
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "normalizeLitChild" &&
    (node.arguments.length === 1 ||
      (node.arguments.length === 2 && node.arguments[1]?.kind === ts.SyntaxKind.TrueKeyword))
  ) {
    return canonical(node.arguments[0]!);
  }
  if (ts.isParenthesizedExpression(node)) {
    return canonical(node.expression);
  }
  if (
    ts.isJsxExpression(node) &&
    node.expression &&
    (ts.isJsxElement(node.expression) ||
      ts.isJsxSelfClosingElement(node.expression) ||
      ts.isJsxFragment(node.expression))
  ) {
    return canonical(node.expression);
  }
  if (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isIdentifier(node) ||
    ts.isJsxText(node)
  ) {
    return [node.kind, node.text];
  }
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(canonical(child));
  });
  return [node.kind, ...children];
}

function initializer(code: string, file: string) {
  const source = parser.parseSourceFile(file, code);
  expect(parser.getSyntacticDiagnostics(file)).toEqual([]);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    const fixture = statement.declarationList.declarations.find(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "fixture",
    );
    if (fixture?.initializer) {
      return canonical(fixture.initializer);
    }
  }
  throw new Error("Converted module lost its fixture export");
}

function expectConversion(input: string, expected: string) {
  const result = convertLitToSolid(input, "fixture.ts", parser);
  expect(result.diagnostics).toEqual([]);
  expect(initializer(result.code, "actual.tsx")).toEqual(
    initializer(`const fixture = ${expected};`, "expected.tsx"),
  );
  return result;
}

describe("Lit to Solid real-template goldens", () => {
  it.each(corpus)("converts $id ($provenance.path:$provenance.line)", (fixture) => {
    const result = expectConversion(fixtureSource(fixture), fixture.expected);
    expect(result.templates).toBeGreaterThan(0);
  });
});

describe("pending Solid conversion lint gate", () => {
  it("rejects source and JSX comments while accepting marker text in literals", () => {
    const directory = tempDirs.make("openclaw-solid-lint-");
    const fixtures = {
      "source.ts": "// TODO(solid2): move ownership\nexport const value = 1;\n",
      "view.tsx": "export const view = <div>{/* TODO(solid2): move ownership */}</div>;\n",
      "literals.ts":
        'export const message = "TODO(solid2): documentation";\nexport const sample = `TODO(solid2): documentation`;\n',
    };
    for (const [name, content] of Object.entries(fixtures)) {
      fs.writeFileSync(path.join(directory, name), content);
    }
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-oxlint.mjs",
        "--openclaw-focused-config",
        "--config",
        "config/oxlint/boundary-guards.json",
        "--format",
        "json",
        ...Object.keys(fixtures).map((name) => path.join(directory, name)),
      ],
      { encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(result.stdout) as {
      number_of_files: number;
      diagnostics: Array<{ filename: string; code: string; severity: string }>;
    };
    expect(report.number_of_files).toBe(3);
    expect(
      report.diagnostics
        .map((diagnostic) => ({
          file: path.basename(diagnostic.filename),
          code: diagnostic.code,
          severity: diagnostic.severity,
        }))
        .toSorted((left, right) => left.file.localeCompare(right.file)),
    ).toEqual([
      {
        file: "source.ts",
        code: "openclaw-solid-migration(no-pending-conversion)",
        severity: "error",
      },
      {
        file: "view.tsx",
        code: "openclaw-solid-migration(no-pending-conversion)",
        severity: "error",
      },
    ]);
  });
});

describe("Lit to Solid conversion contracts", () => {
  it.each([
    {
      name: "preserves cooked whitespace, entities, and literal JSX punctuation",
      input:
        'import { html } from "lit"; const fixture = html` <p title="A &amp; B">&lt;{x}&gt;&nbsp;\n</p> `;',
      expected: '<>{" "}<p title={"A & B"}>{"<{x}>\u00a0\\n"}</p>{" "}</>',
    },
    {
      name: "keeps imported aliases and ordinary translated expressions",
      input:
        'import { html as view, nothing as empty } from "lit-html"; declare function t(key:string):string; const fixture = view`<p title=${empty}>${t("key")}${empty}</p>`;',
      expected: '<><p title={undefined}>{t("key")}{null}</p></>',
    },
    {
      name: "converts compound classes, classMap objects, and styleMap objects",
      input:
        'import { html } from "lit"; import { classMap } from "lit/directives/class-map.js"; import { styleMap } from "lit/directives/style-map.js"; const fixture = html`<div class="base ${active ? "active" : ""}" style=${styleMap({ color })}><span class=${classMap({ active })}></span></div>`;',
      expected:
        '<><div class={["base ", active ? "active" : ""]} style={{ color }}><span class={{ active }}></span></div></>',
    },
    {
      name: "maps camelCase and dashed custom events",
      input:
        'import { html } from "lit"; const fixture = html`<input @keydown=${onKey} @beforeinput=${onBefore} /><wa-select @wa-change=${onChange}></wa-select>`;',
      expected:
        "<><input onKeyDown={onKey} onBeforeInput={onBefore} /><wa-select onWa-change={onChange}></wa-select></>",
    },
    {
      name: "preserves explicit keys and turns item/index reads into accessors",
      input:
        'import { html } from "lit"; import { repeat } from "lit/directives/repeat.js"; const items=[{id:"row",label:"row",item:1}]; const fixture = html`<ul>${repeat(items, (item) => item.id, (item: {label:string}, index: number) => html`<li>${item.label}:${index}</li>`)}</ul>`;',
      expected:
        '<><ul><For each={globalThis.Array.from(items)} keyed={(item) => item.id}>{(item, index) => <><li>{item().label}{":"}{index()}</li></>}</For></ul></>',
    },
    {
      name: "does not rewrite an event callback parameter shadowing the map item",
      input:
        'import { html } from "lit"; const items=[{id:"row",label:"row",item:1}]; const fixture = html`${items.map((item: {label:string}) => html`<button @click=${(item: MouseEvent) => use(item)}>${item.label}</button>`)}`;',
      expected:
        "<><For each={items} keyed={false}>{(item) => <><button onClick={(item: MouseEvent) => use(item)}>{item().label}</button></>}</For></>",
    },
  ])("$name", ({ input, expected }) => {
    expectConversion(input, expected);
  });

  it.each([
    ['<div data-code="${1}${2}"></div>', '<><div data-code={"" + (1 ?? "") + (2 ?? "")}></div></>'],
    [
      '<div title="x${nullable}y"></div>',
      '<><div title={"" + "x" + (nullable ?? "") + "y"}></div></>',
    ],
    ["<div .scrollTop=${position}></div>", "<><div prop:scrollTop={position}></div></>"],
    ["<div ?data-selected=${value}></div>", "<><div data-selected={!!value}></div></>"],
    ['<div class="row-${id}"></div>', '<><div class={"" + "row-" + (id ?? "")}></div></>'],
  ])("preserves attribute semantics: %s", (markup, expected) => {
    expectConversion('import {html} from "lit"; const fixture = html`' + markup + "`;", expected);
  });

  it("runs composed control flow and child normalization through the Solid compiler", () => {
    const directory = tempDirs.make("openclaw-solid-runtime-");
    const run = spawnSync(
      process.execPath,
      [
        "--conditions=browser",
        "--import",
        "tsx",
        "test/fixtures/lit-to-solid/runtime.mts",
        path.join(directory, "compiled.mjs"),
      ],
      { encoding: "utf8" },
    );
    expect(run.error).toBeUndefined();
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain("compiled runtime:");
  });

  it("reports array element deletions as manual child work", () => {
    const result = convertLitToSolid(
      'import {html} from "lit"; const items=["a","b"]; delete items[0]; const fixture=html`${items.map(item=>item)}`;',
      "deleted.ts",
      parser,
    );
    expect(
      result.diagnostics.some((entry) => entry.reason.includes("explicit text or JSX decision")),
    ).toBe(true);
  });

  it("keeps retained Lit type imports type-only", () => {
    const result = expectConversion(
      'import {html} from "lit"; import type {TemplateResult,CSSResult} from "lit"; declare const styles:CSSResult; function view():TemplateResult{return fixture;} const fixture=html`<p>ok</p>`;',
      '<><p>{"ok"}</p></>',
    );
    const source = parser.parseSourceFile("imports.tsx", result.code);
    const retained = source.statements.find(
      (node) => ts.isImportDeclaration(node) && node.getText(source).includes("CSSResult"),
    );
    expect(
      retained && ts.isImportDeclaration(retained) && retained.importClause?.phaseModifier,
    ).toBe(ts.SyntaxKind.TypeKeyword);
  });

  it("preserves narrowing with a Show accessor", () => {
    expectConversion(
      'import {html,nothing} from "lit"; declare const user:{name:string}|undefined; const fixture=html`${user ? user.name : nothing}`;',
      "<><Show when={user} fallback={null}>{(showValue) => <>{showValue().name}</>}</Show></>",
    );
  });

  it("scopes catch bindings and disambiguates generic arrows and assertions", () => {
    const result = expectConversion(
      'import {html} from "lit"; try {} catch(html) {} const identity=<T>(x:T)=>x; const value=<string>text; const fixture=html`<p>converted</p>`;',
      '<><p>{"converted"}</p></>',
    );
    expect(result.code).toContain("<T,>");
    expect(result.code).toContain("text as string");
  });

  it("keeps switch-local helper names inside the switch", () => {
    const result = expectConversion(
      'import {html} from "lit"; switch(choice) {case 1: const html=local; html`local`; break;} const fixture=html`<p>outer</p>`;',
      '<><p>{"outer"}</p></>',
    );
    expect(result.code).toContain("html`local`");
    expect(result.code).not.toContain('from "lit"');
  });

  it("preserves generic type parameters that shadow Lit types", () => {
    const result = convertLitToSolid(
      'import type {TemplateResult} from "lit"; function keep<TemplateResult>(value:TemplateResult):TemplateResult{return value;}',
      "generic.ts",
      parser,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("keep<TemplateResult>(value:TemplateResult):TemplateResult");
    expect(result.code).not.toContain("JSX.Element");
  });

  it("preserves local type aliases that shadow Lit imports", () => {
    const result = convertLitToSolid(
      'import type {TemplateResult} from "lit"; function keep(){type TemplateResult={id:number}; const value:TemplateResult={id:1}; return value.id;}',
      "types.ts",
      parser,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("value:TemplateResult");
    expect(result.code).not.toContain("JSX.Element");
  });

  it("discovers namespace-imported custom directives", () => {
    const directory = tempDirs.make("openclaw-solid-directive-");
    fs.writeFileSync(
      path.join(directory, "custom.ts"),
      'import {directive} from "lit/directive.js"; export const custom=directive(Custom);',
    );
    const result = convertLitToSolid(
      'import {html} from "lit"; import * as d from "./custom.js"; const fixture=html`${d.custom(value)}`;',
      path.join(directory, "input.ts"),
      parser,
    );
    expect(result.diagnostics.some((entry) => entry.reason.includes("custom directive"))).toBe(
      true,
    );
  });

  it("keeps a trailing slash in a static unquoted URL", () => {
    expectConversion(
      'import {html} from "lit"; const fixture=html`<img src=/assets/>`;',
      '<><img src={"/assets/"} /></>',
    );
  });

  it("marks writes to a conditional guard instead of assigning to an accessor", () => {
    const result = convertLitToSolid(
      'import {html,nothing} from "lit"; const fixture=html`${selected ? html`<button @click=${()=>selected=undefined}>Close</button>` : nothing}`;',
      "guard.ts",
      parser,
    );
    expect(result.diagnostics.some((entry) => entry.reason.includes("writes its guard"))).toBe(
      true,
    );
    expect(result.code).toContain("selected=undefined");
  });

  it.each([
    'import {html,nothing} from "lit"; const fixture=html`${obj.format ? obj.format() : nothing}`;',
    'import {html} from "lit"; const fixture=html`${items.map(item => html`<button @click=${()=>[item]=replacements}></button>`)}`;',
    'import {html} from "lit"; import {classMap} from "lit/directives/class-map.js"; const value=classMap({active:true}); const fixture=html`<div class=${value}></div>`;',
    'import {html,nothing} from "lit"; function empty(){return nothing} const fixture=html`<a href=${empty()}></a>`;',
    'import {html} from "lit"; import {classMap} from "lit/directives/class-map.js"; const fixture=html`<div class="base${classMap({active:true})}"></div>`;',
    'import {html} from "lit"; import * as d from "lit/directive.js"; const custom=d.directive(MyDirective); const fixture=html`${custom(value)}`;',
  ])("marks escaping helpers or receiver-sensitive writes: %s", (input) => {
    expect(convertLitToSolid(input, "manual.ts", parser).diagnostics.length).toBeGreaterThan(0);
  });

  it("unwraps transparent directive expressions", () => {
    expectConversion(
      'import {html} from "lit"; import {classMap} from "lit/directives/class-map.js"; import {styleMap} from "lit/directives/style-map.js"; const fixture=html`<div class=${(classMap({active:true}))} style=${(styleMap({color}))}></div>`;',
      "<><div class={{active:true}} style={{color}}></div></>",
    );
  });

  it.each([
    'import {html} from "lit"; const fixture=html`<button @click=${enabled ? this.click : undefined}></button>`;',
    'import {html} from "lit"; import {classMap} from "lit/directives/class-map.js"; const fixture=html`<div class=${enabled ? classMap({active:true}) : ""}></div>`;',
    'import {html} from "lit"; import {classMap} from "lit/directives/class-map.js"; const classes=classMap; const fixture=html`<div class=${classes({active:true})}></div>`;',
    'import {html} from "lit"; import {styleMap} from "lit/directives/style-map.js"; const fixture=html`<div style=${styleMap({color: urgent ? "red !important" : "red"})}></div>`;',
  ])("marks conditional or escaping directive semantics: %s", (input) => {
    expect(convertLitToSolid(input, "manual.ts", parser).diagnostics.length).toBeGreaterThan(0);
  });

  it("preserves adjacent class fragments and namespace-qualified template types", () => {
    const result = expectConversion(
      'import * as L from "lit"; function view(): L.TemplateResult { return L.html`<p>ok</p>`; } const fixture=L.html`<div class="${prefix}${suffix}"></div>`;',
      '<><div class={"" + (prefix ?? "") + (suffix ?? "")}></div></>',
    );
    expect(result.code).toContain("JSX.Element");
    expect(result.code).not.toContain("L.TemplateResult");
  });

  it.each([
    'import {html,nothing} from "lit"; declare const visible:()=>boolean; const parts=[html`${visible()?html`<b>ok</b>`:nothing}`]; const fixture=html`${parts.map(part=>part)}`;',
    'import {html,type TemplateResult} from "lit"; function wrap(parts:TemplateResult[]){return html`<section>${parts}</section>`;}',
    'import {html,nothing} from "lit"; const holder={get child(){return html`${true?html`<b>ok</b>`:nothing}`;}}; const fixture=html`${holder.child}`;',
    'import {html,type TemplateResult} from "lit"; declare const read:()=>TemplateResult[]; const fixture=html`${read()}`;',
    'import {html} from "lit"; const raw=()=>"called"; const holder={draw:()=>html`<b>ok</b>`}; Object.assign(holder,{draw:()=>raw}); const fixture=html`${holder.draw()}`;',
    'import {html} from "lit"; const child=ready?html`<b>ok</b>`:null; const fixture=html`${child}`;',
    'import {html} from "lit"; function rows(){return [html`<b>ok</b>`]} const fixture=html`${rows()}`;',
    'import {html} from "lit"; const values=[html`<b>value</b>`]; const fixture=html`${values}`;',
    'import {html} from "lit"; const holder={child:html`<b>value</b>`}; const fixture=html`${holder.child}`;',
    'import {html} from "lit"; class Child{} function view(value:Child){return html`${value}`;}',
    'import {html} from "lit"; function view(value:Object){return html`${value}`;}',
    'import {html} from "lit"; const holder={child:{}}; const alias=holder; alias.child=()=>"called"; const fixture=html`${holder.child}`;',
    'import {html} from "lit"; let child; for(child of [()=>"called"]){} const fixture=html`${child}`;',
    'import {html} from "lit"; class View{} const fixture=html`${View}`;',
    'import {html} from "lit"; const tag=()=>()=>{throw Error("must not run")}; const fixture=html`${tag`text`}`;',
    'import {html} from "lit"; const fixture=html`${parseInt}`;',
    'import {html} from "lit"; import {callback} from "./callbacks.js"; const fixture=html`${callback}`;',
    'import {html} from "lit"; const listener:(()=>void)&{once?:boolean}=()=>{}; [listener.once]=[true]; const fixture=html`<button @click=${listener}></button>`;',
    'import {html} from "lit"; const {toString:child}="x"; const fixture=html`${child}`;',
    'import {html} from "lit"; function view(child){return html`${child}`;}',
    'import {html} from "lit"; let child=null; [child]=[()=>"called"]; const fixture=html`${child}`;',
    'import {html} from "lit"; let child=null; ({value:child}={value:()=>"called"}); const fixture=html`${child}`;',
    'import {html} from "lit"; interface Pending extends PromiseLike<boolean>{} function view(pending:Pending|null){return html`${pending?String(pending):"idle"}`;}',
    'import {html} from "lit"; const child=await Promise.resolve(()=>{throw Error("must not run")}); const fixture=html`${child}`;',
    'import {html} from "lit"; const text="x"; const fixture=html`${text.toString}`;',
    'import {html} from "lit"; function make(child=()=>{throw Error("must not run")}){return child;} const fixture=html`${make()}`;',
    'import {html} from "lit"; class Date{*[Symbol.iterator](){yield ()=>{throw Error("must not run")};}} const fixture=html`${new Date()}`;',
    'import {html} from "lit"; function make():Promise<boolean>{return Promise.resolve(false)} const pending=make(); const fixture=html`${pending?String(pending):"idle"}`;',
    'import {html} from "lit"; const values=[()=>{throw Error("must not run")}].slice(); const fixture=html`${values}`;',
    'import {html} from "lit"; const p=Promise.resolve(false); const pending={"then":p.then.bind(p)}; const fixture=html`${pending?String(pending):"idle"}`;',
    'import {html} from "lit"; function view(pending:{"then":PromiseLike<boolean>["then"]}){return html`${pending?String(pending):"idle"}`;}',
    'import {html} from "lit"; function view(value:unknown){return html`${(value as {child:()=>string}).child}`;}',
    'import {html} from "lit"; function view(read:unknown){return html`${(read as ()=>unknown)()}`;}',
    'import {html} from "lit"; const fn=()=>{throw Error("must not run")}; let child; const fixture=html`${child=fn}`;',
    'import {html} from "lit"; function view(read:()=>unknown){return html`${read()}`;}',
    'import {html} from "lit"; declare function read():unknown; const fixture=html`${read()}`;',
    'import {html} from "lit"; function view(value:object){return html`${value}`;}',
    'import {html} from "lit"; interface Value{label:string} function view(value:Value){return html`${value}`;}',
    'import {html} from "lit"; function view<T extends object>(value:T){return html`${value}`;}',
    'import {html} from "lit"; function view<T extends {}>(value:T){return html`${value}`;}',
    'import {html} from "lit"; function view<T extends Record<string,string>>(value:T){return html`${value}`;}',
    'import {html} from "lit"; function view<T>(value:T){return html`${value}`;}',
    'import {html} from "lit"; const fixture=html`${items.map((item,i)=>html`${item+i++}`)}`;',
    'import {html} from "lit"; const fixture=html`${items.map((item,i)=>html`${item+(i=3)}`)}`;',
    'import {html} from "lit"; function view(values:unknown[]){return html`${values}`;}',
    'import {html} from "lit"; type Values=ReadonlyArray<unknown>; function view(values:Values){return html`${values}`;}',
    'import {html} from "lit"; function view(values:[string, ...any[]]){return html`${values}`;}',
    'import {html} from "lit"; const pending=Promise.resolve(false); const fixture=html`${pending ? String(pending) : "idle"}`;',
    'import {html} from "lit"; function view(pending:PromiseLike<boolean>){return html`${pending ? String(pending) : "idle"}`;}',
    'import {html} from "lit"; const globalThis={String:()=>"wrong"}; const fixture=html`<div title=${123}></div>`;',
    'import {html} from "lit"; import {classMap} from "lit/directives/class-map.js"; const fixture=html`<div class="base ${enabled ? classMap({active:true}) : ""}"></div>`;',
    'import {html} from "lit"; const listener={handleEvent:onClick,once:true}; const fixture=html`<button @click=${listener}></button>`;',
    'import {html} from "lit"; const listener=()=>{}; listener.capture=true; const fixture=html`<button @click=${listener}></button>`;',
    'import {html} from "lit"; import {when} from "lit/directives/when.js"; const fixture=html`${when(flag, render)}`;',
    'import {html} from "lit"; const fixture=html`<div prop:value=${value}></div>`;',
    'import {html} from "lit"; const fixture=html`<div onClick=${value}></div>`;',
    'import {html} from "lit"; const fixture=html`<div ?ref=${flag}></div>`;',
    'import {html,nothing} from "lit"; const fixture=html`<button ?disabled=${content === nothing}></button>`;',
    'import {html} from "lit"; class Host { render(){const self=this; return html`<button @click=${self.increment}></button>`;} increment(){} }',
    'import {html} from "lit"; const fn=()=>{throw Error("must not run")}; const alias=fn; const values=[alias]; const fixture=html`${values}`;',
    'import {html} from "lit"; const fn=()=>{throw Error("must not run")}; const fixture=html`${enabled && fn}`;',
    'import {html} from "lit"; function view(fn:()=>string){return html`${fn}`;}',
    'import {html} from "lit"; declare const fn:()=>string; const fixture=html`${fn}`;',
    'import {html} from "lit"; declare const make:()=>()=>string; const fixture=html`${make()}`;',
    'import {html} from "lit"; const fixture=html`${value as ()=>string}`;',
    'import {html} from "lit"; function view(value:unknown){return html`${(value as ()=>string)}`;}',
    'import {html} from "lit"; const tag=html; const inner=tag`<b>Hello</b>`; const fixture=html`<div>${inner}</div>`;',
    'import {html} from "lit"; const fixture=html`${(()=>{throw Error("must not run")}) satisfies unknown}`;',
    'import {html} from "lit"; const values=new Map([["k",()=>{throw Error("must not run")}]]); const fixture=html`${values}`;',
    'import {html} from "lit"; const values=[1].map(()=>()=>{throw Error("must not run")}); const fixture=html`${values}`;',
    'import {html} from "lit"; const actions=[()=>{throw Error("must not run")}]; const fixture=html`${actions.map(action=>action)}`;',
    'import {html,nothing} from "lit"; const fixture=html`${user ? html`${(user as typeof user).name}` : nothing}`;',
    'import {html} from "lit"; import {ifDefined} from "lit/directives/if-defined.js"; const fixture=html`<x-widget .data=${ifDefined(value)}></x-widget>`;',
    'import {html} from "lit"; function make(){return ()=>{throw Error("must not run")}} const values=[1].map(make); const fixture=html`${values}`;',
    'import {html} from "lit"; function bytes():Uint8Array{return new Uint8Array([1])} const fixture=html`${bytes().map(value=>value/2)}`;',
    'import {html} from "lit"; const fixture=html`${items.map(item=>html`<button @click=${()=>{const copy:typeof item=item; consume(copy);}}></button>`)}`;',
    'import {html} from "lit"; const listener=Object.assign(()=>{}, {"once":true}); const fixture=html`<button @click=${listener}></button>`;',
    'import {html} from "lit"; const fixture=html`${items.map(<T,>(item:T)=>html`<span>${String(item as T)}</span>`)}`;',
    'import {html} from "lit"; const fixture=html`${Uint8Array.of(1).map(value=>value/2)}`;',
    'import {html} from "lit"; const fixture=html`${new Array(()=>{throw Error("must not run")})}`;',
    'import {html} from "lit"; import {repeat} from "lit/directives/repeat.js"; const fixture=html`${repeat(items,(...args)=>args[1].toString(),item=>html`${item}`)}`;',
    'import {html} from "lit"; function* values(){yield ()=>{throw Error("must not run")}} const fixture=html`${values()}`;',
    'import {html} from "lit"; const values={*[Symbol.iterator](){yield ()=>{throw Error("must not run")}}}; const fixture=html`${values}`;',
    'import {html} from "lit"; import {classMap} from "lit/directives/class-map.js"; import type {DirectiveResult} from "lit/directive.js"; const fixture=html`<div class=${classMap({active:true}) satisfies DirectiveResult}></div>`;',
    'import {html} from "lit"; function wrap(strings:TemplateStringsArray){return html(strings)} const inner=wrap`<b>Hello</b>`; const fixture=html`<div>${inner}</div>`;',
    'import {html} from "lit"; type F=()=>string; declare const fn:F; const fixture=html`${fn}`;',
    'import {html} from "lit"; const obj={fn:()=>{throw Error("must not run")}}; const fixture=html`${obj.fn}`;',
    'import {html} from "lit"; const holder={get child(){return ()=>{throw Error("must not run")}}}; const fixture=html`${holder.child}`;',
    'import {html} from "lit"; const holder={...{child:()=>{throw Error("must not run")}}}; const fixture=html`${holder.child}`;',
    'import {html} from "lit"; const items=flag ? [, "ok"] : ["ok"]; const fixture=html`${items.map(item=>html`<b>row</b>`)}`;',
    'import {html} from "lit"; const items=["ok"]; items.length++; const fixture=html`${items.map(item=>html`<b>row</b>`)}`;',
    'import {html} from "lit"; let count=0; const holder={get value(){return ++count}}; const fixture=html`${holder.value ? holder.value : null}`;',
    'import {html} from "lit"; let child:unknown=""; child=()=>{throw Error("must not run")}; const fixture=html`${child}`;',
    'import {html} from "lit"; const values:unknown[]=[]; values.push(()=>{throw Error("must not run")}); const fixture=html`${values}`;',
    'import {html} from "lit"; function view(value:unknown){return html`${value}`;}',
    'import {html} from "lit"; const fn=()=>{throw Error("must not run")}; const fixture=html`${(0,fn)}`;',
    'import {html} from "lit"; let count=0; class Holder{get value(){return ++count}} const holder=new Holder(); const fixture=html`${holder.value ? holder.value : null}`;',
    'import {html} from "lit"; const items=flag && ["ok"] || [, "ok"]; const fixture=html`${items.map(item=>html`<b>row</b>`)}`;',
    'import {html} from "lit"; const values:unknown[]=[null]; values.fill(()=>{throw Error("must not run")}); const fixture=html`${values}`;',
    'import {html} from "lit"; function view(props:{child:string}|{child:()=>string}){return html`${props.child}`;}',
    'import {html} from "lit"; const fn=()=>{throw Error("must not run")}; const child=fn.bind(null); const fixture=html`${child}`;',
    'import {html} from "lit"; const holder={values:[] as unknown[]}; holder.values.push(()=>{throw Error("must not run")}); const fixture=html`${holder.values}`;',
    'import {html} from "lit"; interface Base{child:()=>string} interface Derived extends Base{} function view(props:Derived){return html`${props.child}`;}',
    'import {html} from "lit"; const items=[{label:"ok"}]; items.length=2; const fixture=html`${items.map(item=>html`<span>${item.label}</span>`)}`;',
    'import {html} from "lit"; import {styleMap} from "lit/directives/style-map.js"; function view(color:string){return html`<div style=${styleMap({color})}></div>`;}',
    'import {html} from "lit"; const values:unknown[]=[]; values[0]=()=>{throw Error("must not run")}; const fixture=html`${values}`;',
    'import {html} from "lit"; interface Base{():string} interface Derived extends Base{} function view(child:Derived){return html`${child}`;}',
    'import {html} from "lit"; import {styleMap} from "lit/directives/style-map.js"; let color="red"; color="blue !important"; const fixture=html`<div style=${styleMap({color})}></div>`;',
    'import {html} from "lit"; const value:{child:unknown}={child:""}; value.child=()=>{throw Error("must not run")}; const fixture=html`${value.child}`;',
    'import {html} from "lit"; const holder={get 0(){return ()=>{throw Error("must not run")}}}; const fixture=html`${holder[0]}`;',
    'import {html} from "lit"; interface Bytes extends Uint8Array{} function view(values:Bytes){return html`${values.map(v=>v/2)}`;}',
    'import {html} from "lit"; import {styleMap} from "lit/directives/style-map.js"; function color(){return "red !important"} const fixture=html`<div style=${styleMap({color:color()})}></div>`;',
    'import {html} from "lit"; class Rows{map<T>(fn:(v:string)=>T):T[]{return ["x"].map(fn)}} function view(rows:Rows){return html`${rows.map(v=>html`<b>${v}</b>`)}`;}',
    'import {html} from "lit"; const original=()=>"text"; function view(fn:typeof original){return html`${fn}`;}',
    'import {html} from "lit"; const fixture=html`<div data-user.name="x"></div>`;',
    'import {html} from "lit"; const fixture=html`<div on:click="text"></div>`;',
    'import {html} from "lit"; function view(props:{fn:()=>string}){return html`${props.fn}`;}',
    'import {html} from "lit"; function make():()=>string{return ()=>{throw Error("must not run")}} const fixture=html`${make()}`;',
    'import {html} from "lit"; function make(){return ()=>{throw Error("must not run")}} const alias=make; const fixture=html`${alias()}`;',
    'import {html} from "lit"; const handlers=[()=>{throw Error("must not run")}]; const fixture=html`${handlers[0]}`;',
    'import {html} from "lit"; const listener=()=>{}; listener["once"]=true; const fixture=html`<button @click=${listener}></button>`;',
    'import {html} from "lit"; type Bytes=Uint8Array; function view(values:Bytes){return html`${values.map(value=>value/2)}`;}',
    'import {html} from "lit"; function view(handlers:(()=>string)[]){return html`${handlers[0]}`;}',
    'import {html} from "lit"; function view(props:{values:Uint8Array}){return html`${props.values.map(value=>value/2)}`;}',
    'import {html} from "lit"; import {ifDefined} from "lit/directives/if-defined.js"; const fixture=html`<input type="checkbox" value=${ifDefined(id)}>`;',
    'import {html,nothing} from "lit"; class Host{state:{ready:true;value:string}|{ready:false};render(){return html`${this.state.ready ? this.state.value : nothing}`;}}',
    'import {html} from "lit"; const handlers={click(this:Host){this.increment()}}; const fixture=html`<button @click=${handlers.click}></button>`;',
    'import {html} from "lit"; function view(values:Uint8Array){return html`${values.map(value=>value/2)}`;}',
    'import {html,nothing} from "lit"; class Host { user?:{name:string}; render(){return html`${this.user !== undefined ? this.user.name : nothing}`;} }',
    'import {html} from "lit"; const fixture=html`<button @click=${function(this:Host){this.increment()}}>Go</button>`;',
    'import {html} from "lit"; const values=new Uint8Array([1]); const fixture=html`${values.map(value=>value/2)}`;',
    'import {html} from "lit"; const state={bytes:new Uint8Array([1])}; const fixture=html`${state.bytes.map(value=>value/2)}`;',
    'import {html} from "lit"; class Host{fn=()=>{throw Error("must not run")};render(){return html`${this.fn}`;}}',
    'import {html} from "lit"; const items=[,{label:"ok"}]; const fixture=html`${items.map(item=>html`<span>${item.label}</span>`)}`;',
    'import {html} from "lit"; const fixture=html`<table><tr><td>${value}</td></tr></table>`;',
    'import {html} from "lit"; const fixture=html`<button onclick=${code}>Go</button>`;',
    'import {html} from "lit"; const fixture=html`<input value=${initial} .defaultValue=${fallback}>`;',
    'import {html,nothing} from "lit"; const fixture=html`${obj.format ? (obj.format)() : nothing}`;',
    'import {html} from "lit"; import {ifDefined} from "lit/directives/if-defined.js"; const fixture=html`<option value=${ifDefined(id)}>Fallback</option>`;',
    'import {html} from "lit"; class Host { render(){const listener=this.increment; return html`<button @click=${listener}></button>`;} increment(){} }',
    'import {html} from "lit"; import {styleMap} from "lit/directives/style-map.js"; const color="red !important"; const fixture=html`<div style=${styleMap({color})}></div>`;',
    'import {html,nothing} from "lit"; const fixture=html`${user.admin ? user.name : nothing}`;',
  ])("marks compound directives, listener options, and property discrimination: %s", (input) => {
    const result = convertLitToSolid(input, "manual.ts", parser);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    parser.parseSourceFile("manual.tsx", result.code);
    expect(parser.getSyntacticDiagnostics()).toEqual([]);
  });

  it("keeps escaped-helper markers valid in shorthand and type queries", () => {
    const result = convertLitToSolid(
      'import {classMap} from "lit/directives/class-map.js"; const factories={classMap}; type Factory=typeof classMap;',
      "escape.ts",
      parser,
    );
    expect(result.diagnostics.length).toBeGreaterThan(0);
    parser.parseSourceFile("escape.tsx", result.code);
    expect(parser.getSyntacticDiagnostics()).toEqual([]);
  });

  it("preserves styleMap CSS keys and native default state", () => {
    expectConversion(
      'import {html} from "lit"; import {styleMap} from "lit/directives/style-map.js"; const fixture=html`<input ?checked=${flag} style=${styleMap({backgroundColor: color, msTransform: transform})}>`;',
      '<><input defaultChecked={!!flag} style={{"background-color": color, "-ms-transform": transform}} /></>',
    );
  });

  it("keeps outer narrowing and object shorthand in nested Show branches", () => {
    expectConversion(
      'import {html,nothing} from "lit"; declare function format(value:unknown):string; declare const user:{address?:{city:string}}|undefined; const fixture=html`${user ? html`${user.address ? html`<span>${user.address.city}${format({user})}</span>` : nothing}` : nothing}`;',
      "<><Show when={user} fallback={null}>{(showValue) => <><Show when={showValue().address} fallback={null}>{(_showValue) => <><span>{_showValue().city}{format({user: showValue()})}</span></>}</Show></>}</Show></>",
    );
  });

  it("repairs TSX syntax when globalThis requires manual conversion", () => {
    const result = convertLitToSolid(
      '#!/usr/bin/env node\nimport {html} from "lit"; const globalThis={}; const identity=<T>(x:T)=>x; const value=<string>identity("ok"); const fixture=html`<p>${value}</p>`;',
      "bailout.ts",
      parser,
    );
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.code.startsWith("#!/usr/bin/env node\n")).toBe(true);
    parser.parseSourceFile("bailout.tsx", result.code);
    expect(parser.getSyntacticDiagnostics()).toEqual([]);
  });

  it("keeps hashbangs ahead of generated helpers and validates final TSX", () => {
    const result = expectConversion(
      '#!/usr/bin/env node\nimport {html} from "lit"; const fixture=html`<b>${42n}</b>`;',
      "<><b>{42n}</b></>",
    );
    expect(result.code.startsWith("#!/usr/bin/env node\n")).toBe(true);
    parser.parseSourceFile("hashbang.tsx", result.code);
    expect(parser.getSyntacticDiagnostics()).toEqual([]);
  });

  it("preserves comma operands and bare attribute values", () => {
    expectConversion(
      'import {html} from "lit"; const fixture=html`<div title data-label=${(1,2)}>${(1,2)}</div>`;',
      '<><div title={""} data-label={(1,2)}>{(1,2)}</div></>',
    );
  });

  it("maps remaining multiword native event names", () => {
    expectConversion(
      'import {html} from "lit"; const fixture=html`<video @loadeddata=${loaded} @pointerover=${pointer} @ratechange=${rate} @volumechange=${volume} @transitionrun=${transition} @beforexrselect=${xr}></video>`;',
      "<><video onLoadedData={loaded} onPointerOver={pointer} onRateChange={rate} onVolumeChange={volume} onTransitionRun={transition} onBeforeXRSelect={xr}></video></>",
    );
  });

  it.each([
    '<div title="${name}${nothing}"></div>',
    '<div title="${name}${ifDefined(value)}"></div>',
    "<div @valueChanged=${listener}></div>",
    "<div @click=${this.increment}></div>",
    "<div @click=${(this.increment)}></div>",
    '<div @click=${this["increment"]}></div>',
    "<div ref=${name}></div>",
    "<div @click=${this.increment!}></div>",
    "<div @click=${(this).increment}></div>",
    "<div title=${ready ? label : noChange}></div>",
    "<div/><span>tail</span>",
    "${user && ready ? user.name : nothing}",
  ])("marks unsafe attribute, event, or conditional work: %s", (markup) => {
    const result = convertLitToSolid(
      'import {html,nothing,noChange} from "lit"; import {ifDefined} from "lit/directives/if-defined.js"; const fixture=html`' +
        markup +
        "`;",
      "manual.ts",
      parser,
    );
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.code).toContain("TODO(solid2)");
    parser.parseSourceFile("manual.tsx", result.code);
    expect(parser.getSyntacticDiagnostics()).toEqual([]);
  });

  it.each([false, true, null, undefined, 12, "text"])(
    "preserves ordinary attribute text for %s",
    (value) => {
      const result = convertLitToSolid(
        'import {html} from "lit"; const fixture=html`<div data-value=${value}></div>`;',
        "attribute.ts",
        parser,
      );
      const parsed = parser.parseSourceFile("attribute.tsx", result.code);
      let expression: ts.Expression | undefined;
      const find = (node: ts.Node) => {
        if (
          ts.isJsxAttribute(node) &&
          node.name.getText(parsed) === "data-value" &&
          node.initializer &&
          ts.isJsxExpression(node.initializer)
        ) {
          expression = node.initializer.expression;
        }
        node.forEachChild(find);
      };
      find(parsed);
      if (!expression) {
        throw new Error("Missing generated attribute expression");
      }
      const helpers = stripTypeScriptTypes(
        parsed.statements
          .filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === "attributeValue")
          .map((node) => node.getText(parsed))
          .join("\n"),
      );
      expect(
        runInNewContext(`(()=>{${helpers}; return (${expression.getText(parsed)});})()`, { value }),
      ).toBe(value == null ? "" : String(value));
    },
  );

  it("keeps input attribute defaults separate from live values", () => {
    expectConversion(
      'import {html} from "lit"; const fixture=html`<input value=${name} .value=${liveValue}>`;',
      "<><input defaultValue={name} value={liveValue} /></>",
    );
  });

  it("preserves static input defaults and primitive list reactivity", () => {
    expectConversion(
      'import {html} from "lit"; const items=[{id:"row",label:"row",item:1}]; const fixture=html`<input value="seed" .value=${liveValue}>${items.map((item:{label:string})=>item.label)}`;',
      '<><input defaultValue={"seed"} value={liveValue}/><For each={items} keyed={false}>{item => <>{item().label}</>}</For></>',
    );
  });

  it("marks context-dependent omission, optional guards, and compound styles", () => {
    for (const input of [
      'import {html,nothing} from "lit"; const empty=nothing; const fixture=html`<a href=${empty}>link</a>`;',
      'import {html,nothing} from "lit"; const fixture=html`${user?.address ? html`<span>${user.address.city}</span>` : nothing}`;',
      'import {html} from "lit"; import {styleMap} from "lit/directives/style-map.js"; const fixture=html`<div style="display:block; ${styleMap({color})}"></div>`;',
      'import {html} from "lit"; import {styleMap} from "lit/directives/style-map.js"; const fixture=html`<div style=${styleMap({display: `none !important`})}></div>`;',
    ]) {
      expect(convertLitToSolid(input, "manual.ts", parser).diagnostics.length).toBeGreaterThan(0);
    }
  });

  it("keeps SVG partial links in the SVG namespace", () => {
    expectConversion(
      'import {svg} from "lit"; const fixture=svg`<a href="/target"></a>`;',
      '<><a href={"/target"} xmlns="http://www.w3.org/2000/svg"></a></>',
    );
  });

  it("does not rewrite type-member names as list reads", () => {
    expectConversion(
      'import {html} from "lit"; const items=[{id:"row",label:"row",item:1}]; const fixture=html`${items.map(item=>html`${(item as {item?:number}).item}`)}`;',
      "<><For each={items} keyed={false}>{item=><>{(item() as {item?:number}).item}</>}</For></>",
    );
  });

  it("does not rewrite getter names as list reads", () => {
    expectConversion(
      'import {html} from "lit"; const items=[{id:"row",label:"row",item:1}]; const fixture=html`${items.map(item=>html`<span>${({get item(){return 1}}).item}</span>`)}`;',
      "<><For each={items} keyed={false}>{item=><><span>{({get item(){return 1}}).item}</span></>}</For></>",
    );
  });

  it("preserves manual expressions with TSX-safe type assertions", () => {
    const result = convertLitToSolid(
      'import {html} from "lit"; import {until} from "lit/directives/until.js"; const fixture=html`${until(pending, <string>fallback)}`;',
      "manual.ts",
      parser,
    );
    parser.parseSourceFile("manual.tsx", result.code);
    expect(parser.getSyntacticDiagnostics()).toEqual([]);
    expect(result.code).toContain("fallback as string");
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("marks index-dependent repeat keys", () => {
    const result = convertLitToSolid(
      'import {html} from "lit"; import {repeat} from "lit/directives/repeat.js"; const items=[{id:"row",label:"row",item:1}]; const fixture=html`${repeat(items, (_, index) => index, item => html`${item}`)}`;',
      "key.ts",
      parser,
    );
    expect(result.diagnostics.some((entry) => entry.reason.includes("key signature"))).toBe(true);
  });

  it("leaves same-named non-Lit and shadowed tags alone", () => {
    const input = [
      'import { html } from "lit";',
      'import { svg } from "other-library";',
      "function local(html: (strings: TemplateStringsArray) => string) { return html`<local></local>`; }",
      "const unrelated = svg`<path />`;",
      "const fixture = html`<p>converted</p>`;",
    ].join("\n");
    const result = expectConversion(input, '<><p>{"converted"}</p></>');
    expect(result.code).toContain("return html`<local></local>`");
    expect(result.code).toContain("svg`<path />`");
    expect(result.templates).toBe(1);
  });

  it.each([
    ["keyed", "keyed(identity, html`<span>keep</span>`)"],
    ["live", "live(value)"],
    ["guard", "guard([value], render)"],
    ["cache", "cache(value)"],
    ["until", "until(pending, fallback)"],
    ["unsafeHTML", "unsafeHTML(value)"],
    ["asyncAppend", "asyncAppend(stream)"],
    ["asyncReplace", "asyncReplace(stream)"],
  ])("marks %s without discarding its expression", (name, expression) => {
    const module = name.replace(/([a-z])([A-Z])/gu, "$1-$2").toLowerCase();
    const input = `import { html } from "lit"; import { ${name} } from "lit/directives/${module}.js"; const fixture = html\`<div>\${${expression}}</div>\`;`;
    const result = convertLitToSolid(input, "manual.ts", parser);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ reason: expect.stringContaining(name) }),
    ]);
    expect(result.code).toContain("TODO(solid2)");
    expect(result.code).toContain(expression);
    parser.parseSourceFile("manual.tsx", result.code);
    expect(parser.getSyntacticDiagnostics("manual.tsx")).toEqual([]);
  });

  it.each([
    ["class Host { connectedCallback() {} }", "lifecycle connectedCallback"],
    ['import { Task } from "@lit/task"; const task = new Task(host, options);', "Task lifecycle"],
    ["class Store implements ReactiveController { hostConnected() {} }", "controller lifetime"],
    ["const cancel = new AbortController();", "cancellation authority"],
    [
      'import { html } from "lit"; const fixture = html`<div ${customDirective(value)}></div>`;',
      "directive",
    ],
  ])("marks ownership work: %s", (input, reason) => {
    const result = convertLitToSolid(input, "ownership.ts", parser);
    expect(result.diagnostics.some((entry) => entry.reason.includes(reason))).toBe(true);
    expect(result.code).toContain("TODO(solid2)");
  });
});
