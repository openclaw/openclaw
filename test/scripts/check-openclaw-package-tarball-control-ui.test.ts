import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_TEMPLATE_PACK_PATHS } from "../../scripts/lib/workspace-bootstrap-smoke.mts";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mts";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { preparedScriptWrapperEnv } from "./prepared-script-wrapper.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const CONTROL_UI_INDEX = "dist/control-ui/index.html";
const CODE_MODE_WORKER_PATH = "dist/agents/code-mode.worker.js";
const CONTROL_UI_ASSETS = [
  "dist/control-ui/assets/app.js",
  "dist/control-ui/assets/app.js.br",
  "dist/control-ui/assets/app.js.gz",
] as const;
const CONTROL_UI_FILES = [CONTROL_UI_INDEX, ...CONTROL_UI_ASSETS];
const CHECK_SCRIPT = resolve("scripts/check-openclaw-package-tarball.mjs");

function writeFixtureFile(packageRoot: string, relativePath: string, content: string): void {
  const filePath = join(packageRoot, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function chmodTreeWorldReadable(dir: string): void {
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      chmodTreeWorldReadable(entryPath);
    } else {
      chmodSync(entryPath, statSync(entryPath).mode & 0o111 ? 0o755 : 0o644);
    }
  }
}

function pack(inventory: readonly string[], options: { postinstall?: boolean } = {}) {
  const root = tempDirs.make("openclaw-control-ui-package-inventory-");
  const packageRoot = join(root, "package");
  const write = (file: string, content: string) => writeFixtureFile(packageRoot, file, content);
  mkdirSync(packageRoot, { recursive: true });
  write(
    "package.json",
    JSON.stringify({
      name: "openclaw",
      version: "2026.7.2",
      type: "module",
      scripts:
        options.postinstall === false
          ? undefined
          : { postinstall: "node scripts/postinstall-bundled-plugins.mjs" },
    }),
  );
  write(
    "dist/postinstall-inventory.json",
    JSON.stringify([...new Set([...inventory, CODE_MODE_WORKER_PATH])]),
  );
  write("dist/index.js", "export {};\n");
  write(CODE_MODE_WORKER_PATH, "export {};\n");
  write(CONTROL_UI_INDEX, '<!doctype html><script type="module" src="./assets/app.js"></script>\n');
  for (const assetPath of CONTROL_UI_ASSETS) {
    write(assetPath, "export {};\n");
  }
  write(".openclaw-lifecycle-pending", "pending\n");
  for (const relativePath of WORKSPACE_TEMPLATE_PACK_PATHS) {
    write(relativePath, `# ${relativePath}\n`);
  }
  for (const relativePath of [
    "scripts/postinstall-bundled-plugins.mjs",
    "scripts/lib/fs-safe-prebuild.mjs",
    "scripts/windows-cmd-helpers.mjs",
    "scripts/lib/package-lifecycle-marker.mjs",
  ]) {
    const destination = join(packageRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(resolve(relativePath), destination);
  }
  chmodTreeWorldReadable(packageRoot);

  const packed = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], {
    cwd: packageRoot,
  });
  expect(packed.status, packed.stderr || packed.error?.message).toBe(0);
  // npm <=11 `pack --json` emits an array; npm 12 emits an object keyed by package name.
  const parsed = JSON.parse(packed.stdout) as
    | { filename: string }[]
    | Record<string, { filename: string }>;
  const packResult = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  const filename = packResult?.filename ?? "";
  const tarball = join(root, filename);
  expect(existsSync(tarball)).toBe(true);
  return { root, tarball };
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 30_000, ...options });
}

function checkPackedPackage(tarball: string) {
  return run(process.execPath, [CHECK_SCRIPT, tarball], {
    env: preparedScriptWrapperEnv([
      [
        new URL("../../scripts/check-openclaw-package-tarball.mts", import.meta.url),
        resolveRuntimeWorkerUrl(scriptModuleEntrypoints.packageTarball),
      ],
    ]),
  });
}

function installPackedPackage(root: string, tarball: string) {
  const home = join(root, "home");
  const state = join(root, "state");
  const temporary = join(root, "tmp");
  for (const directory of [home, state, temporary]) {
    mkdirSync(directory, { recursive: true });
  }
  const installRoot = join(root, "installed");
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(
    join(installRoot, "package.json"),
    `${JSON.stringify({ private: true }, null, 2)}\n`,
  );
  const result = run(
    "npm",
    [
      "install",
      "--foreground-scripts",
      "--dangerously-allow-all-scripts",
      "--prefix",
      installRoot,
      "--no-audit",
      "--no-fund",
      "--offline",
      tarball,
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        OPENCLAW_HOME: home,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: join(state, "openclaw.json"),
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary,
      },
    },
  );
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  return join(installRoot, "node_modules", "openclaw");
}

describe("packaged Control UI postinstall inventory", () => {
  it.each([false, true])(
    "validates inventory against actual postinstall UI survival: %s",
    (survives) => {
      const { root, tarball } = pack(["dist/index.js", ...(survives ? CONTROL_UI_FILES : [])]);
      const result = checkPackedPackage(tarball);
      const installedPackageRoot = installPackedPackage(root, tarball);
      expect(existsSync(join(installedPackageRoot, "dist/index.js"))).toBe(true);
      for (const relativePath of CONTROL_UI_FILES) {
        expect(existsSync(join(installedPackageRoot, relativePath))).toBe(survives);
      }
      if (survives) {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
        expect(existsSync(join(installedPackageRoot, CODE_MODE_WORKER_PATH))).toBe(true);
      } else {
        expect(result.status, result.stdout).not.toBe(0);
        const errors = result.stderr.split(/\r?\n/u);
        for (const relativePath of CONTROL_UI_FILES) {
          expect
            .soft(errors)
            .toContain(`postinstall inventory omits packaged dist file ${relativePath}`);
        }
      }
    },
  );

  it("does not impose postinstall inventory rules on lifecycle-free archived fixtures", () => {
    const { tarball } = pack(["dist/index.js"], { postinstall: false });
    const result = checkPackedPackage(tarball);
    expect(result.status, result.stderr).toBe(0);
  });
});
