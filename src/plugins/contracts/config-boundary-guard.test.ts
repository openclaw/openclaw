// Config boundary guard tests cover plugin config ownership and forbidden core reads.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectDeprecatedInternalConfigApiViolations,
  collectRuntimeActionLoadConfigViolations,
} from "../../../scripts/lib/config-boundary-guard.mts";

let tempRoots: string[] = [];

function makeRepoFixture(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "openclaw-config-boundary-"));
  tempRoots.push(repoRoot);
  for (const dir of ["src", "extensions", "packages", "test", "scripts"]) {
    mkdirSync(join(repoRoot, dir), { recursive: true });
  }
  return repoRoot;
}

function writeFixture(repoRoot: string, relPath: string, source: string): void {
  const filePath = join(repoRoot, relPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, source);
}

describe("config boundary guard", () => {
  afterEach(() => {
    for (const repoRoot of tempRoots) {
      rmSync(repoRoot, { recursive: true, force: true });
    }
    tempRoots = [];
  });

  it.each(
    [
      {
        name: "deprecated API",
        collect: collectDeprecatedInternalConfigApiViolations,
        file: "src/example.ts",
        expected:
          "src/example.ts:1 use a passed cfg, context.getRuntimeConfig(), or getRuntimeConfig() at an explicit process boundary",
      },
      {
        name: "runtime action",
        collect: collectRuntimeActionLoadConfigViolations,
        file: "extensions/telegram/src/send.ts",
        expected:
          "extensions/telegram/src/send.ts:1: export function run() { return loadConfig(); }",
      },
    ].flatMap((testCase) =>
      ["ts", "tsx"].map((extension) => ({
        collect: testCase.collect,
        name: `${testCase.name} (${extension})`,
        file: testCase.file.replace(/\.ts$/u, `.${extension}`),
        expected: testCase.expected.replace(/\.ts:/u, `.${extension}:`),
      })),
    ),
  )("refreshes $name source between scans", ({ collect, file, expected }) => {
    const repoRoot = makeRepoFixture();
    writeFixture(
      repoRoot,
      "extensions/telegram/src/send.test.tsx",
      "export function testSend() { return loadConfig(); }\n",
    );
    writeFixture(repoRoot, file, "export function run() {}\n");
    expect(collect({ repoRoot })).toEqual([]);

    writeFixture(repoRoot, file, "export function run() { return loadConfig(); }\n");
    expect(collect({ repoRoot })).toEqual([expected]);

    writeFixture(repoRoot, file, "export function run() {}\n");
    expect(collect({ repoRoot })).toEqual([]);
  });

  it("flags deprecated runtime config calls in production plugin code", () => {
    const repoRoot = makeRepoFixture();
    writeFixture(
      repoRoot,
      "extensions/telegram/src/index.ts",
      "export function register(api) { return api.runtime.config.loadConfig(); }\n",
    );

    const violations = collectDeprecatedInternalConfigApiViolations({ repoRoot });
    expect(violations).toEqual([
      "extensions/telegram/src/index.ts:1 use runtime.config.current() or pass the already loaded config",
      "extensions/telegram/src/index.ts:1 use runtime.config.current(), getRuntimeConfig(), or passed config",
      "extensions/telegram/src/index.ts:1 use a passed cfg, context.getRuntimeConfig(), or getRuntimeConfig() at an explicit process boundary",
    ]);
  });

  it("flags loadConfig in runtime channel action helpers only", () => {
    const repoRoot = makeRepoFixture();
    writeFixture(
      repoRoot,
      "extensions/telegram/src/send.ts",
      "export async function send() { return loadConfig(); }\n",
    );
    writeFixture(
      repoRoot,
      "extensions/telegram/src/monitor/status.ts",
      "export async function monitor() { return loadConfig(); }\n",
    );
    writeFixture(
      repoRoot,
      "extensions/openai/src/send.ts",
      "export async function provider() { return loadConfig(); }\n",
    );

    expect(collectRuntimeActionLoadConfigViolations({ repoRoot })).toEqual([
      "extensions/telegram/src/send.ts:1: export async function send() { return loadConfig(); }",
    ]);
  });

  it("flags broad config-runtime barrel imports in production code", () => {
    const repoRoot = makeRepoFixture();
    writeFixture(
      repoRoot,
      "extensions/telegram/src/index.ts",
      [
        'import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";',
        'import { requireRuntimeConfig } from "openclaw/plugin-sdk/config-runtime";',
        'type Loader = typeof import("openclaw/plugin-sdk/config-runtime").getRuntimeConfig;',
        "export type Config = OpenClawConfig;",
        "export const load: Loader = requireRuntimeConfig;",
      ].join("\n"),
    );

    expect(collectDeprecatedInternalConfigApiViolations({ repoRoot })).toEqual([
      "extensions/telegram/src/index.ts:1 use narrow plugin-sdk config subpaths instead of openclaw/plugin-sdk/config-runtime",
      "extensions/telegram/src/index.ts:2 use narrow plugin-sdk config subpaths instead of openclaw/plugin-sdk/config-runtime",
      "extensions/telegram/src/index.ts:3 use narrow plugin-sdk config subpaths instead of openclaw/plugin-sdk/config-runtime",
    ]);
  });

  it("flags broad config-runtime test mocks outside compat guard fixtures", () => {
    const repoRoot = makeRepoFixture();
    writeFixture(
      repoRoot,
      "extensions/telegram/src/index.test.ts",
      'vi.mock("openclaw/plugin-sdk/config-runtime", () => ({}));',
    );

    expect(collectDeprecatedInternalConfigApiViolations({ repoRoot })).toEqual([
      "extensions/telegram/src/index.test.ts:1 use narrow plugin-sdk config subpaths instead of openclaw/plugin-sdk/config-runtime",
    ]);
  });

  it.each(["ts", "tsx"])("allows narrow config SDK subpaths in production %s code", (extension) => {
    const repoRoot = makeRepoFixture();
    writeFixture(
      repoRoot,
      `extensions/telegram/src/index.${extension}`,
      [
        'import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";',
        'import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";',
        'type Loader = typeof import("openclaw/plugin-sdk/runtime-config-snapshot").getRuntimeConfig;',
        'export const load = (cfg: OpenClawConfig) => requireRuntimeConfig(cfg, "telegram");',
      ].join("\n"),
    );

    expect(collectDeprecatedInternalConfigApiViolations({ repoRoot })).toStrictEqual([]);
  });

  it("does not combine unrelated imports into a config mutation violation", () => {
    const repoRoot = makeRepoFixture();
    writeFixture(
      repoRoot,
      "src/gateway/server-methods/agents.ts",
      [
        'import { a } from "./x.js";',
        'import { replaceConfigFile } from "./agents-config-mutations.js";',
        'import { readConfigFileSnapshotForWrite } from "../../config/config.js";',
      ].join("\n"),
    );

    expect(collectDeprecatedInternalConfigApiViolations({ repoRoot })).toEqual([]);
  });

  it.each([
    {
      symbol: "transformConfigFileWithRetry",
      module: "../../config/config.js",
      message: "use the local domain config mutation helper instead of direct config writes",
    },
    {
      symbol: "writeConfigFile",
      module: "../../config/io.js",
      message: "use replaceConfigFile(...) or mutateConfigFile(...) with afterWrite",
    },
    {
      symbol: "loadConfig",
      module: "../../config/config.js",
      message: "use context.getRuntimeConfig() in gateway request handlers",
    },
  ])("reports the offending $symbol specifier's line", ({ symbol, module, message }) => {
    const repoRoot = makeRepoFixture();
    writeFixture(
      repoRoot,
      "src/gateway/server-methods/agents.ts",
      [
        'import { a } from "./x.js";',
        'import { b } from "./y.js";',
        "import {",
        "  readConfigFileSnapshotForWrite,",
        `  ${symbol},`,
        `} from "${module}";`,
      ].join("\n"),
    );

    expect(collectDeprecatedInternalConfigApiViolations({ repoRoot })).toEqual([
      `src/gateway/server-methods/agents.ts:5 ${message}`,
    ]);
  });

  it.each([
    {
      file: "src/commands/example.ts",
      source: [
        "const {",
        "  readConfigFileSnapshot = async () => {},",
        "  writeConfigFile,",
        '} = await import("../config/io.js");',
      ],
      expected: [
        "src/commands/example.ts:3 use replaceConfigFile(...) or mutateConfigFile(...) with afterWrite",
      ],
    },
    {
      file: "extensions/telegram/src/runtime.ts",
      source: [
        "const {",
        "  getRuntimeConfig = () => {},",
        '} = await import("openclaw/plugin-sdk/config-runtime");',
      ],
      expected: [
        "extensions/telegram/src/runtime.ts:1 use narrow plugin-sdk config subpaths instead of openclaw/plugin-sdk/config-runtime",
        "extensions/telegram/src/runtime.ts:3 use narrow plugin-sdk config subpaths instead of openclaw/plugin-sdk/config-runtime",
      ],
    },
  ])(
    "flags dynamic-import destructuring with nested braces in $file",
    ({ file, source, expected }) => {
      const repoRoot = makeRepoFixture();
      writeFixture(repoRoot, file, source.join("\n"));

      expect(collectDeprecatedInternalConfigApiViolations({ repoRoot })).toEqual(expected);
    },
  );

  it("flags low-level config mutation imports in semantic handlers", () => {
    const repoRoot = makeRepoFixture();
    writeFixture(
      repoRoot,
      "src/gateway/server-methods/agents.ts",
      'import { mutateConfigFileWithRetry } from "../../config/config.js";\n',
    );
    writeFixture(
      repoRoot,
      "src/gateway/server-methods/agents-config-mutations.ts",
      'import { mutateConfigFileWithRetry } from "../../config/config.js";\n',
    );

    expect(collectDeprecatedInternalConfigApiViolations({ repoRoot })).toEqual([
      "src/gateway/server-methods/agents.ts:1 use the local domain config mutation helper instead of direct config writes",
    ]);
  });
});
