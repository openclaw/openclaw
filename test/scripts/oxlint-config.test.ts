// Oxlint Config tests cover oxlint config script behavior.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { resolveRepoToolBinPath } from "../../scripts/lib/local-check-runtime.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

const sourceProjectOwners = [
  "agents",
  "gateway",
  "infra",
  "commands",
  "plugins",
  "config",
  "cli",
  "auto-reply",
];
const sourceAugmentations = [
  "src/agents/sessions/keybindings.ts",
  "src/cli/program/openclaw-command.ts",
  "src/agents/bash-tools.exec.resolve-env-hook.test.ts",
  "src/plugin-sdk/channel-inbound.test.ts",
  "src/infra/host-env-security-policy.d.ts",
];

function writeSourceProjectFixture(root: string) {
  for (const file of [
    "config/tsconfig/oxlint.source.json",
    ...sourceProjectOwners.map((owner) => `src/${owner}/tsconfig.json`),
  ]) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  }
  writeSessionCompatibilityFixture(root);
  for (const file of sourceAugmentations) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "export {};\n");
  }
}

type OxlintConfig = {
  ignorePatterns?: string[];
  overrides?: Array<{
    excludeFiles?: string[];
    files?: string[];
    rules?: Record<string, unknown>;
  }>;
  plugins?: string[];
  rules?: Record<string, unknown>;
};

type OxlintTsconfig = {
  compilerOptions?: {
    allowJs?: boolean;
  };
  include?: string[];
  exclude?: string[];
};

function readJson(filePath: string): unknown {
  return JSON5.parse(fs.readFileSync(filePath, "utf8"));
}

function writeSessionCompatibilityFixture(root: string) {
  const directory = path.join(root, "src/config/sessions");
  fs.mkdirSync(directory, { recursive: true });
  // Real editor configs explicitly root this augmentation. Keep its real contents,
  // with fixture-owned base modules rather than importing the whole session graph.
  fs.copyFileSync(
    "src/config/sessions/session-entry.test-compat.d.ts",
    path.join(directory, "session-entry.test-compat.d.ts"),
  );
  for (const [file, interfaces] of [
    ["types.ts", ["SessionEntry", "InternalSessionEntry"]],
    [
      "session-accessor.types.ts",
      [
        "SessionTranscriptRuntimeTarget",
        "SessionTranscriptTurnPersistResult",
        "SessionTranscriptReadTarget",
      ],
    ],
  ] as const) {
    fs.writeFileSync(
      path.join(directory, file),
      interfaces.map((name) => "export interface " + name + " { id: string; }").join("\n"),
    );
  }
}

