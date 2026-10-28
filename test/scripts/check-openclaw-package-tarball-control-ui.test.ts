import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mts";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { CODE_MODE_WORKER_PATH, withTarball } from "./package-tarball-fixture.js";
import { preparedScriptWrapperEnv } from "./prepared-script-wrapper.test-support.js";

const spawnOptions = { encoding: "utf8", timeout: 30_000 } as const;
const CONTROL_UI_INDEX = "dist/control-ui/index.html";
const CONTROL_UI_ASSETS = ["", ".br", ".gz"].map((ext) => `dist/control-ui/assets/app.js${ext}`);
const CONTROL_UI_FILES = [CONTROL_UI_INDEX, ...CONTROL_UI_ASSETS];
const CHECK_SCRIPT = resolve("scripts/check-openclaw-package-tarball.mjs");

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

it.each([false, true])("validates complete inventory=%s against UI survival", (survives) => {
  const inventory = ["dist/index.js", ...(survives ? CONTROL_UI_FILES : []), CODE_MODE_WORKER_PATH];
  withTarball(
    inventory,
    {
      "dist/index.js": "export {};\n",
      [CONTROL_UI_INDEX]: '<!doctype html><script type="module" src="./assets/app.js"></script>\n',
      ...Object.fromEntries(CONTROL_UI_ASSETS.map((file) => [file, "export {};\n"])),
    },
    (tarball, root) => {
      expect(fs.existsSync(tarball)).toBe(true);
      const result = checkPackedPackage(tarball);
      expect(result.status === 0, result.stderr).toBe(survives);
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
    },
    undefined,
    {
      pack: "npm",
      postinstall: true,
      packageJson: { type: "module" },
      inventoryBody: JSON.stringify(inventory),
      beforePack(packageRoot) {
        for (const file of [
          "scripts/postinstall-bundled-plugins.mjs",
          "scripts/lib/fs-safe-prebuild.mjs",
          "scripts/lib/fs-safe-npm-cli-preload.generated.mjs",
          "scripts/lib/fs-safe-npm-cli-protocol.mjs",
          "runtime-process-bootstrap.generated.mjs",
          "scripts/windows-cmd-helpers.mjs",
          "scripts/lib/package-lifecycle-marker.mjs",
        ]) {
          const destination = join(packageRoot, file);
          fs.mkdirSync(dirname(destination), { recursive: true });
          fs.copyFileSync(resolve(file), destination);
        }
      },
    },
  );
});
