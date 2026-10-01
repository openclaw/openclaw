import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCiExtensionLintSelection } from "../../scripts/lib/ci-extension-lint-plan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function workspace() {
  const cwd = tempDirs.make("extension-lint-selection-");
  const git = (args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd, encoding: "utf8" },
    );
  const write = (file: string, content: string) => {
    const target = path.join(cwd, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    if (existsSync(path.join(cwd, ".git"))) {
      git(["add", "--", file]);
    }
  };
  write("package.json", '{"type":"module"}');
  write("pnpm-workspace.yaml", "packages:\n  - extensions/*\n");
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        paths: { "openclaw/plugin-sdk/*": ["./src/plugin-sdk/*.ts"] },
      },
    }),
  );
  for (const id of ["alpha", "beta", "unrelated"]) {
    write(`extensions/${id}/package.json`, '{"private":true}');
    write(`extensions/${id}/index.ts`, "export {};\n");
  }
  write("src/plugin-sdk/api.ts", "export type Result = Promise<void>;\n");
  write("src/plugin-sdk/public.ts", 'export type { Result } from "./api.js";\n');
  write(
    "extensions/alpha/index.ts",
    'import type { Result } from "openclaw/plugin-sdk/public"; export type Response = Result;\n',
  );
  write(
    "extensions/beta/index.ts",
    'import type { Response } from "../alpha/index.js"; export type Reply = Response;\n',
  );
  write("src/leaf.ts", "export const value = 1;\n");
  git(["init", "--quiet"]);
  const commitBase = () => {
    git(["add", "."]);
    git(["commit", "--quiet", "--allow-empty", "-m", "fixture base"]);
    return git(["rev-parse", "HEAD"]).trim();
  };
  const baseRef = commitBase();
  return { cwd, write, baseRef, commitBase };
}