describe("oxlint config", () => {
  it("enforces namespace, evaluation, and unused-binding policies with the installed binary", () => {
    const tempRoot = fs.realpathSync(createTempDir("openclaw-oxlint-policy-"));
    const typescriptExtensions = ["ts", "tsx", "mts", "cts"];
    const javascriptExtensions = ["js", "jsx", "cjs", "mjs"];
    const evaluation = 'eval("1 + 1");\nglobalThis.eval("1 + 1");\n';
    const fixtures = [
      ...typescriptExtensions.map((extension) => ({
        file: `src/namespaces.${extension}`,
        source: [
          "export type Profile = { ready: boolean };",
          "export const Profile = { ready: true };",
          "export interface Adapter { ready: boolean; }",
          "export const Adapter: Adapter = { ready: true };",
        ].join("\n"),
        rules: [],
      })),
      ...javascriptExtensions.map((extension) => ({
        file: `src/redeclaration.${extension}`,
        source:
          "var duplicateBinding = 1;\nvar duplicateBinding = 2;\nconsole.log(duplicateBinding);\n",
        rules: ["eslint(no-redeclare)", "eslint(no-var)", "eslint(no-var)"],
      })),
      ...typescriptExtensions.map((extension) => ({
        file: `src/no-var.${extension}`,
        source: "export var legacyBinding = 1;\n",
        rules: ["eslint(no-var)"],
      })),
      ...[...typescriptExtensions, ...javascriptExtensions].flatMap((extension) => [
        {
          file: `src/evaluation.${extension}`,
          source: evaluation,
          rules: ["eslint(no-eval)", "eslint(no-eval)"],
        },
        {
          file: `src/unused.${extension}`,
          source:
            "function meaningful(_event) { return true; }\nfunction bare(_) { return true; }\nmeaningful(1);\nbare(1);\n",
          rules: ["eslint(no-unused-vars)"],
        },
      ]),
      ...[
        "extensions/qa-lab/src/web-runtime.ts",
        "extensions/qa-lab/src/web-runtime.test.ts",
        "extensions/qa-lab/src/other-runtime.ts",
        "extensions/other/src/web-runtime.ts",
      ].map((file) => ({
        file,
        source: evaluation,
        rules:
          file === "extensions/qa-lab/src/web-runtime.ts"
            ? ["eslint(no-eval)"]
            : ["eslint(no-eval)", "eslint(no-eval)"],
      })),
    ];
    fs.copyFileSync(".oxlintrc.json", path.join(tempRoot, ".oxlintrc.json"));
    for (const fixture of fixtures) {
      const target = path.join(tempRoot, fixture.file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, fixture.source);
    }
    // These syntax-rule fixtures need no type program; one batch uses the real config and paths.
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("node_modules/oxlint/bin/oxlint"),
        "--config",
        ".oxlintrc.json",
        "--format",
        "json",
        "--threads=1",
        "--report-unused-disable-directives-severity",
        "error",
        ...fixtures.map((fixture) => fixture.file),
      ],
      { cwd: tempRoot, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(result.stdout) as {
      number_of_files: number;
      diagnostics: Array<{
        filename: string;
        code: string;
        severity: string;
        labels: Array<{ span: { line: number } }>;
      }>;
    };
    expect(report.number_of_files).toBe(fixtures.length);
    for (const fixture of fixtures) {
      const diagnostics = report.diagnostics.filter(
        (diagnostic) => diagnostic.filename.replaceAll("\\", "/") === fixture.file,
      );
      expect(diagnostics.map((diagnostic) => diagnostic.code).toSorted(), fixture.file).toEqual(
        fixture.rules.toSorted(),
      );
      expect(
        diagnostics.every((diagnostic) => diagnostic.severity === "error"),
        fixture.file,
      ).toBe(true);
    }
    const ownerDiagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.filename.replaceAll("\\", "/") === "extensions/qa-lab/src/web-runtime.ts",
    );
    expect(ownerDiagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line)).toEqual([1]);
    const unusedDiagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === "eslint(no-unused-vars)",
    );
    expect(unusedDiagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line)).toEqual(
      [...typescriptExtensions, ...javascriptExtensions].map(() => 2),
    );
  });

  it("keeps plugin tests in a bounded type-aware project without losing their types", () => {
    const tempRoot = fs.realpathSync(createTempDir("openclaw-oxlint-extension-project-"));
    for (const file of [
      ".oxlintrc.json",
      "tsconfig.json",
      "extensions/tsconfig.package-boundary.base.json",
      "extensions/tsconfig.package-boundary.paths.json",
      "extensions/tsconfig.json",
    ]) {
      // A missing discovery config must fail on the selected project, not fixture setup.
      if (fs.existsSync(file)) {
        const target = path.join(tempRoot, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(file, target);
      }
    }
    writeSessionCompatibilityFixture(tempRoot);
    fs.symlinkSync(path.resolve("node_modules"), path.join(tempRoot, "node_modules"), "junction");
    const fixtures = {
      "src/imported.ts": "export function work(): Promise<void> { return Promise.resolve(); }",
      "src/unrelated.ts": "export const unrelated = 1;",
      "src/contracts.d.ts": "declare function fromCore(): Promise<void>;",
      "ui/contracts.d.ts": "declare function fromUi(): Promise<void>;",
      "packages/contracts.d.ts": "declare function fromPackage(): Promise<void>;",
      "extensions/contracts.d.ts": "declare function fromPlugin(): Promise<void>;",
      "extensions/sample/tsconfig.json": JSON.stringify({
        extends: "../tsconfig.package-boundary.base.json",
      }),
      "extensions/sample/src/runtime.ts": "export const stable = 1;",
      "extensions/sample/src/owner.test.ts": [
        'import { work } from "../../../src/imported.js";',
        "work(); fromCore(); fromUi(); fromPackage(); fromPlugin();",
      ].join("\n"),
      "extensions/sample/src/test-support/helper.ts":
        'export { work } from "../../../../src/imported.js";',
    };
    for (const [file, source] of Object.entries(fixtures)) {
      const target = path.join(tempRoot, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    }
    const selected = [
      "extensions/sample/src/runtime.ts",
      "extensions/sample/src/owner.test.ts",
      "extensions/sample/src/test-support/helper.ts",
    ];
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("node_modules/oxlint/bin/oxlint"),
        "--config",
        ".oxlintrc.json",
        "--type-aware",
        "--format",
        "json",
        "--threads=1",
        ...selected,
      ],
      {
        cwd: tempRoot,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          OXC_LOG: "debug",
          GOMAXPROCS: "2",
          OXLINT_TSGOLINT_PATH: path.resolve(
            "node_modules/.bin",
            process.platform === "win32" ? "tsgolint.CMD" : "tsgolint",
          ),
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(result.stdout) as {
      number_of_files: number;
      diagnostics: Array<{ code: string }>;
    };
    expect(report.number_of_files).toBe(selected.length);
    expect(
      report.diagnostics.map((diagnostic) => diagnostic.code),
      result.stdout,
    ).toEqual(Array.from({ length: 5 }, () => "typescript(no-floating-promises)"));
    for (const file of selected) {
      const config = file.endsWith("/runtime.ts")
        ? "extensions/sample/tsconfig.json"
        : "extensions/tsconfig.json";
      expect(result.stderr.replaceAll("\\", "/")).toContain(
        `Got tsconfig for file ${path.join(tempRoot, file).replaceAll("\\", "/")}: ${path.join(tempRoot, config).replaceAll("\\", "/")}`,
      );
    }
    const project = spawnSync(
      process.execPath,
      [
        path.resolve("node_modules/typescript/bin/tsc"),
        "--showConfig",
        "--project",
        "extensions/tsconfig.json",
      ],
      { cwd: tempRoot, encoding: "utf8", timeout: 10_000 },
    );
    expect(project.error).toBeUndefined();
    expect(project.status, project.stdout + project.stderr).toBe(0);
    const parsedProject = JSON.parse(project.stdout) as { files: string[] };
    expect(parsedProject.files).not.toContain("../src/unrelated.ts");
    expect(parsedProject.files).toEqual(
      expect.arrayContaining([
        "../src/contracts.d.ts",
        "../ui/contracts.d.ts",
        "../packages/contracts.d.ts",
        "./contracts.d.ts",
        ...selected.map((file) => `./${file.slice("extensions/".length)}`),
      ]),
    );
  });

  it("keeps source and UI lint projects bounded with imported and ambient types", () => {
    const tempRoot = fs.realpathSync(createTempDir("openclaw-oxlint-core-projects-"));
    for (const file of [
      ".oxlintrc.json",
      "tsconfig.json",
      "src/tsconfig.json",
      "ui/tsconfig.json",
    ]) {
      if (fs.existsSync(file)) {
        const target = path.join(tempRoot, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(file, target);
      }
    }
    writeSourceProjectFixture(tempRoot);
    fs.symlinkSync(path.resolve("node_modules"), path.join(tempRoot, "node_modules"), "junction");
    const source = [
      'import { work } from "../packages/imported.js";',
      "work(); fromCore(); fromUi(); fromPackage(); fromPlugin(); fromMts(); fromCts();",
    ].join("\n");
    for (const [file, content] of Object.entries({
      "src/owner.ts": source,
      "ui/owner.ts": source,
      "packages/imported.ts": "export function work(): Promise<void> { return Promise.resolve(); }",
      "src/contracts.d.ts": "declare function fromCore(): Promise<void>;",
      "ui/contracts.d.ts": "declare function fromUi(): Promise<void>;",
      "packages/contracts.d.ts": "declare function fromPackage(): Promise<void>;",
      "extensions/contracts.d.ts": "declare function fromPlugin(): Promise<void>;",
      "packages/contracts.d.mts":
        "export {}; declare global { function fromMts(): Promise<void>; }",
      "packages/contracts.d.cts":
        "export {}; declare global { function fromCts(): Promise<void>; }",
    })) {
      const target = path.join(tempRoot, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    const selected = ["src/owner.ts", "ui/owner.ts"];
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("node_modules/oxlint/bin/oxlint"),
        "--type-aware",
        "--format",
        "json",
        "--threads=1",
        ...selected,
      ],
      {
        cwd: tempRoot,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          OXC_LOG: "debug",
          GOMAXPROCS: "2",
          OXLINT_TSGOLINT_PATH: path.resolve(
            "node_modules/.bin",
            process.platform === "win32" ? "tsgolint.CMD" : "tsgolint",
          ),
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(result.stdout) as {
      diagnostics: Array<{ filename: string; code: string }>;
    };
    for (const file of selected) {
      expect(
        report.diagnostics
          .filter((diagnostic) => diagnostic.filename.replaceAll("\\", "/") === file)
          .map((diagnostic) => diagnostic.code),
      ).toEqual(Array.from({ length: 7 }, () => "typescript(no-floating-promises)"));
      const owner = path.dirname(file);
      expect(result.stderr.replaceAll("\\", "/")).toContain(
        `Got tsconfig for file ${path.join(tempRoot, file).replaceAll("\\", "/")}: ${path.join(tempRoot, owner, "tsconfig.json").replaceAll("\\", "/")}`,
      );
      const project = spawnSync(
        process.execPath,
        [
          path.resolve("node_modules/typescript/bin/tsc"),
          "--showConfig",
          "-p",
          `${owner}/tsconfig.json`,
        ],
        { cwd: tempRoot, encoding: "utf8", timeout: 10_000 },
      );
      expect(project.status, project.stdout + project.stderr).toBe(0);
      const parsed = JSON.parse(project.stdout) as { files: string[] };
      expect(parsed.files).not.toContain(`../${owner === "src" ? "ui" : "src"}/owner.ts`);
    }
  });

  it("checks unbound methods in TypeScript and CommonJS source test support", () => {
    const tempRoot = fs.realpathSync(createTempDir("openclaw-oxlint-source-support-"));
    for (const file of [".oxlintrc.json", "tsconfig.json", "src/tsconfig.json"]) {
      if (fs.existsSync(file)) {
        const target = path.join(tempRoot, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(file, target);
      }
    }
    writeSourceProjectFixture(tempRoot);
    fs.symlinkSync(path.resolve("node_modules"), path.join(tempRoot, "node_modules"), "junction");
    const supportFiles = [
      "src/cli/diagnostics.test-support.ts",
      "src/cli/diagnostics.test-support.cjs",
    ];
    const files = [...supportFiles, "src/cli/unrelated.cjs", "ui/unrelated.test-support.cjs"];
    const source = 'const emit = process.emit;\nemit("lint-fixture");\n';
    for (const file of files) {
      const target = path.join(tempRoot, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    }
    const lint = () =>
      spawnSync(
        process.execPath,
        [
          path.resolve("node_modules/oxlint/bin/oxlint"),
          "--type-aware",
          "--format",
          "json",
          "--threads=1",
          ...files,
        ],
        {
          cwd: tempRoot,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            OXLINT_TSGOLINT_PATH: path.resolve(
              "node_modules/.bin",
              process.platform === "win32" ? "tsgolint.CMD" : "tsgolint",
            ),
          },
        },
      );
    const broken = lint();
    expect(broken.error).toBeUndefined();
    expect(broken.status, broken.stdout + broken.stderr).toBe(1);
    const report = JSON.parse(broken.stdout) as {
      diagnostics: Array<{ filename: string; code: string }>;
    };
    expect(
      report.diagnostics.map(({ filename, code }) => ({
        filename: filename.replaceAll("\\", "/"),
        code,
      })),
    ).toEqual(
      expect.arrayContaining(
        supportFiles.map((filename) => ({ filename, code: "typescript(unbound-method)" })),
      ),
    );
    expect(report.diagnostics).toHaveLength(supportFiles.length);
    for (const file of supportFiles) {
      fs.writeFileSync(
        path.join(tempRoot, file),
        source.replace("process.emit;", "process.emit.bind(process);"),
      );
    }
    const fixed = lint();
    expect(fixed.error).toBeUndefined();
    expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0);
    expect(JSON.parse(fixed.stdout).diagnostics).toEqual([]);
  });

  it("discovers the script test shard without changing typed diagnostics or ancestor fallback", () => {
    const root = fs.realpathSync(createTempDir("openclaw-oxlint-script-project-"));
    for (const file of [
      ".oxlintrc.json",
      "tsconfig.json",
      "test/tsconfig.json",
      "test/tsconfig/tsconfig.test.json",
      "test/tsconfig/tsconfig.test.root.json",
      "test/tsconfig/tsconfig.test.root.scripts.json",
    ]) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file, target);
    }
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
    const augmenters = [
      "test/vitest/vitest.ui-e2e.setup.ts",
      "test/vitest/vitest.ui-e2e.bundled.global-setup.ts",
      "test/vitest/vitest.ui-e2e-prebuilt.global-setup.ts",
      "test/vitest/vitest.ui-e2e.global-setup.ts",
      "test/e2e/gateway-transcripts-discord-capture.e2e.test.ts",
    ];
    const declarations = [
      "test/contracts.d.ts",
      "test/contracts.d.mts",
      "test/contracts.d.cts",
      "src/contracts.d.ts",
      "packages/contracts.d.ts",
      "ui/contracts.d.ts",
    ];
    const write = (file: string, source: string) => {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    };
    // Distinct ambient contracts make every inherited root observable to the
    // installed type-aware linter, including source files that augment Vitest.
    for (const [index, file] of augmenters.entries()) {
      write(
        file,
        'import "vitest"; declare module "vitest" { interface ProvidedContext { contract' +
          index +
          ": () => Promise<void>; } }",
      );
    }
    for (const [index, file] of declarations.entries()) {
      write(file, "export {}; declare global { function ambient" + index + "(): Promise<void>; }");
    }
    const typedSource = [
      'import { inject } from "vitest";',
      ...augmenters.map((_file, index) => 'inject("contract' + index + '")();'),
      ...declarations.map((_file, index) => "ambient" + index + "();"),
    ].join("\n");
    const configured = [
      "test/scripts/run-example.test.ts",
      "test/scripts/ordinary-helper.ts",
      "test/scripts/ci-example.test.ts",
      "test/scripts/check-example.test.ts",
    ];
    const fallback = ["test/scripts/plain.mts", "test/fixtures/excluded.ts"];
    for (const file of configured) {
      write(file, typedSource);
    }
    for (const file of fallback) {
      write(file, "Promise.resolve();\n");
    }
    const selected = [...configured, ...fallback];
    const lint = () =>
      spawnSync(
        process.execPath,
        [
          path.resolve("node_modules/oxlint/bin/oxlint"),
          "--type-aware",
          "--format=json",
          "--threads=1",
          ...selected,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            OXC_LOG: "debug",
            GOMAXPROCS: "2",
            OXLINT_TSGOLINT_PATH: path.resolve(
              "node_modules/.bin",
              process.platform === "win32" ? "tsgolint.CMD" : "tsgolint",
            ),
          },
        },
      );
    const baseline = lint();
    fs.copyFileSync("test/scripts/tsconfig.json", path.join(root, "test/scripts/tsconfig.json"));
    const partitioned = lint();
    const reports = [baseline, partitioned].map((result) => {
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      return JSON.parse(result.stdout) as {
        number_of_files: number;
        diagnostics: Array<{ filename: string; code: string }>;
      };
    });
    expect(reports[0]!.number_of_files).toBe(selected.length);
    expect(reports[1]!.number_of_files).toBe(selected.length);
    expect(reports[0]!.diagnostics.map((item) => JSON.stringify(item)).toSorted()).toEqual(
      reports[1]!.diagnostics.map((item) => JSON.stringify(item)).toSorted(),
    );
    for (const file of configured) {
      expect(
        reports[1]!.diagnostics
          .filter((item) => item.filename.replaceAll("\\", "/") === file)
          .map((item) => item.code),
      ).toEqual(
        Array.from(
          { length: augmenters.length + declarations.length },
          () => "typescript(no-floating-promises)",
        ),
      );
    }
    const assignment = (result: ReturnType<typeof lint>, file: string) =>
      result.stderr
        .replaceAll("\\", "/")
        .split("\n")
        .find((line) =>
          line.includes(
            "Got tsconfig for file " + path.join(root, file).replaceAll("\\", "/") + ":",
          ),
        )
        ?.split(": ")
        .at(-1);
    for (const file of configured) {
      expect(assignment(baseline, file)).toBe(
        path.join(root, "test/tsconfig.json").replaceAll("\\", "/"),
      );
      expect(assignment(partitioned, file)).toBe(
        path
          .join(
            root,
            file.includes("/ci-") || file.includes("/check-")
              ? "test/tsconfig.json"
              : "test/scripts/tsconfig.json",
          )
          .replaceAll("\\", "/"),
      );
    }
    for (const file of fallback) {
      expect(assignment(baseline, file)).toBeDefined();
      expect(assignment(partitioned, file)).toBe(assignment(baseline, file));
    }
  });

  it("partitions source owners without losing selected files, augmentations or typed diagnostics", () => {
    const root = fs.realpathSync(createTempDir("openclaw-oxlint-source-owners-"));
    const write = (file: string, content: string) => {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    };
    for (const file of [".oxlintrc.json", "tsconfig.json", "src/tsconfig.json"]) {
      write(file, fs.readFileSync(file, "utf8"));
    }
    write("package.json", '{"type":"module"}');
    writeSourceProjectFixture(root);
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");

    const contract = "src/shared/lint-contract.ts";
    write(contract, "export interface Contract {} export declare const contract: Contract;");
    for (const [index, file] of sourceAugmentations.entries()) {
      let imported = path
        .relative(path.dirname(file), contract)
        .replaceAll("\\", "/")
        .replace(/\.ts$/, ".js");
      if (!imported.startsWith(".")) imported = "./" + imported;
      write(
        file,
        `import ${JSON.stringify(imported)}; declare module ${JSON.stringify(imported)} { interface Contract { action${index}(): Promise<void>; } }`,
      );
    }
    const declarations = ["src/types", "packages", "ui", "extensions"].flatMap((directory) =>
      ["ts", "mts", "cts"].map((suffix) => directory + "/lint-contract.d." + suffix),
    );
    for (const [index, file] of declarations.entries()) {
      write(file, `export {}; declare global { function ambient${index}(): Promise<void>; }`);
    }
    const projects = [...sourceProjectOwners.map((owner) => "src/" + owner), "src"];
    const selected = projects.flatMap((owner) => [
      owner + "/lint-owner.ts",
      owner + "/lint-owner.test.ts",
      owner + "/lint-helper.test-support.cjs",
    ]);
    for (const file of selected) {
      let imported = path
        .relative(path.dirname(file), contract)
        .replaceAll("\\", "/")
        .replace(/\.ts$/, ".js");
      if (!imported.startsWith(".")) imported = "./" + imported;
      write(
        file,
        [
          ...(file.endsWith(".cjs")
            ? []
            : [
                `import { contract } from ${JSON.stringify(imported)};`,
                ...sourceAugmentations.map((_file, index) => `contract.action${index}();`),
              ]),
          ...declarations.map((_file, index) => `ambient${index}();`),
          "Promise.try(() => undefined);",
        ].join("\n"),
      );
    }
    const excludedDeclarations = [
      "src/config",
      "packages/example",
      "extensions/example",
      "ui",
    ].flatMap((directory) => [
      directory + "/unrelated.test-compat.d.ts",
      directory + "/dist/generated.d.ts",
    ]);
    for (const file of excludedDeclarations) {
      write(file, "declare const excludedDeclaration: unique symbol;");
    }
    const configs = new Map(
      projects.map((owner) => [
        owner + "/tsconfig.json",
        fs.readFileSync(path.join(root, owner, "tsconfig.json"), "utf8"),
      ]),
    );
    const lint = () =>
      spawnSync(
        process.execPath,
        [
          path.resolve("node_modules/oxlint/bin/oxlint"),
          "--type-aware",
          "--threads=1",
          "--format=json",
          ...selected,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            OXC_LOG: "debug",
            GOMAXPROCS: "2",
            OXLINT_TSGOLINT_PATH: path.resolve(
              "node_modules/.bin",
              process.platform === "win32" ? "tsgolint.CMD" : "tsgolint",
            ),
          },
        },
      );
    const narrowed = lint();
    // Recreate the single broad owner with the same ambient contract.
    for (const owner of sourceProjectOwners)
      fs.unlinkSync(path.join(root, "src", owner, "tsconfig.json"));
    const broad = JSON5.parse(configs.get("src/tsconfig.json")!) as { exclude: string[] };
    broad.exclude = broad.exclude.filter(
      (entry) => !sourceProjectOwners.some((owner) => entry === owner + "/**"),
    );
    write("src/tsconfig.json", JSON.stringify(broad));
    const baseline = lint();
    for (const [file, content] of configs) write(file, content);
    const reports = [baseline, narrowed].map((result) => {
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      return JSON.parse(result.stdout) as {
        number_of_files: number;
        diagnostics: Array<{ filename: string; code: string }>;
      };
    });
    expect(reports.map((report) => report.number_of_files)).toEqual([
      selected.length,
      selected.length,
    ]);
    expect(reports[0]!.diagnostics.map((item) => JSON.stringify(item)).toSorted()).toEqual(
      reports[1]!.diagnostics.map((item) => JSON.stringify(item)).toSorted(),
    );
    for (const file of selected) {
      const codes = reports[1]!.diagnostics
        .filter((item) => item.filename.replaceAll("\\", "/") === file)
        .map((item) => item.code);
      expect(codes, file).toEqual(
        Array.from(
          {
            length: file.endsWith(".cjs")
              ? declarations.length + 1
              : declarations.length + sourceAugmentations.length + 1,
          },
          () => "typescript(no-floating-promises)",
        ),
      );
      expect(narrowed.stderr.replaceAll("\\", "/")).toContain(
        `Got tsconfig for file ${path.join(root, file).replaceAll("\\", "/")}: ${path.join(root, path.dirname(file), "tsconfig.json").replaceAll("\\", "/")}`,
      );
    }
    for (const owner of projects) {
      const expanded = spawnSync(
        resolveRepoToolBinPath("tsgo"),
        ["--showConfig", "-p", owner + "/tsconfig.json"],
        { cwd: root, encoding: "utf8", timeout: 10_000 },
      );
      expect(expanded.error).toBeUndefined();
      expect(expanded.status, expanded.stdout + expanded.stderr).toBe(0);
      const parsed = JSON.parse(expanded.stdout) as { files: string[] };
      const roots = parsed.files.map((file) => path.resolve(root, owner, file));
      for (const file of [
        ...declarations,
        ...sourceAugmentations,
        "src/config/sessions/session-entry.test-compat.d.ts",
      ]) {
        expect(roots, owner + ": " + file).toContain(path.resolve(root, file));
      }
      for (const file of excludedDeclarations) {
        expect(roots, owner + ": " + file).not.toContain(path.resolve(root, file));
      }
      for (const file of selected) {
        expect(roots.includes(path.resolve(root, file)), owner + ": " + file).toBe(
          path.dirname(file) === owner,
        );
      }
    }
  });

  it("includes bundled extensions in type-aware lint coverage", () => {
    const tsconfig = readJson("config/tsconfig/oxlint.json") as OxlintTsconfig;

    expect(tsconfig.include).toContain("../../extensions/**/*");
    expect(tsconfig.exclude ?? []).not.toContain("../../extensions");
  });

  it("includes scripts in root type-aware lint coverage", () => {
    const tsconfig = readJson("config/tsconfig/oxlint.json") as OxlintTsconfig;

    expect(tsconfig.include).toContain("../../scripts/**/*");
  });

  it("has a discoverable scripts tsconfig for type-aware linting", () => {
    const tsconfig = readJson("scripts/tsconfig.json") as OxlintTsconfig;

    expect(tsconfig.compilerOptions?.allowJs).toBe(true);
    expect(tsconfig.include).toContain("**/*.ts");
    expect(tsconfig.include).toContain("**/*.mts");
    expect(tsconfig.exclude ?? []).not.toContain("**/*.ts");
    expect(tsconfig.exclude ?? []).not.toContain("**/*.mts");
  });

  it("does not ignore the bundled extensions tree", () => {
    const config = readJson(".oxlintrc.json") as OxlintConfig;

    expect(config.ignorePatterns ?? []).not.toContain("extensions/");
  });

  it("keeps generated and vendored extension outputs ignored", () => {
    const config = readJson(".oxlintrc.json") as OxlintConfig;
    const ignorePatterns = config.ignorePatterns ?? [];

    expect(ignorePatterns).toEqual([
      "dist/",
      "dist-runtime/",
      ".agents/skills/autoreview/tests/fixtures/**",
      "test/fixtures/oxlint-boundary-guards/**",
      "**/a2ui.bundle.js",
      "extensions/diffs/assets/viewer-runtime.js",
      "extensions/diffs-language-pack/assets/viewer-runtime.js",
      "node_modules/",
      "patches/",
      "pnpm-lock.yaml",
      "skills/**",
      "src/auto-reply/reply/export-html/template.js",
      "vendor/",
      "**/.cache/**",
      "**/.openclaw-runtime-deps-copy-*/**",
      "**/build/**",
      "**/coverage/**",
      "**/dist/**",
      "**/dist-runtime/**",
      "**/node_modules/**",
    ]);
  });

  it("allows ecosystem contract fields with leading underscores", () => {
    const config = readJson(".oxlintrc.json") as OxlintConfig;

    expect(config.rules?.["eslint/no-underscore-dangle"]).toEqual([
      "error",
      { allow: ["__typename", "_meta"] },
    ]);
  });

  it("preserves the indexed-access and test-file policies", () => {
    const config = readJson(".oxlintrc.json") as OxlintConfig;

    expect(config.overrides?.slice(0, 3)).toEqual([
      {
        files: ["extensions/browser/src/browser/routes/*.ts"],
        rules: {
          "oxc/no-async-endpoint-handlers": "off",
        },
      },
      {
        files: [
          "packages/markdown-core/**/*.ts",
          "packages/net-policy/**/*.ts",
          "packages/media-understanding-common/**/*.ts",
          "packages/terminal-core/**/*.ts",
          "packages/normalization-core/**/*.ts",
          "packages/model-catalog-core/**/*.ts",
          "packages/agent-core/**/*.ts",
          "packages/acp-core/**/*.ts",
          "packages/ai/**/*.ts",
          "packages/gateway-client/**/*.ts",
          "packages/gateway-protocol/**/*.ts",
          "packages/llm-core/**/*.ts",
          "packages/media-core/**/*.ts",
          "packages/media-generation-core/**/*.ts",
          "packages/plugin-package-contract/**/*.ts",
          "packages/sdk/**/*.ts",
        ],
        rules: {
          "typescript/no-non-null-assertion": "error",
        },
      },
      {
        files: [
          "**/*.{test,suite}.ts",
          "**/*.{test,suite}.tsx",
          "**/*.e2e.test.ts",
          "**/*.live.test.ts",
          "**/*test-harness.ts",
          "**/*test-helpers.ts",
          "**/*test-support.ts",
        ],
        rules: {
          "import/first": "off",
          "typescript/no-explicit-any": "off",
        },
      },
    ]);
  });

  it("errors on scoped max-lines budgets while excluding generated output", () => {
    const config = readJson(".oxlintrc.json") as OxlintConfig;
    const maxLinesOverrides = (config.overrides ?? []).filter(
      (override) => override.rules?.["max-lines"],
    );
    const scopedBudgets = maxLinesOverrides.filter((override) => override.excludeFiles);
    const exactExceptions = maxLinesOverrides.filter((override) => !override.excludeFiles);

    expect(scopedBudgets).toHaveLength(4);
    expect(scopedBudgets.map((override) => override.rules?.["max-lines"])).toEqual([
      ["error", { max: 700, skipBlankLines: true, skipComments: true }],
      ["error", { max: 700, skipBlankLines: true, skipComments: true }],
      ["error", { max: 800, skipBlankLines: true, skipComments: true }],
      ["error", { max: 1000, skipBlankLines: true, skipComments: true }],
    ]);
    for (const override of scopedBudgets) {
      expect(override.excludeFiles).toContain("**/protocol-gen/**");
      expect(override.excludeFiles).toContain("**/*.generated.*");
      expect(override.excludeFiles).toContain("ui/src/i18n/locales/**");
      expect(override.excludeFiles).toContain("src/wizard/i18n/locales/**");
    }
    for (const override of scopedBudgets.slice(0, 3)) {
      expect(override.excludeFiles).toContain("**/*.{test,spec,suite}.*");
    }
    expect(scopedBudgets[3]?.files).toEqual(
      expect.arrayContaining([
        "src/**/*.{test,spec,suite}.*",
        "ui/src/**/*.{test,spec,suite}.*",
        "packages/**/*.{test,spec,suite}.*",
        "extensions/**/*.{test,spec,suite}.*",
      ]),
    );
    expect(exactExceptions).toEqual([
      {
        files: ["extensions/copilot/src/event-bridge.ts"],
        rules: {
          "max-lines": ["error", { max: 950, skipBlankLines: true, skipComments: true }],
        },
      },
      {
        files: ["extensions/copilot/src/attempt-transcript-journal.test.ts"],
        rules: {
          "max-lines": ["error", { max: 1200, skipBlankLines: true, skipComments: true }],
        },
      },
    ]);
  });

  it("keeps native cap scopes and correctness while making only CI limits advisory", () => {
    const root = fs.realpathSync(createTempDir("openclaw-oxlint-ci-limits-"));
    const config = readJson(".oxlintrc.json") as OxlintConfig;
    fs.writeFileSync(
      path.join(root, ".oxlintrc.json"),
      JSON.stringify({
        ...config,
        env: { browser: true },
        globals: { configuredGlobal: "readonly" },
        rules: { ...config.rules, "no-undef": "error" },
        ignorePatterns: [...(config.ignorePatterns ?? []), "src/ignored-by-config.ts"],
        overrides: [
          ...(config.overrides ?? []),
          {
            files: ["src/disabled/**"],
            rules: { "max-lines": "off" },
          },
        ],
      }),
    );
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
    const sources = {
      "src/oversized.ts": 702,
      "src/within-cap.test.ts": 902,
      "extensions/copilot/src/event-bridge.ts": 902,
      "src/generated/ignored.ts": 1402,
      "src/ignored-by-config.ts": 1402,
      "src/disabled/ignored.ts": 1402,
    };
    for (const [file, lines] of Object.entries(sources)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(
        path.join(root, file),
        `export const values = [\n${"  0,\n".repeat(lines - 2)}];\n`,
      );
    }
    fs.writeFileSync(path.join(root, "src/correctness.ts"), "export var legacy = 1;\n");
    fs.writeFileSync(path.join(root, "src/globals.js"), "window.console.log(configuredGlobal);\n");
    for (const { github, correctness, evidence } of [
      { github: false, correctness: false, evidence: false },
      { github: true, correctness: false, evidence: false },
      { github: true, correctness: true, evidence: false },
      { github: true, correctness: true, evidence: true },
    ]) {
      const summary = path.join(root, `summary-${github}-${correctness}.md`);
      const result = spawnSync(
        process.execPath,
        [
          path.resolve("scripts/run-oxlint.mts"),
          "--openclaw-focused-config",
          "--threads=1",
          "--format",
          "json",
          ...Object.keys(sources),
          "src/globals.js",
          ...(correctness ? ["src/correctness.ts"] : []),
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            CI: "true",
            GITHUB_ACTIONS: github ? "true" : "false",
            GITHUB_STEP_SUMMARY: summary,
            OPENCLAW_CI_STATIC_EVIDENCE: evidence ? "1" : "0",
            OPENCLAW_CI_STATIC_EVIDENCE_ID: "limits:0",
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(github && !correctness ? 0 : 1);
      const marker = "\n[ci-static:oxlint:leaf] ";
      const [output, receipt] = result.stdout.split(marker);
      assert.ok(output !== undefined, "Missing lint diagnostic output");
      const report = JSON.parse(output) as {
        diagnostics: Array<{ code: string; severity: string; filename: string; help?: string }>;
      };
      if (evidence) {
        assert.ok(receipt !== undefined, "Missing lint evidence receipt");
        expect(JSON.parse(receipt)).toMatchObject({
          version: 1,
          id: "limits:0",
          config: ".oxlintrc.json",
          exitCode: 1,
          stdout: output,
          stderr: "",
        });
        expect(fs.readdirSync(root).filter((file) => file.startsWith(".oxlint-limits-"))).toEqual(
          [],
        );
      } else {
        expect(receipt).toBeUndefined();
      }
      expect(report.diagnostics).toHaveLength(correctness ? 2 : 1);
      expect(
        report.diagnostics.find((diagnostic) => diagnostic.code === "eslint(max-lines)"),
      ).toMatchObject({
        severity: github ? "warning" : "error",
        help: "Maximum allowed is 700.",
      });
      if (github) {
        expect(result.stderr).toContain("::warning file=src/oversized.ts,");
        expect(fs.readFileSync(summary, "utf8")).toContain("Maximum allowed is 700.");
      }
      if (correctness) {
        expect(
          report.diagnostics.find((diagnostic) => diagnostic.code === "eslint(no-var)")?.severity,
        ).toBe("error");
      }
    }
  });

  it("preserves native config validation locally and in Actions", () => {
    const root = fs.realpathSync(createTempDir("openclaw-oxlint-invalid-limit-"));
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
    fs.writeFileSync(path.join(root, "fixture.ts"), "console.log(1);\n");
    const invalidConfigs = [
      ...["not-a-severity", 3, null].map((severity) =>
        JSON.stringify({
          categories: { correctness: "off" },
          rules: { "max-lines": [severity, { max: 1 }] },
        }),
      ),
      '{categories: {correctness: "off"}, rules: {"max-lines": ["error", {max: 1}]}}',
    ];
    for (const config of invalidConfigs) {
      fs.writeFileSync(path.join(root, ".oxlintrc.json"), config);
      for (const github of [false, true]) {
        const result = spawnSync(
          process.execPath,
          [path.resolve("scripts/run-oxlint.mts"), "--openclaw-focused-config", "fixture.ts"],
          {
            cwd: root,
            encoding: "utf8",
            env: {
              ...process.env,
              GITHUB_ACTIONS: github ? "true" : "false",
              OPENCLAW_CI_STATIC_EVIDENCE: "1",
              OPENCLAW_CI_STATIC_EVIDENCE_ID: "invalid:0",
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect(
          result.status,
          `${config} / Actions=${github}: ${result.stdout}${result.stderr}`,
        ).toBe(1);
        expect(result.stdout + result.stderr).toContain("Failed to parse");
        expect(result.stdout).not.toContain("[ci-static:oxlint:leaf]");
      }
    }
  });

  it("enables strict empty object type lint with named single-extends interfaces allowed", () => {
    const config = readJson(".oxlintrc.json") as OxlintConfig;

    expect(config.rules?.["typescript/no-empty-object-type"]).toEqual([
      "error",
      { allowInterfaces: "with-single-extends" },
    ]);
  });

  it("enables exhaustive switch linting", () => {
    const config = readJson(".oxlintrc.json") as OxlintConfig;

    expect(config.rules?.["typescript/switch-exhaustiveness-check"]).toEqual([
      "error",
      { considerDefaultExhaustiveForUnions: true },
    ]);
  });
});
