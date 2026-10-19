import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../../scripts/check-control-ui-controllers.mts";
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

function fixture(source = "export {};\n") {
  const root = tempDirs.make("openclaw-controller-guard-");
  fs.mkdirSync(path.join(root, "ui/src"), { recursive: true });
  fs.writeFileSync(path.join(root, "ui/src/view.ts"), source);
  fs.mkdirSync(path.join(root, "config"));
  for (const pattern of ["createEffect", "untrack", "addEventListener", "querySelector"]) {
    fs.writeFileSync(path.join(root, `config/control-ui-${pattern}-baseline.txt`), "");
  }
  for (const args of [["init"], ["add", "."], ["commit", "-m", "base"]]) {
    git(root, args);
  }
  return root;
}

function runLint(root: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", path.resolve("scripts/tsx.mjs"), path.resolve("scripts/run-lint.mts"), ...args],
    {
      cwd: root,
      env: createNestedGitEnv(),
      encoding: "utf8",
    },
  );
}

describe("Control UI controller guard", () => {
  it.each([
    'import { createRenderEffect as render } from "solid-js"; render(() => 1, () => {});',
    'import * as solid from "solid-js"; solid.createRenderEffect(() => 1, () => {});',
    'element["addEventListener"]("click", handler);',
    'element?.querySelector<HTMLElement>("button");',
    'element[`querySelectorAll`]("button");',
  ])("rejects forbidden production call syntax: %s", (source) => {
    const root = fixture();
    fs.writeFileSync(path.join(root, "ui/src/new.tsx"), source);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(root, [])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain("ui/src/new.tsx:1");
    expect(errors.mock.calls.flat().join("\n")).toContain("refactor-checklist.md");
  });

  it("excludes test helpers, comments, and strings; permits primitive render effects", () => {
    const root = fixture('// createEffect(() => {});\nconst example = "element.querySelector()";');
    fs.mkdirSync(path.join(root, "ui/src/lib/reactive"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "ui/src/lib/reactive/binding.ts"),
      "createRenderEffect(read, write);",
    );
    for (const name of ["view.test.tsx", "view.test-helpers.ts", "view.test-support.ts"]) {
      fs.writeFileSync(
        path.join(root, "ui/src", name),
        "element.querySelector('button'); element.addEventListener('click', fn);",
      );
    }
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(root, [])).toBe(0);
  });

  it.each([
    [
      "createEffect",
      "ui/src/view.ts",
      'import { createEffect as effect } from "solid-js"; effect(read, write);',
    ],
    ["untrack", "ui/src/view.ts", "untrack(read);"],
    ["addEventListener", "ui/src/view.ts", "signal.addEventListener('abort', done);"],
    ["querySelector", "ui/src/components/markdown.ts", "root.querySelectorAll<HTMLElement>('a');"],
  ])("ratchets %s per file and rejects allowance inflation", (pattern, file, source) => {
    const root = fixture();
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
    const baseline = path.join(root, `config/control-ui-${pattern}-baseline.txt`);
    fs.writeFileSync(baseline, `${file}\t1\n`);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "existing debt"]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(root, [])).toBe(0);
    const addedCall = pattern === "createEffect" ? "effect(read, write);" : source;
    fs.writeFileSync(target, `${source}\n${addedCall}`);
    fs.writeFileSync(baseline, `${file}\t2\n`);
    expect(main(root, [])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain("allowances must not increase");
    fs.writeFileSync(baseline, `${file}\t1\n`);
    fs.writeFileSync(target, "export {};\n");
    expect(main(root, [])).toBe(1);
    expect(main(root, ["--prune"])).toBe(0);
    expect(fs.readFileSync(baseline, "utf8")).not.toContain(`${file}\t`);
    fs.writeFileSync(target, source);
    expect(main(root, [])).toBe(1);
  });

  it("checks staged Solid debt instead of the working tree", () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, "ui/src/view.ts"), "createEffect(read, write);");
    git(root, ["add", "."]);
    fs.writeFileSync(path.join(root, "ui/src/view.ts"), "export {};\n");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(root, ["--staged"])).toBe(1);
    expect(main(root, [])).toBe(0);
  });

  it.each(["./lib/reactive/solid-controller-host.ts", "./lib/subscriptions-controller.ts"])(
    "rejects existing and new production or test consumers of retired %s",
    (module) => {
      const root = fixture(`import "${module}";\n`);
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(main(root, [])).toBe(1);
      fs.writeFileSync(path.join(root, "ui/src/view.ts"), "export {};\n");
      for (const name of ["new.ts", "new.test.ts"]) {
        const target = path.join(root, "ui/src", name);
        for (const source of [
          `import type { LegacyHost } from "${module}";`,
          `export { LegacyHost } from "${module}";`,
          `const load = () => import("${module}");`,
          `const load = () => import(\`${module}\`);`,
          `type Host = import("${module}").LegacyHost;`,
        ]) {
          fs.writeFileSync(target, source);
          expect(main(root, []), source).toBe(1);
        }
        fs.writeFileSync(target, `// import "${module}";\nconst example = "${module}";\n`);
      }
      expect(main(root, [])).toBe(0);
    },
  );

  it.each([
    "ui/src/lib/reactive/solid-controller-host.ts",
    "ui/src/lib/subscriptions-controller.ts",
  ])("rejects restoring retired %s without an importer", (file) => {
    const root = fixture("export {};\n");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "export {};\n");
    expect(main(root, [])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain(file);
  });

  it("rejects retired host contracts under other production or test paths", () => {
    const root = fixture("export {};\n");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const name of ["replacement.ts", "replacement.test.ts"]) {
      const file = `ui/src/${name}`;
      const target = path.join(root, file);
      for (const source of [
        "export interface SolidController {}",
        "export interface SolidControllerHost {}",
        "interface ReplacementHost { addController(controller: unknown): void }",
        "const retire = (host: { removeController(): void }) => host.removeController();",
        'import type { SolidController as LegacyController } from "./other.ts";',
        'import type { LegacyHost as SolidControllerHost } from "./other.ts";',
        'type Host = import("./other.ts").SolidControllerHost;',
      ]) {
        errors.mockClear();
        fs.writeFileSync(target, source);
        expect(main(root, []), source).toBe(1);
        expect(errors.mock.calls.flat().join("\n")).toContain(file);
      }
      fs.writeFileSync(
        target,
        '// interface SolidController {}\nconst example = "SolidControllerHost";\ninterface SolidControllerOptions {}\n',
      );
    }
    expect(main(root, [])).toBe(0);
  });

  it.each([
    "class NewController {}",
    "const Controller = class NewController {};",
    "const host = { hostConnected() {} };",
    "const host = { hostDisconnected() {} };",
  ])("rejects existing controller patterns without a migration baseline: %s", (source) => {
    const root = fixture(source);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(root, []), source).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain("ui/src/view.ts");
    fs.writeFileSync(path.join(root, "ui/src/view.ts"), "export {};\n");
    expect(main(root, [])).toBe(0);
  });

  it("ignores examples and test-only lifecycle/class patterns", () => {
    const root = fixture('// class OldController {}\nconst text = "hostConnected";\n');
    fs.writeFileSync(
      path.join(root, "ui/src/view.test.ts"),
      "class TestController { hostDisconnected() {} }\n",
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(root, [])).toBe(0);
  });

  it("rejects redraw contracts in production and tests independently of controller retirement", () => {
    const root = fixture();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const name of ["new.tsx", "new.test.tsx"]) {
      const target = path.join(root, "ui/src", name);
      for (const source of [
        "interface Host { requestUpdate(): void }",
        "host.requestUpdate?.();",
        'host["requestUpdate"]();',
        'vi.spyOn(host, "requestUpdate");',
      ]) {
        errors.mockClear();
        fs.writeFileSync(target, source);
        expect(main(root, []), source).toBe(1);
        expect(errors.mock.calls.flat().join("\n")).toContain(`ui/src/${name}`);
      }
      fs.writeFileSync(
        target,
        '// requestUpdate() is retired.\nconst text = "Use signals instead of requestUpdate.";\n',
      );
    }
    expect(main(root, [])).toBe(0);
  });

  it("preserves staged scope through the full lint entry point", () => {
    const root = fixture();
    const source = path.join(root, "ui/src/new.ts");
    fs.writeFileSync(source, "class NewController {}\n");
    git(root, ["add", "."]);
    fs.writeFileSync(source, "export {};\n");
    const staged = runLint(root, ["--staged", "--only=extensions"]);
    expect(staged.error).toBeUndefined();
    expect(staged.status, staged.stderr).toBe(1);
    expect(staged.stderr).toContain("ui/src/new.ts");
  });

  it("checks current source in a shallow checkout without base history", () => {
    const source = fixture();
    const root = tempDirs.make("openclaw-controller-shallow-");
    git(root, ["clone", "--depth=1", pathToFileURL(source).href, "."]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(root, [])).toBe(0);
    fs.writeFileSync(path.join(root, "ui/src/new.ts"), "class NewController {}\n");
    expect(main(root, [])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain("ui/src/new.ts");
  });
});
