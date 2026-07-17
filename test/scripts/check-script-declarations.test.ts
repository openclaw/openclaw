import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyScriptDeclarationContracts } from "../../scripts/check-script-declarations.mjs";

describe("script declaration contracts", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails deliberate export drift and passes after regenerating the declaration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-script-declarations-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "scripts", "example.mjs"),
      "export function stable() {}\nexport function added() {}\n",
    );
    fs.writeFileSync(
      path.join(root, "scripts", "example.d.mts"),
      "export function stable(): void;\n",
    );
    fs.writeFileSync(
      path.join(root, "test", "consumer.ts"),
      'import { added } from "../scripts/example.mjs";\nvoid added;\n',
    );
    const files = ["scripts/example.d.mts", "scripts/example.mjs", "test/consumer.ts"];

    expect(verifyScriptDeclarationContracts({ root, files })).toEqual({
      checked: 1,
      issues: ["scripts/example.d.mts: value-export contract drift; missing added"],
    });

    fs.writeFileSync(
      path.join(root, "scripts", "example.d.mts"),
      "export function added(): void;\nexport function stable(): void;\n",
    );

    expect(verifyScriptDeclarationContracts({ root, files })).toEqual({ checked: 1, issues: [] });
  });

  it("requires declarations for scripts imported by typed sources", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-script-declarations-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "missing.mjs"), "export const value = 1;\n");
    fs.writeFileSync(
      path.join(root, "test", "consumer.ts"),
      'import { value } from "../scripts/missing.mjs";\nvoid value;\n',
    );

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: ["scripts/missing.mjs", "test/consumer.ts"],
      }),
    ).toEqual({
      checked: 0,
      issues: ["scripts/missing.mjs: missing scripts/missing.d.mts"],
    });
  });

  it("rejects declaration sidecars whose runtime script is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-script-declarations-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "orphan.d.mts"), "export const value: 1;\n");
    fs.writeFileSync(
      path.join(root, "test", "consumer.ts"),
      'import { value } from "../scripts/orphan.mjs";\nvoid value;\n',
    );

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: ["scripts/orphan.d.mts", "test/consumer.ts"],
      }),
    ).toEqual({
      checked: 0,
      issues: ["scripts/orphan.mjs: missing runtime source"],
    });
  });

  it("ignores tracked declaration pairs deleted from the working tree", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-script-declarations-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: root });
    const runtimePath = path.join(root, "scripts", "removed.mjs");
    const declarationPath = path.join(root, "scripts", "removed.d.mts");
    fs.writeFileSync(runtimePath, "export const value = 1;\n");
    fs.writeFileSync(declarationPath, "export const value: 1;\n");
    execFileSync("git", ["add", "scripts/removed.mjs", "scripts/removed.d.mts"], { cwd: root });
    fs.rmSync(runtimePath);
    fs.rmSync(declarationPath);

    expect(verifyScriptDeclarationContracts({ root })).toEqual({ checked: 0, issues: [] });
  });

  it("applies ESM default and ambiguity rules to star re-exports", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-script-declarations-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "scripts", "left.mjs"),
      "export default 1;\nexport const shared = 1;\nexport const left = 1;\n",
    );
    fs.writeFileSync(
      path.join(root, "scripts", "right.mjs"),
      "export const shared = 2;\nexport const right = 1;\n",
    );
    fs.writeFileSync(path.join(root, "scripts", "left-alias.mjs"), 'export * from "./left.mjs";\n');
    fs.writeFileSync(
      path.join(root, "scripts", "barrel.mjs"),
      'export * from "./left.mjs";\nexport * from "./left-alias.mjs";\nexport * from "./right.mjs";\n',
    );
    fs.writeFileSync(
      path.join(root, "scripts", "barrel.d.mts"),
      "export const left: 1;\nexport const right: 1;\n",
    );

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: [
          "scripts/barrel.d.mts",
          "scripts/barrel.mjs",
          "scripts/left-alias.mjs",
          "scripts/left.mjs",
          "scripts/right.mjs",
        ],
      }),
    ).toEqual({ checked: 1, issues: [] });
  });

  it("fails closed when a star re-export cannot be resolved", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-script-declarations-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "barrel.mjs"), 'export * from "package";\n');
    fs.writeFileSync(path.join(root, "scripts", "barrel.d.mts"), "export {};\n");

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: ["scripts/barrel.d.mts", "scripts/barrel.mjs"],
      }),
    ).toEqual({
      checked: 1,
      issues: ['scripts/barrel.mjs: unresolved star re-export "package"'],
    });
  });

  it("resolves declaration stars to declarations before runtime modules", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-script-declarations-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "lib", "helper.mjs"),
      "export const one = 1;\nexport const two = 2;\n",
    );
    fs.writeFileSync(path.join(root, "lib", "helper.d.mts"), "export const one: 1;\n");
    fs.writeFileSync(
      path.join(root, "scripts", "barrel.mjs"),
      'export * from "../lib/helper.mjs";\n',
    );
    fs.writeFileSync(
      path.join(root, "scripts", "barrel.d.mts"),
      'export * from "../lib/helper.mjs";\n',
    );

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: ["lib/helper.d.mts", "lib/helper.mjs", "scripts/barrel.d.mts", "scripts/barrel.mjs"],
      }),
    ).toEqual({
      checked: 1,
      issues: ["scripts/barrel.d.mts: value-export contract drift; missing two"],
    });
  });

  it("does not count type-only named or default declaration exports", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-script-declarations-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "scripts", "types.mjs"),
      "export const Foo = 1;\nexport default 1;\n",
    );
    fs.writeFileSync(
      path.join(root, "scripts", "types.d.mts"),
      "interface Foo {}\nexport { Foo };\nexport default interface Default {}\n",
    );

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: ["scripts/types.d.mts", "scripts/types.mjs"],
      }),
    ).toEqual({
      checked: 1,
      issues: ["scripts/types.d.mts: value-export contract drift; missing default, Foo"],
    });
  });

  it("preserves local binding identity through renamed star paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-script-declarations-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "scripts", "origin.mjs"),
      "const value = 1;\nexport { value as left, value as right };\n",
    );
    fs.writeFileSync(
      path.join(root, "scripts", "left.mjs"),
      'export { left as shared } from "./origin.mjs";\n',
    );
    fs.writeFileSync(
      path.join(root, "scripts", "right.mjs"),
      'export { right as shared } from "./origin.mjs";\n',
    );
    fs.writeFileSync(
      path.join(root, "scripts", "barrel.mjs"),
      'export * from "./left.mjs";\nexport * from "./right.mjs";\n',
    );
    fs.writeFileSync(path.join(root, "scripts", "barrel.d.mts"), "export const shared: 1;\n");

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: [
          "scripts/barrel.d.mts",
          "scripts/barrel.mjs",
          "scripts/left.mjs",
          "scripts/origin.mjs",
          "scripts/right.mjs",
        ],
      }),
    ).toEqual({ checked: 1, issues: [] });
  });
});
