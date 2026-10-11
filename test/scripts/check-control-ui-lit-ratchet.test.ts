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

function fixture(source = "export {};\n") {
  const root = tempDirs.make("openclaw-lit-ratchet-");
  fs.mkdirSync(path.join(root, "ui/src"), { recursive: true });
  fs.writeFileSync(path.join(root, "ui/src/view.ts"), source);
  for (const args of [["init"], ["add", "."], ["commit", "-m", "base"]]) {
    git(root, args);
  }
  return root;
}

describe("Control UI Lit ratchet", () => {
  it.each(["new.ts", "new.tsx", "new.js", "new.cts"])(
    "rejects a new Lit production file: %s",
    (file) => {
      const root = fixture();
      fs.writeFileSync(path.join(root, "ui/src", file), legacy);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      expect(main(root, ["--base", "HEAD"])).toBe(1);
      expect(errors.mock.calls.flat().join("\n")).toContain(`ui/src/${file}`);
      expect(errors.mock.calls.flat().join("\n")).toContain(".agents/skills/solid/SKILL.md");
      expect(errors.mock.calls.flat().join("\n")).toContain("defineSolidBridge");
    },
  );

  it("preserves staged and explicit base scope through the full lint entry point", () => {
    const root = fixture();
    git(root, ["tag", "baseline"]);
    const source = path.join(root, "ui/src/new.ts");
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
    expect(staged.stderr).toContain("ui/src/new.ts");
    git(root, ["commit", "-m", "new Lit"]);
    fs.writeFileSync(source, legacy);
    const based = runLint(["--base", "baseline", "--only=extensions"]);
    expect(based.error).toBeUndefined();
    expect(based.status, based.stderr).toBe(1);
    expect(based.stderr).toContain("ui/src/new.ts");
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

  it("reports every metric's growth in an existing file without failing", () => {
    const root = fixture(legacy);
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    fs.writeFileSync(path.join(root, "ui/src/view.ts"), `${legacy}\n${legacy}`);
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    const report = logs.mock.calls.flat().join("\n");
    expect(report).toContain("totals (advisory)");
    expect(report).toContain("Per-file increases (advisory)");
    for (const metric of [
      "litImports",
      "htmlTemplates",
      "waTags",
      "requestUpdate",
      "stateDecorators",
      "tasks",
      "todoSolid2",
    ]) {
      expect(report).toContain(`ui/src/view.ts [${metric}]`);
    }
  });

  it.each([
    "new.test.ts",
    "lit/solid-bridge.test.tsx",
    "new.test-support.ts",
    "new-test-support.ts",
    "new-test-harness.ts",
    "test-helpers/view.ts",
  ])("exempts new Lit tests: %s", (file) => {
    const root = fixture();
    const target = path.join(root, "ui/src", file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, legacy);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(root, ["--base", "HEAD"])).toBe(0);
  });

  it("allows splits and renames in working and staged sources, including metric growth", () => {
    const part = 'import { html } from "lit"; export const other = html`<wa-icon />`;';
    const root = fixture(`${legacy}\n${part}`);
    const original = path.join(root, "ui/src/view.ts");
    const renamed = path.join(root, "ui/src/renamed.ts");
    fs.writeFileSync(original, legacy);
    fs.writeFileSync(path.join(root, "ui/src/part.ts"), part);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    git(root, ["add", "."]);
    expect(main(root, ["--staged"])).toBe(0);
    fs.renameSync(original, renamed);
    fs.appendFileSync(
      renamed,
      "\nconst extra = markup`<div />`;\n// TODO(solid2): finish migration",
    );
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    git(root, ["add", "-A"]);
    expect(main(root, ["--staged"])).toBe(0);
  });

  it.each(['import { html as markup } from "lit";', 'const { html: markup } = require("lit");'])(
    "does not mistake import boilerplate for a moved implementation: %s",
    (load) => {
      const root = fixture(`${load} export const old = markup\`<div>Old</div>\`;`);
      fs.writeFileSync(path.join(root, "ui/src/view.ts"), "export {};\n");
      fs.writeFileSync(path.join(root, "ui/src/new.ts"), `${load} markup\`New\`;`);
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(main(root, ["--base", "HEAD"])).toBe(1);
    },
  );

  it("exempts new Solid files and rejects all Lit module families", () => {
    const root = fixture();
    const target = path.join(root, "ui/src/new.tsx");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    fs.writeFileSync(target, "export const view = <div />;\n");
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    for (const source of [
      'export { html } from "lit";',
      'import "lit/directive.js";',
      'export const lib = import("@lit/task");',
      'import "@lit-labs/scoped-registry-mixin";',
    ]) {
      fs.writeFileSync(target, source);
      expect(main(root, ["--base", "HEAD"]), source).toBe(1);
    }
  });
});
