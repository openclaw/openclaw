import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../scripts/check-control-ui-controllers.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const errors = vi.fn();
beforeEach(() => {
  errors.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(errors);
});
afterEach(() => vi.restoreAllMocks());

function write(root: string, file: string, source: string) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
}

function git(cwd: string, args: string[]) {
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], {
    cwd,
    env: createNestedGitEnv(),
    stdio: "ignore",
  });
}

function fixture(source = "export {};\n") {
  const root = tempDirs.make("openclaw-controller-guard-");
  write(root, "ui/src/view.ts", source);
  for (const pattern of [
    "createEffect",
    "untrack",
    "addEventListener",
    "querySelector",
    "flush",
    "getOwner",
    "runWithOwner",
    "onCleanup",
    "manualImport",
  ]) {
    for (const surface of ["control-ui", "plugin-ui"]) {
      write(root, `config/${surface}-${pattern}-baseline.txt`, "");
    }
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
    "extensions/workboard/browser/page.tsx",
    "extensions/memory-core/browser/page.tsx",
    "extensions/nostr/browser/page.tsx",
    "extensions/whatsapp/browser/page.tsx",
    "extensions/clawrouter/src/control-ui.tsx",
    "extensions/x/src/control-ui.tsx",
  ])("rejects forbidden Solid patterns in the plugin view %s", (file) => {
    const root = fixture();
    write(root, file, 'element.addEventListener("click", handler);');
    expect(main(root, [])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain(`${file}:1`);
  });

  it("ratchets plugin helpers separately from host and other plugin allowances, including staged source", () => {
    const root = fixture();
    const file = "extensions/nostr/browser/lifetime.ts";
    const baseline = "config/plugin-ui-onCleanup-baseline.txt";
    const source = 'import { onCleanup } from "solid-js"; onCleanup(dispose);';
    write(root, file, source);
    write(root, baseline, `${file}\t1\n`);
    // Backend owners and test helpers are outside the browser-view guard.
    write(root, "extensions/nostr/src/server.ts", 'element.querySelector("button");');
    write(root, "extensions/nostr/browser/profile.test.tsx", source);
    write(root, "extensions/workboard/browser/test/dom-host.ts", source);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "existing plugin integration"]);
    expect(main(root, [])).toBe(0);
    write(root, file, `${source}\nonCleanup(dispose);`);
    write(root, baseline, `${file}\t2\n`);
    expect(main(root, [])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "Plugin UI onCleanup allowances must not increase",
    );
    write(root, baseline, `${file}\t1\n`);
    git(root, ["add", "."]);
    write(root, file, source);
    expect(main(root, ["--staged"])).toBe(1);
    expect(main(root, [])).toBe(0);
    write(root, "extensions/whatsapp/browser/lifetime.ts", source);
    expect(main(root, [])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "extensions/whatsapp/browser/lifetime.ts: 1 > 0",
    );
    write(root, "extensions/whatsapp/browser/lifetime.ts", "export {};\n");
    write(root, file, "export {};\n");
    expect(main(root, ["--prune"])).toBe(0);
    expect(fs.readFileSync(path.join(root, baseline), "utf8")).not.toContain(`${file}\t`);
  });

  it.each([
    'import { createRenderEffect as render } from "solid-js"; render(() => 1, () => {});',
    'import * as solid from "solid-js"; solid.createRenderEffect(() => 1, () => {});',
    'element["addEventListener"]("click", handler);',
    'element?.querySelector<HTMLElement>("button");',
    'element[`querySelectorAll`]("button");',
    'import { createComponent as render } from "solid-js"; render(View, {});',
    'import * as solid from "solid-js"; solid["createComponent"]?.(View, {});',
    "const view = <div classList={{ active: true }} />;",
    "const view = <div {...{ classList: { active: true } }} />;",
    "const view = <div {...{ classList }} />;",
  ])("rejects forbidden production call syntax: %s", (source) => {
    const root = fixture();
    write(root, "ui/src/new.tsx", source);
    expect(main(root, [])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain("ui/src/new.tsx:1");
    expect(errors.mock.calls.flat().join("\n")).toContain("refactor-checklist.md");
  });

  it("excludes test helpers, comments, and strings; permits primitive render effects", () => {
    const root = fixture('// createEffect(() => {});\nconst example = "element.querySelector()";');
    write(root, "ui/src/lib/reactive/binding.ts", "createRenderEffect(read, write);");
    for (const name of [
      "view.test.tsx",
      "view.test-helpers.ts",
      "view.test-support.ts",
      "view.test-harness.ts",
    ]) {
      write(
        root,
        `ui/src/${name}`,
        'import { createComponent, onCleanup } from "solid-js"; createComponent(View, {}); onCleanup(dispose); const view = <div classList={{ active: true }} />; element.querySelector("button");',
      );
    }
    expect(main(root, [])).toBe(0);
  });

  it.each([
    ["untrack", "ui/src/view.ts", "untrack(read);"],
    ["querySelector", "ui/src/components/markdown.ts", "root.querySelectorAll('a');"],
  ])("ratchets %s allowances and prunes resolved debt", (pattern, file, source) => {
    const root = fixture();
    write(root, file, source);
    const baseline = path.join(root, `config/control-ui-${pattern}-baseline.txt`);
    fs.writeFileSync(baseline, `${file}\t1\n`);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "existing debt"]);
    expect(main(root, [])).toBe(0);
    write(root, file, `${source}\n${source}`);
    fs.writeFileSync(baseline, `${file}\t2\n`);
    expect(main(root, [])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain("allowances must not increase");
    fs.writeFileSync(baseline, `${file}\t1\n`);
    write(root, file, "export {};\n");
    expect(main(root, [])).toBe(1);
    expect(main(root, ["--prune"])).toBe(0);
    expect(fs.readFileSync(baseline, "utf8")).not.toContain(`${file}\t`);
    write(root, file, source);
    expect(main(root, [])).toBe(1);
  });

  it("permits the remaining context factory, native classList, and unrelated factory names", () => {
    const root = fixture();
    write(
      root,
      "ui/src/lib/reactive/context.ts",
      'import { createComponent } from "solid-js"; createComponent(Context, props);',
    );
    write(
      root,
      "ui/src/view.tsx",
      [
        'import { createComponent as render } from "./factory.ts";',
        'import { createComponent } from "solid-js";',
        'render(View, {}); element.classList.toggle("active");',
        "function local(createComponent: any) { createComponent(View, {}); }",
        "// <div classList={{ active: true }} />",
      ].join("\n"),
    );
    expect(main(root, [])).toBe(0);
  });

  it("ratchets view lifetime cleanup but permits computation cleanup and reactive primitives", () => {
    const root = fixture();
    const source = [
      'import { onCleanup as cleanup, createMemo as memo, createEffect as effect, createStore } from "solid-js";',
      'import * as solid from "@solidjs/signals";',
      "memo(() => { cleanup(dispose); return read(); });",
      "effect(() => { solid.onCleanup(dispose); return read(); }, apply);",
      "createStore((draft) => { cleanup(dispose); draft.value = read(); });",
      "memo((() => { cleanup(dispose); return read(); }));",
      "function local(cleanup: any) { cleanup(dispose); }",
    ].join("\n");
    write(root, "ui/src/view.tsx", source);
    write(
      root,
      "ui/src/lib/reactive/resource.ts",
      'import { onCleanup } from "solid-js"; onCleanup(dispose);',
    );
    write(root, "config/control-ui-createEffect-baseline.txt", "ui/src/view.tsx\t1\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "existing effect"]);
    expect(main(root, [])).toBe(0);
    write(root, "ui/src/view.tsx", source + "\ncleanup(dispose);");
    expect(main(root, [])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain("onCleanup calls must not increase");
    errors.mockClear();
    write(
      root,
      "ui/src/view.tsx",
      source.replace(
        "effect(() => { solid.onCleanup(dispose); return read(); }, apply);",
        "effect(read, () => { cleanup(dispose); });",
      ),
    );
    expect(main(root, [])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain("onCleanup calls must not increase");
  });

  it("ratchets stored import loaders while preserving lazy components, route loaders, and utility reads", () => {
    const root = fixture();
    const file = "ui/src/pages/view.tsx";
    const source = [
      'import { lazy as deferred } from "solid-js";',
      'const Panel = deferred(() => import("./panel.tsx"));',
      'const AsyncPanel = deferred(async () => { const module = await import("./panel.tsx"); return module; });',
      'const route = { component: () => import("./page.tsx") };',
      'async function command() { const { save } = await import("./save.ts"); await save(); }',
      'type Module = typeof import("./panel.tsx");',
    ].join("\n");
    write(root, file, source);
    write(
      root,
      "ui/src/pages/route.tsx",
      'const route = { component: async () => { const entry = await import("./page.tsx"); await entry.Page.preload(); return entry; } };',
    );
    expect(main(root, [])).toBe(0);
    for (const loader of [
      'let loaded; loaded = import("./panel.tsx").then(module => { setPanel(module.Panel); });',
      'async function load() { setPanel(await import("./panel.tsx")); }',
      'import("./panel.tsx").then(module => { state.panel = module.Panel; });',
      'function load() { return import("./panel.tsx").then(module => setPanel(module.Panel)); }',
      'const panel = cached ?? await import("./panel.tsx");',
      'const panel = cached || await import("./panel.tsx");',
      'async function load() { const { Panel } = await import("./panel.tsx"); setPanel(Panel); }',
    ]) {
      errors.mockClear();
      write(root, file, source + "\n" + loader);
      expect(main(root, []), loader).toBe(1);
      expect(errors.mock.calls.flat().join("\n")).toContain("manualImport calls must not increase");
    }
  });

  it.each(["flush", "getOwner", "runWithOwner"])(
    "ratchets imported %s aliases and namespace calls only",
    (pattern) => {
      const source = [
        `import { ${pattern} as action } from "solid-js";`,
        'import * as signals from "@solidjs/signals";',
        "action<number>();",
        `signals.${pattern}?.();`,
        `signals["${pattern}"]();`,
      ].join("\n");
      const root = fixture(source);
      const baseline = path.join(root, `config/control-ui-${pattern}-baseline.txt`);
      fs.writeFileSync(baseline, "ui/src/view.ts\t3\n");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "existing Solid calls"]);
      expect(main(root, [])).toBe(0);
      fs.appendFileSync(path.join(root, "ui/src/view.ts"), "\naction();\n");
      expect(main(root, [])).toBe(1);
      expect(errors.mock.calls.flat().join("\n")).toContain(`${pattern} calls must not increase`);
    },
  );

  it.each(["flush", "getOwner", "runWithOwner"])(
    "ignores non-Solid and shadowed %s bindings",
    (pattern) => {
      const root = fixture(
        [
          `import { ${pattern} as action } from "solid-js";`,
          'import * as signals from "@solidjs/signals";',
          `import { ${pattern} } from "./owner.ts";`,
          `${pattern}();`,
          `owner.${pattern}();`,
          `owner["${pattern}"]();`,
          "function parameter(action: () => void) { action(); }",
          `function namespace(signals: any) { signals.${pattern}(); }`,
          "{ const action = () => {}; action(); }",
          "function hoisted() { { var action = () => {}; } action(); }",
          "function destructured({ action }: { action: () => void }) { action(); }",
          `try {} catch (signals) { signals.${pattern}(); }`,
        ].join("\n"),
      );
      expect(main(root, [])).toBe(0);
    },
  );

  it.each([
    'import { createMemo as memo } from "solid-js"; memo(() => true);',
    'import { createMemo } from "@solidjs/signals"; createMemo<number>(() => 42);',
    'import * as solid from "solid-js"; solid.createMemo(() => { return "ready"; });',
    'import * as solid from "solid-js"; solid["createMemo"](() => null);',
  ])("rejects a memo that only returns a literal: %s", (source) => {
    const root = fixture(source);
    expect(main(root, [])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain("createMemo of a literal is unnecessary");
  });

  it("preserves equality, async, option-bearing, and non-Solid memos", () => {
    const root = fixture(
      [
        'import { createMemo } from "solid-js";',
        'import { createMemo as otherMemo } from "./owner.ts";',
        "createMemo(() => props.value);",
        "createMemo(() => !props.disabled);",
        "createMemo(() => false, { equals: false });",
        "createMemo(async () => true);",
        "createMemo((previous) => 0);",
        "createMemo(() => { track(); return 1; });",
        "createMemo(() => ({}));",
        "createMemo(() => undefined);",
        "otherMemo(() => true);",
        "function local(createMemo: any) { createMemo(() => true); }",
      ].join("\n"),
    );
    expect(main(root, [])).toBe(0);
  });

  it("ignores type-only imports and omitted bindings", () => {
    const root = fixture(
      [
        'import type { flush, createMemo } from "solid-js";',
        'import { type getOwner } from "@solidjs/signals";',
        "const [, second] = pair;",
        "flush(); getOwner(); createMemo(() => true);",
      ].join("\n"),
    );
    expect(main(root, [])).toBe(0);
  });

  it("checks staged Solid debt instead of the working tree", () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, "ui/src/view.ts"), "createEffect(read, write);");
    git(root, ["add", "."]);
    fs.writeFileSync(path.join(root, "ui/src/view.ts"), "export {};\n");
    expect(main(root, ["--staged"])).toBe(1);
    expect(main(root, [])).toBe(0);
  });

  it.each(["./lib/reactive/solid-controller-host.ts", "./lib/subscriptions-controller.ts"])(
    "rejects existing and new production or test consumers of retired %s",
    (module) => {
      const root = fixture(`import "${module}";\n`);
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
    write(root, file, "export {};\n");
    expect(main(root, [])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain(file);
  });

  it("rejects retired host contracts under other production or test paths", () => {
    const root = fixture("export {};\n");
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
    expect(main(root, []), source).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain("ui/src/view.ts");
    fs.writeFileSync(path.join(root, "ui/src/view.ts"), "export {};\n");
    expect(main(root, [])).toBe(0);
  });

  it("ignores examples and test-only lifecycle/class patterns", () => {
    const root = fixture('// class OldController {}\nconst text = "hostConnected";\n');
    write(root, "ui/src/view.test.ts", "class TestController { hostDisconnected() {} }\n");
    expect(main(root, [])).toBe(0);
  });

  it("rejects redraw contracts in production and tests independently of controller retirement", () => {
    const root = fixture();
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
});
