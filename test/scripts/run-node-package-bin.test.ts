import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createPnpmRunnerSpawnSpec } from "../../scripts/pnpm-runner.mts";
import { mergeProcessEnv } from "../../src/infra/process-env.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const toolEntries: Record<string, string> = {
  vite: "bin/vite.js",
  vitest: "vitest.mjs",
  playwright: "cli.js",
};
const qaConfig = ["--config", "extensions/qa-lab/web/vite.config.ts"];
const commands: [string, string, string, ...string[]][] = [
  ["packages/mermaid-renderer", "build", "vite", "build"],
  ["ui", "build", "vite", "build"],
  ["ui", "dev", "vite"],
  ["ui", "preview", "vite", "preview"],
  ["ui", "test", "vitest", "run", "--config", "vitest.config.ts"],
  [".", "qa:lab:build", "vite", "build", ...qaConfig],
  [".", "qa:lab:watch", "vite", "build", "--watch", ...qaConfig],
];

function write(root: string, file: string, text = fs.readFileSync(file, "utf8"), mode?: number) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, { mode });
  return target;
}

function writePackage(root: string, fields = {}) {
  write(root, "package.json", JSON.stringify({ private: true, type: "module", ...fields }));
}

function toolFixture(directory: string, tool: string, layout: string, exitCode: number) {
  const root = fs.realpathSync(createTempDir("openclaw-package-bin-"));
  const cwd = path.resolve(root, directory);
  const capture = path.join(root, "capture.json");
  let entry = "";
  for (const target of new Set([root, cwd])) {
    writePackage(target);
    const modules = path.join(target, "node_modules");
    if (target === root || layout === "isolated") {
      entry = writeTool(modules, tool, target === root ? "root" : "local", exitCode);
    }
    // A stale local shim must not shadow the healthy ancestor package.
    writeShim(modules, tool);
  }
  const env = mergeProcessEnv([
    process.env,
    {
      PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
      PACKAGE_BIN_CAPTURE: capture,
      PACKAGE_BIN_MARKER: "forwarded",
    },
  ]);
  return {
    root,
    cwd,
    env,
    run(command: string, commandArgs: string[], args: string[], options: SpawnSyncOptions = {}) {
      const result = spawnSync(command, commandArgs, {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10_000,
        ...options,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, `${String(result.stdout)}${String(result.stderr)}`).toBe(exitCode);
      expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toEqual({
        args,
        entry,
        cwd,
        scope: layout === "isolated" ? "local" : "root",
        marker: "forwarded",
      });
    },
  };
}
function writeTool(modules: string, tool: string, scope: string, exitCode: number): string {
  const directory = path.join(modules, tool);
  const entry = toolEntries[tool]!;
  writePackage(directory, {
    exports: { ".": "./index.mjs", "./package.json": "./package.json" },
    bin: { [tool]: entry },
  });
  write(directory, "index.mjs", "export const chromium = {};\n");
  return write(
    directory,
    entry,
    `import fs from "node:fs";
fs.writeFileSync(process.env.PACKAGE_BIN_CAPTURE, JSON.stringify({
  args: process.argv.slice(2), entry: process.argv[1], cwd: process.cwd(),
  scope: ${JSON.stringify(scope)}, marker: process.env.PACKAGE_BIN_MARKER
}));
process.exitCode = ${exitCode};
`,
  );
}

function writeShim(modules: string, tool: string): void {
  const directory = path.join(modules, ".bin");
  // Poison both shim formats: package-bin resolution must never execute either.
  write(directory, tool, "#!/bin/sh\nexit 91\n", 0o755);
  write(directory, `${tool}.cmd`, "@exit /b 91\r\n");
}

it.each(
  commands.flatMap(([directory, script, tool, ...args]) =>
    (directory === "." ? ["hoisted"] : ["hoisted", "isolated"]).map(
      (layout) => [directory, script, layout, tool, args] as const,
    ),
  ),
)(
  "runs %s %s with %s dependencies and package-local shims",
  (directory, script, layout, tool, args) => {
    const fixture = toolFixture(directory, tool, layout, tool === "vitest" ? 17 : 0);
    const { root, cwd } = fixture;
    const forwarded = ["--help", "--mode", "fixture with spaces"];
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    writePackage(cwd, { scripts: { [script]: manifest.scripts[script] } });
    write(root, "scripts/run-node-package-bin.mts");
    const spec = createPnpmRunnerSpawnSpec({
      cwd: root,
      env: fixture.env,
      stdio: "pipe",
      pnpmArgs: ["--dir", cwd, "run", script, ...forwarded],
    });
    fixture.run(spec.command, spec.args, [...args, ...forwarded], spec.options);
  },
);

it.each(["hoisted", "isolated"])(
  "installs browser dependencies from %s packages without following stale UI shims",
  (layout) => {
    const fixture = toolFixture("ui", "playwright", layout, 0);
    const { root } = fixture;
    fs.mkdirSync(path.join(root, ".git"));
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
      write(root, file);
    }
    write(
      root,
      "probe.mjs",
      `import { spawnSync } from "node:child_process";
import { ensurePlaywrightChromium } from "./scripts/ensure-playwright-chromium.mts";
process.exitCode = ensurePlaywrightChromium({
  executablePath: "fixture-browser", existsSync: () => true, ensureFfmpeg: true,
  spawnSync(command, args, options) {
    return command === "fixture-browser" ? { status: 0 } : spawnSync(command, args, options);
  }
});\n`,
    );
    fixture.run(process.execPath, [path.join(root, "probe.mjs")], ["install", "ffmpeg"], {
      env: mergeProcessEnv([fixture.env, { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: undefined }]),
    });
  },
);
