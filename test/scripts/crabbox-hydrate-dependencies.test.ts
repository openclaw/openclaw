import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { pnpmLockfileDocuments } from "../../scripts/lib/pnpm-lockfile-documents.mjs";
import { resolvePnpmRunner } from "../../scripts/pnpm-runner.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const packageManager: string = JSON.parse(readFileSync("package.json", "utf8")).packageManager;
const workflow = parse(readFileSync(".github/workflows/crabbox-hydrate.yml", "utf8")) as {
  env: Record<string, string>;
  jobs: Record<"hydrate" | "hydrate-github", { steps: Array<{ name?: string; run?: string }> }>;
};

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function write(root: string, relative: string, contents: string, mode?: number) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, { mode });
}

describe.skipIf(process.platform === "win32")("Crabbox dependency hydration", () => {
  it.each([
    ["default hydration", "fresh"],
    ["shared setup action", "fresh"],
    ["default hydration", "legacy"],
    ["GitHub hydration", "legacy"],
    ["default hydration", "unknown"],
    ["GitHub hydration", "unknown"],
    ["default hydration", "unknown-newline"],
    ["default hydration", "fallback"],
    ["default hydration", "fallback-dangling"],
    ["default hydration", "configured-fallback"],
    ["default hydration", "unknown-fallback"],
  ] as const)(
    "%s handles %s dependencies during frozen installs",
    (entrypoint, initialState) => {
      const job = entrypoint === "GitHub hydration" ? "hydrate-github" : "hydrate";
      const root = tempDirs.make("openclaw-hydrate-dependencies-");
      const workspace = path.join(root, "workspace");
      const ui = path.join(workspace, "ui");
      const bin = path.join(root, "bin");
      const installRoot = path.join(root, "external-install");
      const store = path.join(root, "store");
      const runnerTemp = path.join(root, "runner");
      const usesFallback = [
        "fallback",
        "fallback-dangling",
        "configured-fallback",
        "unknown-fallback",
      ].includes(initialState);
      const cacheRoot =
        initialState === "configured-fallback"
          ? path.join(root, "configured cache with spaces")
          : initialState === "unknown-fallback"
            ? path.join(root, "unrelated-cache")
            : path.join(runnerTemp, "cache");
      for (const directory of [workspace, ui, bin, runnerTemp, store]) {
        mkdirSync(directory, { recursive: true });
      }
      for (const [name, value] of [
        ["hydrate-proof", "root dependency"],
        ["hydrate-ui-proof", "UI dependency"],
        ["typescript", "typescript fixture"],
      ]) {
        write(
          root,
          `deps/${name}/package.json`,
          JSON.stringify({
            name,
            version: "1.0.0",
            main: "index.cjs",
            ...(name === "hydrate-proof" ? { bin: { oxfmt: "cli.cjs" } } : {}),
          }),
        );
        write(root, `deps/${name}/index.cjs`, `module.exports = ${JSON.stringify(value)};\n`);
      }
      write(
        root,
        "deps/hydrate-proof/cli.cjs",
        '#!/usr/bin/env node\nconsole.log("CLI dependency");\n',
        0o755,
      );
      write(
        workspace,
        "package.json",
        JSON.stringify({
          name: "hydrate-workspace",
          private: true,
          packageManager,
          scripts: {
            "pnpm-path": "node -p process.env.npm_execpath",
            "pnpm:devPreinstall": "node scripts/check-install-dependency-ownership.mjs",
          },
          dependencies: {
            "hydrate-proof": "file:../deps/hydrate-proof",
            typescript: "file:../deps/typescript",
          },
        }),
      );
      write(
        ui,
        "package.json",
        JSON.stringify({
          name: "hydrate-ui",
          private: true,
          dependencies: { "hydrate-ui-proof": "file:../../deps/hydrate-ui-proof" },
        }),
      );
      write(
        workspace,
        "pnpm-workspace.yaml",
        "packages:\n  - .\n  - ui\nnodeLinker: isolated\nverifyDepsBeforeRun: false\n",
      );
      write(
        workspace,
        "scripts/tsx.mjs",
        'import assert from "node:assert/strict";\nimport value from "hydrate-proof";\nassert.equal(value, "root dependency");\n',
      );
      copyFileSync(
        "scripts/check-install-dependency-ownership.mjs",
        path.join(workspace, "scripts/check-install-dependency-ownership.mjs"),
      );

      // Preserve pnpm's pinned environment so bootstrap does not query a registry.
      const { environment } = pnpmLockfileDocuments(readFileSync("pnpm-lock.yaml", "utf8"));
      if (environment !== null) {
        write(workspace, "pnpm-lock.yaml", `---\n${environment}\n---\n`);
      }
      const nodeExecPath = resolveTestNodeExecPath();
      const bootstrap = resolvePnpmRunner({ nodeExecPath });
      const npmExecPath = execFileSync(
        bootstrap.command,
        [...bootstrap.args, "--silent", "run", "pnpm-path"],
        {
          cwd: workspace,
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            COREPACK_ENABLE_NETWORK: "0",
            PNPM_CONFIG_REGISTRY: "http://127.0.0.1:9",
            PNPM_CONFIG_FETCH_RETRIES: "0",
          },
        },
      ).trim();
      const pnpm = resolvePnpmRunner({ nodeExecPath, npmExecPath });
      // The setup action prepends NODE_BIN; keep Node and the pinned pnpm runner together.
      symlinkSync(nodeExecPath, path.join(bin, "node"));
      write(
        bin,
        "pnpm",
        `#!/usr/bin/env bash\nexec ${[pnpm.command, ...pnpm.args].map(shellQuote).join(" ")} "$@"\n`,
        0o755,
      );
      if (spawnSync("bash", ["-c", "command -v setsid"], { encoding: "utf8" }).status !== 0) {
        // macOS lacks Linux process groups; these installs exercise only normal exit.
        write(bin, "setsid", '#!/usr/bin/env bash\nexec "$@"\n', 0o755);
      }
      const env: NodeJS.ProcessEnv = {
        PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: path.join(root, "home"),
        CI: "true",
        COREPACK_ENABLE_NETWORK: "0",
        PNPM_CONFIG_REGISTRY: "http://127.0.0.1:9",
        PNPM_CONFIG_FETCH_RETRIES: "0",
        PNPM_CONFIG_STORE_DIR: store,
        GITHUB_WORKSPACE: workspace,
        GITHUB_ENV: path.join(root, "github-env"),
        RUNNER_TEMP: runnerTemp,
        NODE_BIN: bin,
        DEPENDENCY_CACHE: "false",
        DEPENDENCY_CACHE_HIT: "false",
        FROZEN_LOCKFILE: "true",
      };
      if (initialState === "configured-fallback") {
        env.XDG_CACHE_HOME = cacheRoot;
      }
      mkdirSync(env.HOME!, { recursive: true });
      const run = (command: string, args: string[], cwd = workspace) => {
        const result = spawnSync(command, args, {
          cwd,
          env,
          encoding: "utf8",
          timeout: 30_000,
        });
        expect(result.status, `${result.error ?? ""}\n${result.stdout}${result.stderr}`).toBe(0);
        return result.stdout.trim();
      };
      expect(`pnpm@${run("pnpm", ["--version"])}`).toBe(packageManager.split("+")[0]);
      run("pnpm", ["install", "--lockfile-only", "--offline", "--ignore-scripts"]);

      const externalRoot = usesFallback
        ? path.join(cacheRoot, "openclaw/pnpm/install")
        : initialState === "unknown"
          ? path.join(root, "unrelated-install")
          : installRoot;
      const legacyStore = usesFallback ? path.join(cacheRoot, "openclaw/pnpm/store") : store;
      const externalModules = path.join(externalRoot, "node_modules");
      const linkedModules =
        initialState === "unknown-newline" ? `${externalModules}\n` : externalModules;
      let externalMetadata: string | undefined;
      if (initialState !== "fresh") {
        run("pnpm", [
          "install",
          "--offline",
          "--frozen-lockfile",
          `--config.modules-dir=${externalModules}`,
          `--config.virtual-store-dir=${path.join(externalRoot, "virtual-store")}`,
          `--config.store-dir=${legacyStore}`,
        ]);
        externalMetadata = readFileSync(path.join(externalModules, ".modules.yaml"), "utf8");
        write(externalRoot, "virtual-store/retained-cache", "legacy package cache\n");
        write(legacyStore, "retained-cache", "shared package store\n");
        write(store, "retained-cache", "shared package store\n");
        // Reproduce the old workflow's final relocation after a real successful install.
        rmSync(path.join(workspace, "node_modules"), { recursive: true, force: true });
        symlinkSync(linkedModules, path.join(workspace, "node_modules"));

        const handoff = path.join(env.HOME!, ".crabbox/actions/hydration-proof.env");
        const exports = `${handoff}.sh`;
        const legacyExports =
          job === "hydrate-github"
            ? `export PNPM_CONFIG_MODULES_DIR=${shellQuote(externalModules)}\nexport PNPM_CONFIG_VIRTUAL_STORE_DIR=${shellQuote(path.join(externalRoot, "virtual-store"))}\n`
            : `export CRABBOX_PNPM_MODULES_DIR=${shellQuote(externalModules)}\n`;
        write(
          root,
          path.relative(root, handoff),
          `WORKSPACE=${workspace}\nRUN_ID=fixture\nJOB=${job}\nENV_FILE=${exports}\nSERVICES_FILE=${handoff.replace(/\.env$/u, ".services")}\nREADY_AT=2026-09-14T00:00:00Z\n`,
        );
        write(
          root,
          path.relative(root, exports),
          `export CI=true\nexport GITHUB_WORKSPACE=${shellQuote(workspace)}\nexport GITHUB_RUN_ID=fixture\nexport PNPM_CONFIG_STORE_DIR=${shellQuote(legacyStore)}\n${usesFallback ? `export XDG_CACHE_HOME=${shellQuote(cacheRoot)}\n` : ""}${legacyExports}`,
        );
        // Released Crabbox clears both native handoff markers before starting rehydration.
        rmSync(handoff);
        rmSync(exports);
        expect(existsSync(handoff) || existsSync(exports)).toBe(false);
        if (initialState === "fallback-dangling") {
          // Native rehydration recreates the same lease's runner root before workflow steps.
          rmSync(runnerTemp, { recursive: true });
          mkdirSync(runnerTemp);
          expect(existsSync(externalModules)).toBe(false);
          expect(readlinkSync(path.join(workspace, "node_modules"))).toBe(linkedModules);
        }
      }

      let script: string;
      const steps = workflow.jobs[job].steps;
      const setupName =
        entrypoint === "default hydration"
          ? "Setup pnpm and dependencies"
          : "Setup Node environment";
      const setupIndex = steps.findIndex((step) => step.name === setupName);
      if (entrypoint === "default hydration") {
        for (const [name, value] of Object.entries(workflow.env)) {
          env[name] = value.replaceAll("/var/tmp/openclaw-pnpm", installRoot);
        }
        const setup = steps[setupIndex]?.run;
        expect(setup).toBeDefined();
        const start = setup!.indexOf("install_args=(");
        expect(start).toBeGreaterThan(0);
        // Toolchain bootstrap is already pinned above; execute the workflow's install boundary.
        script = `set -euo pipefail\npreferred_pnpm_store=${shellQuote(store)}\npnpm_install_root=${shellQuote(installRoot)}\n${setup!.slice(start)}`;
      } else {
        if (entrypoint === "shared setup action") {
          env.PNPM_CONFIG_MODULES_DIR = path.join(workspace, "node_modules");
        }
        script = readFileSync(".github/actions/setup-node-env/install-dependencies.sh", "utf8");
      }
      if (entrypoint !== "shared setup action") {
        expect(setupIndex).toBeGreaterThanOrEqual(0);
        const retirement = steps
          .slice(0, setupIndex)
          .find((step) => step.name === "Retire legacy Crabbox dependencies")?.run;
        script = `${retirement ?? ""}\n${script}`.replaceAll("/var/tmp/openclaw-pnpm", installRoot);
      }

      if (
        initialState === "unknown" ||
        initialState === "unknown-newline" ||
        initialState === "unknown-fallback"
      ) {
        const rejected = spawnSync("bash", ["-c", script], {
          cwd: workspace,
          env,
          encoding: "utf8",
          timeout: 30_000,
        });
        expect(rejected.status).toBe(1);
        expect(`${rejected.stdout}${rejected.stderr}`).toContain(
          "Refusing to reconcile dependencies through",
        );
        expect(readlinkSync(path.join(workspace, "node_modules"))).toBe(linkedModules);
      } else {
        for (let install = 0; install < 2; install++) {
          run("bash", ["-c", script]);
          expect(run(process.execPath, ["-p", "require('hydrate-proof')"])).toBe("root dependency");
          expect(run(process.execPath, ["-p", "require('hydrate-ui-proof')"], ui)).toBe(
            "UI dependency",
          );
          expect(run(path.join(workspace, "node_modules/.bin/oxfmt"), [])).toBe("CLI dependency");
          for (const relative of ["node_modules", "node_modules/.pnpm", "ui/node_modules"]) {
            expect(lstatSync(path.join(workspace, relative)).isDirectory(), relative).toBe(true);
          }
          const virtualStore = realpathSync(path.join(workspace, "node_modules/.pnpm"));
          for (const [importer, dependency] of [
            [workspace, "hydrate-proof"],
            [ui, "hydrate-ui-proof"],
          ] as const) {
            expect(
              realpathSync(path.join(importer, "node_modules", dependency)).startsWith(
                `${virtualStore}${path.sep}`,
              ),
              dependency,
            ).toBe(true);
          }
          run(process.execPath, ["scripts/check-install-dependency-ownership.mjs"]);
        }
      }
      if (initialState !== "fresh") {
        if (initialState === "fallback-dangling") {
          expect(existsSync(externalRoot)).toBe(false);
          expect(existsSync(legacyStore)).toBe(false);
        } else {
          expect(readFileSync(path.join(externalModules, ".modules.yaml"), "utf8")).toBe(
            externalMetadata,
          );
          expect(
            readFileSync(path.join(externalRoot, "virtual-store/retained-cache"), "utf8"),
          ).toBe("legacy package cache\n");
          expect(readFileSync(path.join(legacyStore, "retained-cache"), "utf8")).toBe(
            "shared package store\n",
          );
        }
        expect(readFileSync(path.join(store, "retained-cache"), "utf8")).toBe(
          "shared package store\n",
        );
      }
    },
    90_000,
  );
});
