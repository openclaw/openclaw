import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPnpmRunnerSpawnSpec } from "../../scripts/pnpm-runner.mts";
import { mergeProcessEnv } from "../../src/infra/process-env.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const toolEntries: Record<string, string> = {
  vite: "bin/vite.js",
  vitest: "vitest.mjs",
  playwright: "cli.js",
};
function command(directory: string, script: string, tool: string, ...args: string[]) {
  return { directory, script, tool, args };
}
const commands = [
  command("packages/mermaid-renderer", "build", "vite", "build"),
  command("ui", "build", "vite", "build"),
  command("ui", "dev", "vite"),
  command("ui", "preview", "vite", "preview"),
  command("ui", "test", "vitest", "run", "--config", "vitest.config.ts"),
  command(".", "qa:lab:build", "vite", "build", "--config", "extensions/qa-lab/web/vite.config.ts"),
  command(
    ".",
    "qa:lab:watch",
    "vite",
    "build",
    "--watch",
    "--config",
    "extensions/qa-lab/web/vite.config.ts",
  ),
];

function writePackage(directory: string, fields = {}) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module", ...fields }),
  );
}

function copyScript(root: string, file: string) {
  if (!fs.existsSync(file)) {
    return;
  }
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(file, destination);
}

function fixtureEnv(capture: string) {
  return mergeProcessEnv([
    process.env,
    {
      PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
      PACKAGE_BIN_CAPTURE: capture,
      PACKAGE_BIN_MARKER: "forwarded",
    },
  ]);
}

function expectCapture(
  capture: string,
  expected: { args: string[]; entry: string; cwd: string },
  layout: string,
) {
  expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toEqual({
    ...expected,
    scope: layout === "isolated" ? "local" : "root",
    marker: "forwarded",
  });
}

function installTool(root: string, cwd: string, tool: string, layout: string, exitCode: number) {
  const rootModules = path.join(root, "node_modules");
  let entry = writeTool(rootModules, tool, "root", exitCode);
  writeShim(rootModules, tool);
  if (cwd !== root) {
    const localModules = path.join(cwd, "node_modules");
    if (layout === "isolated") {
      entry = writeTool(localModules, tool, "local", exitCode);
    }
    // A stale local shim must not shadow the healthy ancestor package.
    writeShim(localModules, tool);
  }
  return entry;
}

function writeTool(modules: string, tool: string, scope: string, exitCode: number): string {
  const directory = path.join(modules, tool);
  const entry = toolEntries[tool]!;
  const executable = path.join(directory, entry);
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: tool,
      type: "module",
      exports: { ".": "./index.mjs", "./package.json": "./package.json" },
      bin: { [tool]: entry },
    }),
  );
  fs.writeFileSync(path.join(directory, "index.mjs"), "export const chromium = {};\n");
  fs.writeFileSync(
    executable,
    `import fs from "node:fs";
fs.writeFileSync(process.env.PACKAGE_BIN_CAPTURE, JSON.stringify({
  args: process.argv.slice(2), entry: process.argv[1], cwd: process.cwd(),
  scope: ${JSON.stringify(scope)}, marker: process.env.PACKAGE_BIN_MARKER
}));
process.exitCode = ${exitCode};
`,
  );
  return executable;
}

function writeShim(modules: string, tool: string): void {
  const directory = path.join(modules, ".bin");
  const entry = toolEntries[tool]!;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, tool),
    `#!/bin/sh\nexec node "$(dirname "$0")/../${tool}/${entry}" "$@"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(directory, `${tool}.cmd`),
    `@echo off\r\nnode "%~dp0..\\${tool}\\${entry.replaceAll("/", "\\")}" %*\r\n`,
  );
}

describe("Node package tool commands", () => {
  it.each(
    commands.flatMap(({ directory, script, tool, args }) =>
      (directory === "." ? ["hoisted"] : ["hoisted", "isolated"]).map((layout) => ({
        directory,
        script,
        tool,
        args,
        layout,
      })),
    ),
  )(
    "runs $directory $script with $layout dependencies and package-local shims",
    ({ directory, script, tool, args, layout }) => {
      const root = fs.realpathSync(createTempDir("openclaw-package-bin-"));
      const cwd = path.resolve(root, directory);
      const capture = path.join(root, "capture.json");
      const expectedExit = tool === "vitest" ? 17 : 0;
      const forwarded = ["--help", "--mode", "fixture with spaces"];
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
      writePackage(root);
      writePackage(cwd, { scripts: { [script]: manifest.scripts[script] } });
      copyScript(root, "scripts/run-node-package-bin.mts");
      const entry = installTool(root, cwd, tool, layout, expectedExit);
      const spec = createPnpmRunnerSpawnSpec({
        cwd: root,
        env: fixtureEnv(capture),
        pnpmArgs: ["--dir", cwd, "run", script, ...forwarded],
      });
      const result = spawnSync(spec.command, spec.args, {
        ...spec.options,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(expectedExit);
      expectCapture(capture, { args: [...args, ...forwarded], entry, cwd }, layout);
    },
  );

  it.each(["hoisted", "isolated"])(
    "installs browser dependencies from %s packages without following stale UI shims",
    (layout) => {
      const root = fs.realpathSync(createTempDir("openclaw-playwright-bin-"));
      const ui = path.join(root, "ui");
      const capture = path.join(root, "capture.json");
      fs.mkdirSync(path.join(root, ".git"));
      for (const directory of [root, ui]) {
        writePackage(directory);
      }
      for (const file of [
        "scripts/ensure-playwright-chromium.mts",
        "scripts/run-node-package-bin.mts",
        "scripts/pnpm-runner.mts",
        "scripts/windows-cmd-helpers.mjs",
        "scripts/lib/arg-utils.mts",
        "scripts/lib/arg-utils.runtime.mjs",
        "scripts/lib/record-shared.mjs",
        "scripts/lib/repo-root.mjs",
        "packages/normalization-core/src/record-coerce.ts",
        "packages/normalization-core/src/string-coerce.ts",
        "packages/normalization-core/src/utf16-slice.ts",
      ]) {
        copyScript(root, file);
      }
      const entry = installTool(root, ui, "playwright", layout, 0);
      fs.writeFileSync(
        path.join(root, "probe.mjs"),
        `import { spawnSync } from "node:child_process";
import { ensurePlaywrightChromium } from "./scripts/ensure-playwright-chromium.mts";
process.exitCode = ensurePlaywrightChromium({
  executablePath: "fixture-browser", existsSync: () => true, ensureFfmpeg: true,
  spawnSync(command, args, options) {
    return command === "fixture-browser" ? { status: 0 } : spawnSync(command, args, options);
  }
});\n`,
      );
      const result = spawnSync(process.execPath, [path.join(root, "probe.mjs")], {
        cwd: root,
        env: mergeProcessEnv([
          fixtureEnv(capture),
          { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: undefined },
        ]),
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expectCapture(capture, { args: ["install", "ffmpeg"], entry, cwd: ui }, layout);
    },
  );
});
