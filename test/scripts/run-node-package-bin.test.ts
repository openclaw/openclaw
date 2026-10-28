import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const script = path.resolve("scripts/run-node-package-bin.mts");
const tool = "fixture-tool";
const args = ["--help", "--mode", "fixture with spaces"];

it.each([
  [".", false],
  ["ui", false],
  ["ui", true],
] as const)(
  "runs the package bin in %s (isolated=%s), ignoring stale shims",
  (directory, isolated) => {
    const root = fs.realpathSync(createTempDir("openclaw-package-bin-"));
    const cwd = path.resolve(root, directory);
    const capture = path.join(root, "capture.json");
    const write = (base: string, relative: string, text: string, mode?: number) => {
      const file = path.join(base, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, { mode });
      return file;
    };
    let entry = "";
    for (const scope of new Set([root, cwd])) {
      write(scope, "package.json", '{"type":"module"}');
      const modules = path.join(scope, "node_modules");
      if (scope === root || isolated) {
        write(
          modules,
          `${tool}/package.json`,
          JSON.stringify({
            type: "module",
            exports: { "./package.json": "./package.json" },
            bin: { [tool]: "bin.mjs" },
          }),
        );
        entry = write(
          modules,
          `${tool}/bin.mjs`,
          `import fs from "node:fs";
fs.writeFileSync(process.env.PACKAGE_BIN_CAPTURE, JSON.stringify({
  args: process.argv.slice(2), entry: process.argv[1], cwd: process.cwd(),
  marker: process.env.PACKAGE_BIN_MARKER
}));
process.exitCode = 17;
`,
        );
      }
      write(modules, `.bin/${tool}`, "#!/bin/sh\nexit 91\n", 0o755);
      write(modules, `.bin/${tool}.cmd`, "@exit /b 91\r\n");
    }
    const result = spawnSync(process.execPath, [script, tool, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, PACKAGE_BIN_CAPTURE: capture, PACKAGE_BIN_MARKER: "forwarded" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(17);
    expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toEqual({
      args,
      entry,
      cwd,
      marker: "forwarded",
    });
  },
);
