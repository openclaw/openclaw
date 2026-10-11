import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../../scripts/check-control-ui-lit-ratchet.mts";
import { countMigrationSources } from "../../scripts/control-ui-solid-inventory.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function git(cwd: string, args: string[]) {
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], {
    cwd,
    env: createNestedGitEnv(),
    stdio: "ignore",
  });
}

const legacy = [
  'import { html as markup } from "lit";',
  'import { state as reactiveState } from "lit/decorators.js";',
  'import { Task as LitTask } from "@lit/task";',
  "class View { @reactiveState() value = 0; render() { this.requestUpdate(); return markup`<wa-button />`; } task = new LitTask(this, {}); }",
  "// TODO(solid2): migrate this view",
].join("\n");

describe("Control UI Lit ratchet", () => {
  it("excepts only the bridge test's Lit imports/templates, with a reason and no sibling allowance", () => {
    const root = tempDirs.make("openclaw-lit-interop-");
    const directory = path.join(root, "ui/src/lit");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "plain.ts"), "export {};\n");
    for (const args of [["init"], ["add", "."], ["commit", "-m", "base"]]) {
      git(root, args);
    }
    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    const fixture = 'import { html } from "lit"; export const view = html`<div />`;';
    const exception = path.join(directory, "solid-bridge.test.tsx");
    fs.writeFileSync(exception, fixture);
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    expect(logs.join("\n")).toContain("litImports=1, htmlTemplates=1");
    expect(logs.join("\n")).toContain("deleted with the bridge at cutover");

    fs.writeFileSync(path.join(directory, "solid-bridge-other.test.tsx"), fixture);
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(errors.join("\n")).toContain("solid-bridge-other.test.tsx [litImports]: 1 > 0");
    fs.unlinkSync(path.join(directory, "solid-bridge-other.test.tsx"));
    fs.appendFileSync(exception, "\nexport const extra = <wa-button />;");
    errors.length = 0;
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(errors.join("\n")).toContain("solid-bridge.test.tsx [waTags]: 1 > 0");
  });

  it("preserves staged and explicit base scope through the full lint entry point", () => {
    const root = tempDirs.make("openclaw-lit-full-lint-");
    const source = path.join(root, "ui/src/view.ts");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "export {};\n");
    for (const args of [["init"], ["add", "."], ["commit", "-m", "base"], ["tag", "baseline"]]) {
      git(root, args);
    }
    const runLint = (args: string[]) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          path.resolve("scripts/tsx.mjs"),
          path.resolve("scripts/run-lint.mts"),
          ...args,
        ],
        {
          cwd: root,
          env: { ...createNestedGitEnv(), CHECKOUT_BASE_SHA: "HEAD" },
          encoding: "utf8",
        },
      );

    fs.writeFileSync(source, legacy);
    git(root, ["add", "."]);
    fs.writeFileSync(source, "export {};\n");
    const staged = runLint(["--staged", "--only=extensions"]);
    expect(staged.error).toBeUndefined();
    expect(staged.status, staged.stderr).toBe(1);
    expect(staged.stderr).toContain("litImports: 3 > 0");

    git(root, ["commit", "-m", "existing Lit"]);
    fs.writeFileSync(source, legacy);
    const based = runLint(["--base", "baseline", "--only=extensions"]);
    expect(based.error).toBeUndefined();
    expect(based.status, based.stderr).toBe(1);
    expect(based.stderr).toContain("litImports: 3 > 0");
  });

  it("recognizes Lit syntax and aliases without counting commented code", () => {
    const counts = countMigrationSources(
      process.cwd(),
      new Map([
        ["view.ts", legacy],
        [
          "view.tsx",
          'import * as Lit from "lit"; const view = Lit.html`<wa-button>${Lit.html`<wa-icon />`}</wa-button>`; const jsx = <wa-switch />;',
        ],
        [
          "plain.ts",
          '// import { html } from "lit"; new Task(); html`<wa-button>`\nconst text = "this.requestUpdate(); @state()"; const [, next] = values; function pick([, entry]) { return entry; }',
        ],
        [
          "imports.ts",
          'const modules = [import(`lit`), require(`@lit/task`), import((("lit"))), require((`@lit/task`)), import(("lit" as const)), require(("lit" satisfies string)), import("lit"!), require(<string>"lit")];',
        ],
        [
          "parentheses.ts",
          'import { html as markup } from "lit"; import { state as mark } from "lit/decorators.js"; const view = (markup)`<div />`; (this.requestUpdate)(); class C { @(mark()) value = 0; }',
        ],
        ["import-equals.cts", 'import Lit = require("lit");'],
        [
          "controllers.ts",
          'import type { ReactiveController as Controller } from "lit"; import { Directive as BaseDirective } from "lit/directive.js"; class C implements Controller {} class D extends BaseDirective {}',
        ],
        [
          "commonjs.cts",
          'const Lit = require("lit"); const { html: markup } = Lit; const draw = markup; const { state: mark } = require("lit/decorators.js"); const { Task: Work } = require("@lit/task"); class C { @mark() value = 0; work = new Work(this, {}); render() { return draw`<div />`; } }',
        ],
      ]),
    );
    expect(counts.get("view.ts")).toMatchObject({
      litImports: 3,
      htmlTemplates: 1,
      waTags: 1,
      requestUpdate: 1,
      stateDecorators: 1,
      tasks: 1,
      todoSolid2: 1,
    });
    expect(counts.get("view.tsx")).toMatchObject({ litImports: 1, htmlTemplates: 2, waTags: 3 });
    expect(counts.get("imports.ts")).toMatchObject({ litImports: 8 });
    expect(counts.get("parentheses.ts")).toMatchObject({
      htmlTemplates: 1,
      requestUpdate: 1,
      stateDecorators: 1,
    });
    expect(counts.get("import-equals.cts")).toMatchObject({ litImports: 1 });
    expect(counts.get("controllers.ts")).toMatchObject({ reactiveControllers: 1, directives: 1 });
    expect(counts.get("commonjs.cts")).toMatchObject({
      litImports: 3,
      htmlTemplates: 1,
      stateDecorators: 1,
      tasks: 1,
    });
    expect(counts.get("plain.ts")).toMatchObject({
      litImports: 0,
      htmlTemplates: 0,
      waTags: 0,
      requestUpdate: 0,
      stateDecorators: 0,
      tasks: 0,
    });
  });

  it("passes shrinkage, rejects each growing metric and unoffset new Lit files, and reads staged bytes", () => {
    const root = tempDirs.make("openclaw-lit-ratchet-");
    const sourcePath = path.join(root, "ui/src/view.ts");
    const commonjsPath = path.join(root, "ui/src/legacy.cts");
    const commonjs = 'const { html: markup } = require("lit");';
    const namespacePath = path.join(root, "ui/src/namespace.ts");
    const namespace = 'import { svg as html } from "lit"; import * as Lit from "lit";';
    const scopedPath = path.join(root, "ui/src/scoped.ts");
    const scoped =
      'import * as Lit from "lit"; function render() { const template = Lit.html; return template`<div />`; }';
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, legacy);
    fs.writeFileSync(commonjsPath, commonjs);
    fs.writeFileSync(namespacePath, namespace);
    fs.writeFileSync(scopedPath, scoped);
    for (const args of [["init"], ["add", "."], ["commit", "-m", "base"]]) {
      git(root, args);
    }
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    fs.writeFileSync(commonjsPath, commonjs + "\nconst view = markup`<div />`;");
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(errors.join("\n")).toContain("ui/src/legacy.cts [htmlTemplates]: 1 > 0");
    fs.writeFileSync(commonjsPath, commonjs);
    fs.writeFileSync(namespacePath, namespace + "\nconst view = Lit.html`<div />`;");
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(errors.join("\n")).toContain("ui/src/namespace.ts [htmlTemplates]: 1 > 0");
    fs.writeFileSync(namespacePath, namespace);
    fs.writeFileSync(
      scopedPath,
      scoped.replace("return template`<div />`", "return [template`<div />`, template`<span />`]") +
        "\nfunction icon() { const template = Lit.svg; return template`<circle />`; }",
    );
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(errors.join("\n")).toContain("ui/src/scoped.ts [htmlTemplates]: 2 > 1");
    fs.writeFileSync(scopedPath, scoped);
    fs.writeFileSync(sourcePath, "export {};\n");
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    for (const [addition, metric] of [
      ['import "lit/directive.js";', "litImports"],
      ["const extra = markup`<div />`;", "htmlTemplates"],
      ["const extra = (markup)`<div />`;", "htmlTemplates"],
      ["const extra = markup`<wa-icon />`;", "waTags"],
      ["view.requestUpdate();", "requestUpdate"],
      ["(view.requestUpdate)();", "requestUpdate"],
      ["class Extra { @reactiveState() value = 0; }", "stateDecorators"],
      ["class Extra { @(reactiveState()) value = 0; }", "stateDecorators"],
      ["new LitTask(view, {});", "tasks"],
      ["// TODO(solid2): extra", "todoSolid2"],
    ]) {
      fs.writeFileSync(sourcePath, `${legacy}\n${addition}\n`);
      errors.length = 0;
      expect(main(root, ["--base", "HEAD"]), metric).toBe(1);
      expect(errors.join("\n")).toContain(`ui/src/view.ts [${metric}]`);
    }
    expect(main(root, ["--staged"])).toBe(0);
    git(root, ["add", "."]);
    fs.writeFileSync(sourcePath, legacy);
    expect(main(root, ["--staged"])).toBe(1);
    git(root, ["add", "."]);
    const newPath = path.join(root, "ui/src/new.test.tsx");
    for (const source of [
      'export { html } from "lit";',
      "export const lib = import(`lit`);",
      'export const lib = import((("lit")));',
      'export const lib = require(("lit" as const));',
      'import "@lit-labs/scoped-registry-mixin";',
    ]) {
      fs.writeFileSync(newPath, source);
      errors.length = 0;
      expect(main(root, ["--base", "HEAD"])).toBe(1);
      expect(errors.join("\n")).toContain("ui/src/new.test.tsx [litImports]: 1 > 0");
    }
    fs.writeFileSync(newPath, "export const view = <div />;\n");
    expect(main(root, ["--base", "HEAD"])).toBe(0);
  });

  it("allows splits and renames while rejecting net template and TODO growth", () => {
    const root = tempDirs.make("openclaw-lit-moves-");
    const original = path.join(root, "ui/src/view.ts");
    const split = path.join(root, "ui/src/part.ts");
    const renamed = path.join(root, "ui/src/renamed.ts");
    const part = 'import { html as second } from "lit"; export const other = second`<wa-icon />`;';
    fs.mkdirSync(path.dirname(original), { recursive: true });
    fs.writeFileSync(original, `${legacy}\n${part}`);
    for (const args of [["init"], ["add", "."], ["commit", "-m", "base"]]) {
      git(root, args);
    }
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    vi.spyOn(console, "log").mockImplementation(() => {});

    fs.writeFileSync(original, legacy);
    fs.writeFileSync(split, part);
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    git(root, ["add", "."]);
    expect(main(root, ["--staged"])).toBe(0);

    fs.renameSync(original, renamed);
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    git(root, ["add", "-A"]);
    expect(main(root, ["--staged"])).toBe(0);

    fs.appendFileSync(renamed, "\nconst extra = markup`<div />`;");
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(errors.join("\n")).toContain("htmlTemplates: 3 > 2");
    expect(errors.join("\n")).toContain("ui/src/renamed.ts [htmlTemplates]: 2 > 0");

    fs.writeFileSync(renamed, legacy);
    fs.appendFileSync(split, "\n// TODO(solid2): finish migration");
    errors.length = 0;
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(errors.join("\n")).toContain("todoSolid2: 2 > 1");
  });
});