describe("extension lint package selection", () => {
  it("selects whole packages for transitive aliased type consumers and directly changed metadata", async () => {
    const { cwd, baseRef } = workspace();
    const selected = await resolveCiExtensionLintSelection(
      ["src/plugin-sdk/api.ts", "extensions/unrelated/openclaw.plugin.json"],
      cwd,
      { baseRef },
    );
    expect(selected.mode).toBe("selected");
    expect(selected.extensionRoots).toEqual([
      "extensions/alpha",
      "extensions/beta",
      "extensions/unrelated",
    ]);
    expect(selected.reasons["extensions/alpha"]).toEqual([
      "import consumer: extensions/alpha/index.ts",
    ]);
    expect(selected.reasons["extensions/unrelated"]).toEqual([
      "changed: extensions/unrelated/openclaw.plugin.json",
    ]);
  });

  it("omits extension lint when a source has no extension consumers", async () => {
    const { cwd, baseRef } = workspace();
    expect(
      await resolveCiExtensionLintSelection(["src/leaf.ts", "docs/example.md"], cwd, { baseRef }),
    ).toEqual({
      mode: "selected",
      extensionRoots: [],
      reasons: {},
      fullReasons: [],
    });
  });

  it("does not treat module-local declarations, class fields or fixture text as global types", async () => {
    const { cwd, write, baseRef } = workspace();
    write(
      "src/leaf.ts",
      'declare const local: string; export class View { declare value: string; } export const fixture = "declare global { interface Window {} }";\n',
    );
    const selection = await resolveCiExtensionLintSelection(["src/leaf.ts"], cwd, { baseRef });
    expect(selection.mode).toBe("selected");
    expect(selection.extensionRoots).toEqual([]);
  });

  it.each([
    "pnpm-lock.yaml",
    "extensions/alpha/package.json",
    "extensions/tsconfig.json",
    "config/oxlint/boundary-guards.json",
    "config/tsconfig/oxlint.json",
    "patches/example.patch",
    "src/state/openclaw-state-schema.sql",
    "scripts/lib/plugin-sdk-entrypoints.json",
    ".github/workflows/ci.yml",
    "src/removed.ts",
  ])("retains full coverage for unresolved or shared policy %s", async (file) => {
    const { cwd } = workspace();
    const selection = await resolveCiExtensionLintSelection([file], cwd);
    expect(selection.mode).toBe("full");
    expect(selection.fullReasons).toHaveLength(1);
  });

  it.each([
    ["extensions/shared.ts", "export const shared = true;\n", "shared extension input"],
    ["src/global-types.ts", "interface GlobalResult { value: string }\n", "ambient type impact"],
  ])(
    "keeps full coverage for %s outside package import ownership",
    async (file, source, reason) => {
      const { cwd, write, baseRef } = workspace();
      write(file, source);
      const selection = await resolveCiExtensionLintSelection([file], cwd, { baseRef });
      expect(selection.mode).toBe("full");
      expect(selection.fullReasons).toContain(`${reason}: ${file}`);
    },
  );

  it("retains full lint when a changed script configures its execution owner", async () => {
    const { cwd, write, baseRef } = workspace();
    write("scripts/lib/settings.mts", "export const flag = true;\n");
    write(
      "scripts/run-oxlint.mts",
      'import { flag } from "./lib/settings.mts"; console.log(flag);\n',
    );
    const selection = await resolveCiExtensionLintSelection(["scripts/lib/settings.mts"], cwd, {
      baseRef,
    });
    expect(selection.mode).toBe("full");
    expect(selection.fullReasons).toContain("lint execution consumer: scripts/run-oxlint.mts");
  });

  it("retains full coverage when a consumer augments globals outside import edges", async () => {
    const { cwd, write, baseRef } = workspace();
    write(
      "src/ambient.ts",
      'import type { Result } from "./plugin-sdk/api.js"; declare global { interface Window { work: Result } }\n',
    );
    const selection = await resolveCiExtensionLintSelection(["src/plugin-sdk/api.ts"], cwd, {
      baseRef,
    });
    expect(selection.mode).toBe("full");
    expect(selection.fullReasons).toContain("ambient type impact: src/ambient.ts");
  });

  it("restores full coverage with the kill switch even for an unrelated diff", async () => {
    const { cwd } = workspace();
    const selection = await resolveCiExtensionLintSelection(["docs/example.md"], cwd, {
      forceFull: true,
    });
    expect(selection.mode).toBe("full");
    expect(selection.fullReasons).toEqual(["OPENCLAW_CI_EXTENSION_LINT_FULL"]);
  });

  it("keeps loose extension consumers under full lint", async () => {
    const { cwd, write, baseRef } = workspace();
    write(
      "extensions/shared.ts",
      'import { value } from "../src/leaf.js"; export const shared = value;\n',
    );
    const selection = await resolveCiExtensionLintSelection(["src/leaf.ts"], cwd, { baseRef });
    expect(selection.mode).toBe("full");
    expect(selection.fullReasons).toContain("shared extension consumer: extensions/shared.ts");
  });

  it("keeps implicit consumers of an unchanged script-global import type covered", async () => {
    const { cwd, write, baseRef } = workspace();
    write("src/global-alias.ts", 'type SharedResult = import("./plugin-sdk/api.js").Result;\n');
    const selection = await resolveCiExtensionLintSelection(["src/plugin-sdk/api.ts"], cwd, {
      baseRef,
    });
    expect(selection.mode).toBe("full");
    expect(selection.fullReasons).toContain("ambient type impact: src/global-alias.ts");
  });

  it("keeps global consumers covered when an existing augmentation is removed", async () => {
    const { cwd, write, commitBase } = workspace();
    write("src/leaf.ts", "export {}; declare global { interface Window { work: string } }\n");
    const baseRef = commitBase();
    write("src/leaf.ts", "export {};\n");
    const selection = await resolveCiExtensionLintSelection(["src/leaf.ts"], cwd, { baseRef });
    expect(selection.mode).toBe("full");
    expect(selection.fullReasons).toContain("ambient type impact: src/leaf.ts");
  });

  it("retains full coverage when previous source types cannot be inspected", async () => {
    const { cwd } = workspace();
    const selection = await resolveCiExtensionLintSelection(["src/leaf.ts"], cwd);
    expect(selection.mode).toBe("full");
    expect(selection.fullReasons).toContain(
      "previous source types unavailable at the exact diff base",
    );
  });
});
