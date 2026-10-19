import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WORKSPACE_TEMPLATE_PACK_PATHS } from "../../scripts/lib/workspace-bootstrap-smoke.mts";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mts";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { preparedScriptWrapperEnv } from "./prepared-script-wrapper.test-support.js";

const spawnOptions = { encoding: "utf8", timeout: 30_000 } as const;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const CONTROL_UI_INDEX = "dist/control-ui/index.html";
const CODE_MODE_WORKER_PATH = "dist/agents/code-mode.worker.js";
const CONTROL_UI_ASSETS = ["", ".br", ".gz"].map((ext) => `dist/control-ui/assets/app.js${ext}`);
const CONTROL_UI_FILES = [CONTROL_UI_INDEX, ...CONTROL_UI_ASSETS];
const CHECK_SCRIPT = resolve("scripts/check-openclaw-package-tarball.mjs");

function chmodTreeWorldReadable(dir: string): void {
  fs.chmodSync(dir, 0o755);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      chmodTreeWorldReadable(entryPath);
    } else {
      fs.chmodSync(entryPath, fs.statSync(entryPath).mode & 0o111 ? 0o755 : 0o644);
    }
  }
}

function pack(inventory: readonly string[], postinstall = true) {
  const root = tempDirs.make("openclaw-control-ui-package-inventory-");
  const packageRoot = join(root, "package");
  const write = (file: string, content: string) => {
    const target = join(packageRoot, file);
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write(
    "package.json",
    JSON.stringify({
      name: "openclaw",
      version: "2026.7.2",
      type: "module",
      scripts: postinstall
        ? { postinstall: "node scripts/postinstall-bundled-plugins.mjs" }
        : undefined,
    }),
  );
  write(
    "dist/postinstall-inventory.json",
    JSON.stringify([...new Set([...inventory, CODE_MODE_WORKER_PATH])]),
  );
  write(CONTROL_UI_INDEX, '<!doctype html><script type="module" src="./assets/app.js"></script>\n');
  for (const assetPath of ["dist/index.js", CODE_MODE_WORKER_PATH, ...CONTROL_UI_ASSETS]) {
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
    fs.mkdirSync(dirname(destination), { recursive: true });
    fs.copyFileSync(resolve(relativePath), destination);
  }
  chmodTreeWorldReadable(packageRoot);

  const packed = spawnSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
    {
      ...spawnOptions,
      cwd: packageRoot,
    },
  );
  expect(packed.status, packed.stderr || packed.error?.message).toBe(0);
  // npm <=11 `pack --json` emits an array; npm 12 emits an object keyed by package name.
  const parsed = JSON.parse(packed.stdout) as
    | { filename: string }[]
    | Record<string, { filename: string }>;
  const packResult = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  const tarball = join(root, packResult?.filename ?? "");
  expect(fs.existsSync(tarball)).toBe(true);
  return { root, tarball };
}

function checkPackedPackage(tarball: string) {
  return spawnSync(process.execPath, [CHECK_SCRIPT, tarball], {
    ...spawnOptions,
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
    fs.mkdirSync(directory, { recursive: true });
  }
  const installRoot = join(root, "installed");
  const result = spawnSync(
    "npm",
    [
      ..."install --foreground-scripts --dangerously-allow-all-scripts --prefix".split(" "),
      installRoot,
      ..."--no-audit --no-fund --offline".split(" "),
      tarball,
    ],
    {
      ...spawnOptions,
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

it.each([
  [false, false],
  [true, false],
  [true, true],
])(
  "validates postinstall=%s, complete inventory=%s against UI survival",
  (postinstall, survives) => {
    const { root, tarball } = pack(
      ["dist/index.js", ...(survives ? CONTROL_UI_FILES : [])],
      postinstall,
    );
    const result = checkPackedPackage(tarball);
    expect(result.status === 0, result.stderr).toBe(!postinstall || survives);
    if (postinstall) {
      const installedPackageRoot = installPackedPackage(root, tarball);
      expect(fs.existsSync(join(installedPackageRoot, "dist/index.js"))).toBe(true);
      for (const relativePath of CONTROL_UI_FILES) {
        expect(fs.existsSync(join(installedPackageRoot, relativePath))).toBe(survives);
      }
      if (survives) {
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
        expect(fs.existsSync(join(installedPackageRoot, CODE_MODE_WORKER_PATH))).toBe(true);
      } else {
        const errors = result.stderr.split(/\r?\n/u);
        for (const relativePath of CONTROL_UI_FILES) {
          expect
            .soft(errors)
            .toContain(`postinstall inventory omits packaged dist file ${relativePath}`);
        }
      }
    }
  },
);
