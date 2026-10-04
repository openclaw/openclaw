import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCommandEnv } from "./exec-spawn.js";
import { runCommandWithTimeout } from "./exec.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const require = createRequire(import.meta.url);

it.skipIf(process.platform === "win32")(
  "hands an explicit Node runtime to npm preinstall children",
  async () => {
    const root = dirs.make("npm-lifecycle-node-");
    const privateBin = path.join(root, "private", "bin");
    const systemBin = path.join(root, "system", "bin");
    await fs.mkdir(privateBin, { recursive: true });
    await fs.mkdir(systemBin, { recursive: true });
    const privateNode = path.join(privateBin, "node");
    await fs.symlink(process.execPath, privateNode);
    await fs.writeFile(path.join(systemBin, "node"), "#!/bin/sh\necho v22.22.3\n", { mode: 0o755 });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "runtime-handoff-fixture",
        version: "1.0.0",
        scripts: { preinstall: 'node -p "process.version"' },
      }),
    );
    const npmCli = path.join(
      path.dirname(require.resolve("npm/package.json")),
      "bin",
      "npm-cli.js",
    );
    const result = await runCommandWithTimeout(
      [
        privateNode,
        npmCli,
        "install",
        "--offline",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
      ],
      {
        cwd: root,
        timeoutMs: 10_000,
        baseEnv: {},
        env: {
          HOME: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          PATH: [systemBin, process.env.PATH].join(path.delimiter),
          npm_config_cache: path.join(root, "cache"),
          npm_config_userconfig: path.join(root, "empty-npmrc"),
          npm_config_globalconfig: path.join(root, "empty-global-npmrc"),
        },
      },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(process.version);
    expect(result.stdout).not.toContain("v22.22.3");
  },
);

it.each(["npm-cli.js", "pnpm.cjs", "pnpm.js"])(
  "preserves Windows PATH casing and npm config for an explicit %s runtime",
  (cli) => {
    const env = { Path: "C:\\system;C:\\private", npm_config_node: "operator-choice" };
    const result = resolveCommandEnv({
      argv: ["C:\\private\\node.exe", `C:\\tools\\${cli}`, "install"],
      baseEnv: {},
      env,
      platform: "win32",
    });
    expect(result.Path).toBe("C:\\private;C:\\system");
    expect(result.PATH).toBeUndefined();
    expect(result.npm_config_node).toBe("operator-choice");
    expect(env.Path).toBe("C:\\system;C:\\private");
  },
);

it.each(["npm", "pnpm", "bun"])("keeps the caller's runtime selection for plain %s", (manager) => {
  const env = { PATH: "/selected/bin:/system/bin", npm_config_node: "operator-choice" };
  const result = resolveCommandEnv({ argv: [manager, "install"], baseEnv: {}, env });
  expect(result.PATH).toBe(env.PATH);
  expect(result.npm_config_node).toBe(env.npm_config_node);
});
