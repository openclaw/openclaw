import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { parse, parseDocument } from "yaml";
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

function resolveCachedPnpmExecPath() {
  const version = /^pnpm@([^+]+)/u.exec(packageManager)?.[1];
  const corepackHome = process.env.COREPACK_HOME;
  if (!version || !corepackHome) {
    return undefined;
  }
  const candidate = path.join(corepackHome, "v1", "pnpm", version, "bin", "pnpm.mjs");
  return existsSync(candidate) ? candidate : undefined;
}

function write(root: string, relative: string, contents: string, mode?: number) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, { mode });
}

describe.skipIf(process.platform === "win32")("Crabbox dependency hydration", () => {
  it.skipIf(process.getuid?.() === 0).each([
    ["hydrate", 0],
    ["hydrate-github", 0],
    ["hydrate", 1],
  ] as const)("prepares %s UI E2E prerequisites (pnpm exit %s)", (job, pnpmExit) => {
    // Physical paths: the step walks `pwd -P`, and macOS temp roots sit behind /var symlinks.
    const root = realpathSync(tempDirs.make("openclaw-ui-e2e-hydrate-"));
    const lease = path.join(root, "lease");
    const workspace = path.join(lease, "openclaw");
    const artifacts = path.join(workspace, ".artifacts");
    const bin = path.join(root, "bin");
    const calls = path.join(root, "calls");
    const chmodCalls = path.join(root, "chmod-calls");
    mkdirSync(workspace, { recursive: true });
    chmodSync(lease, 0o775);
    chmodSync(workspace, 0o775);
    if (pnpmExit === 0) {
      mkdirSync(artifacts);
      chmodSync(artifacts, 0o777);
    }
    write(
      bin,
      "node",
      '#!/bin/sh\nprintf "node" >> "$CALLS"\nprintf " <%s>" "$@" >> "$CALLS"\nprintf "\\n" >> "$CALLS"\n',
      0o755,
    );
    write(
      bin,
      "pnpm",
      `#!/bin/sh\nprintf "pnpm" >> "$CALLS"\nprintf " <%s>" "$@" >> "$CALLS"\nprintf "\\n" >> "$CALLS"\nexit ${pnpmExit}\n`,
      0o755,
    );
    write(
      bin,
      "chmod",
      // Record every walked directory but only mutate this test's own tree.
      '#!/bin/sh\nprintf "%s\\n" "$2" >> "$CHMOD_CALLS"\ncase "$2" in "$ROOT"/*|.artifacts) exec /bin/chmod "$@" ;; esac\n',
      0o755,
    );
    let unowned = workspace;
    while (lstatSync(unowned).uid === process.getuid?.()) {
      unowned = path.dirname(unowned);
    }
    const unownedMode = lstatSync(unowned).mode;
    const prepare = workflow.jobs[job].steps.find(
      (step) => step.name === "Prepare Control UI E2E environment",
    );
    expect(prepare?.run).toBeDefined();
    const result = spawnSync("bash", ["-c", `umask 0002\n${prepare!.run}`], {
      cwd: workspace,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        CALLS: calls,
        CHMOD_CALLS: chmodCalls,
        CI: "true",
        ROOT: root,
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(pnpmExit);
    for (const directory of [lease, workspace, artifacts]) {
      expect(lstatSync(directory).mode & 0o022, directory).toBe(0);
    }
    const changedDirectories = readFileSync(chmodCalls, "utf8").trim().split("\n");
    expect(changedDirectories).not.toContain(unowned);
    expect(changedDirectories).not.toContain("/");
    expect(lstatSync(unowned).mode).toBe(unownedMode);
    expect(readFileSync(calls, "utf8")).toBe(
      "node <--import> <./scripts/tsx.mjs> <scripts/ensure-playwright-chromium.mts> <--require-playwright-chromium>\n" +
        "pnpm <--dir> <ui> <exec> <playwright> <install> <--with-deps> <webkit>\n",
    );
  });

  it.each(["hydrate", "hydrate-github"] as const)(
    "%s hands off a POSIX umask without loosening stricter masks",
    (job) => {
      const home = tempDirs.make("openclaw-hydrate-umask-");
      const bin = path.join(home, "bin");
      write(bin, "docker", "#!/bin/sh\nexit 1\n", 0o755);
      const ready = workflow.jobs[job].steps.find((step) => step.name === "Mark Crabbox ready");
      expect(ready?.run).toBeDefined();
      const env = {
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        CI: "true",
        CRABBOX_ID: "ui-e2e",
        CRABBOX_JOB: job,
        GITHUB_WORKSPACE: home,
        GITHUB_RUN_ID: "123",
      };
      const marked = spawnSync("bash", ["-c", ready!.run!], { env, encoding: "utf8" });
      expect(marked.status, marked.stderr).toBe(0);
      const envFile = path.join(home, ".crabbox/actions/ui-e2e.env.sh");
      writeFileSync(envFile, `${readFileSync(envFile, "utf8")}export CRABBOX_APPENDED=retained\n`);
      for (const [initial, expected] of [
        ["0002", "0022"],
        ["0077", "0077"],
      ]) {
        const restored = spawnSync(
          "sh",
          [
            "-c",
            `umask ${initial}; . "$ENV_FILE"; umask; printf '%s\\n' "$CI" "$GITHUB_WORKSPACE" "$CRABBOX_APPENDED"`,
          ],
          {
            env: { PATH: "/usr/bin:/bin", ENV_FILE: envFile },
            encoding: "utf8",
          },
        );
        expect(restored.status, restored.stderr).toBe(0);
        expect(restored.stdout).toBe(`${expected}\ntrue\n${home}\nretained\n`);
      }
    },
  );

  it.each(["true", "false", "invalid"])(
    "preserves frozen policy through pnpm bootstrap and workspace config (%s)",
    (frozen) => {
      const root = tempDirs.make("openclaw-frozen-bootstrap-");
      const bin = path.join(root, "bin");
      mkdirSync(bin);
      symlinkSync(resolveTestNodeExecPath(), path.join(bin, "node"));
      const lock = path.join(root, "pnpm-lock.yaml");
      const calls = path.join(root, "pnpm-calls");
      writeFileSync(lock, "original\n");
      write(
        bin,
        "pnpm",
        `#!/bin/bash
printf '%s\\n' "$*" >> "$PNPM_CALLS"
# pnpm 10 applies workspace frozenLockfile:false after its environment settings.
if [ "$1" = install ]; then
  case " $* " in
    *" --frozen-lockfile "*) ;;
    *) printf 'rewritten\\n' > "$PNPM_LOCK" ;;
  esac
elif [ "\${PNPM_CONFIG_FROZEN_LOCKFILE:-}" != true ]; then
  printf 'rewritten\\n' > "$PNPM_LOCK"
fi
`,
        0o755,
      );
      const result = spawnSync("bash", [".github/actions/setup-node-env/install-dependencies.sh"], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          NODE_BIN: bin,
          FROZEN_LOCKFILE: frozen,
          DEPENDENCY_CACHE: "false",
          DEPENDENCY_CACHE_HIT: "false",
          PNPM_CALLS: calls,
          PNPM_LOCK: lock,
        },
      });
      expect(result.status, result.stderr).toBe(frozen === "invalid" ? 2 : 0);
      expect(readFileSync(lock, "utf8")).toBe(frozen === "false" ? "rewritten\n" : "original\n");
      expect(existsSync(calls)).toBe(frozen !== "invalid");
    },
  );

  it.skipIf(process.platform !== "linux").each(["failed", "complete", "incomplete"] as const)(
    "settles one pnpm attempt with %s install artifacts",
    (outcome) => {
      const root = tempDirs.make("openclaw-hydrate-install-result-");
      const bin = path.join(root, "bin");
      const calls = path.join(root, "calls");
      mkdirSync(bin);
      symlinkSync(resolveTestNodeExecPath(), path.join(bin, "node"));
      write(root, "scripts/tsx.mjs", "");
      if (outcome === "complete") {
        write(root, "node_modules/.modules.yaml", "verified: true\n");
        write(root, "node_modules/.bin/oxfmt", "#!/bin/sh\nexit 0\n", 0o755);
        write(root, "node_modules/typescript/package.json", '{"name":"typescript"}\n');
      }
      write(
        bin,
        "pnpm",
        [
          "#!/bin/bash",
          'printf "%s\\n" "$*" >> "$PNPM_CALLS"',
          outcome === "failed"
            ? "exit 42"
            : "printf 'Done in 1ms using pnpm v12.0.0\\n'\nexec sleep 60",
          "",
        ].join("\n"),
        0o755,
      );
      const setup = workflow.jobs.hydrate.steps.find(
        (step) => step.name === "Setup pnpm and dependencies",
      )?.run;
      expect(setup).toBeDefined();
      const start = setup!.indexOf("install_args=(");
      expect(start).toBeGreaterThan(0);
      const result = spawnSync("bash", ["-c", "set -euo pipefail\n" + setup!.slice(start)], {
        cwd: root,
        env: {
          PATH: bin + ":/usr/bin:/bin",
          PNPM_CALLS: calls,
          PNPM_CONFIG_STORE_DIR: path.join(root, "store"),
          RUNNER_TEMP: root,
        },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(
        outcome === "complete" ? 0 : outcome === "failed" ? 42 : 1,
      );
      expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
      if (outcome !== "failed") {
        expect(result.stdout).toContain("pnpm printed its completion marker but did not exit");
        expect(result.stdout).toContain(
          outcome === "complete"
            ? "pnpm install artifacts verified after exit-hang termination"
            : "pnpm exit-hang termination left incomplete install artifacts",
        );
      }
    },
    45_000,
  );

  it.each([
    ["default hydration", "fresh"],
    ["shared setup action", "fresh"],
    ["default hydration", "legacy"],
    ["GitHub hydration", "legacy"],
    ["GitHub hydration", "unknown"],
    ["default hydration", "unknown-newline"],
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
            ...(entrypoint === "shared setup action" ? { postinstall: "pnpm --version" } : {}),
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
      const npmExecPath =
        resolveCachedPnpmExecPath() ??
        execFileSync(bootstrap.command, [...bootstrap.args, "--silent", "run", "pnpm-path"], {
          cwd: workspace,
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            COREPACK_ENABLE_NETWORK: "0",
            PNPM_CONFIG_REGISTRY: "http://127.0.0.1:9",
            PNPM_CONFIG_FETCH_RETRIES: "0",
          },
        }).trim();
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
        // Version probes can hide failed bootstrap work behind a successful exit.
        expect(result.stderr).not.toContain("ERR_PNPM_BAD_CONFIG_DEP");
        return result.stdout.trim();
      };
      expect(`pnpm@${run("pnpm", ["--version"])}`).toBe(packageManager.split("+")[0]);
      const manifestPath = path.join(workspace, "package.json");
      const manifest = readFileSync(manifestPath, "utf8");
      // Generate local dependency resolutions without asking offline pnpm to resolve itself.
      writeFileSync(
        manifestPath,
        JSON.stringify({ ...JSON.parse(manifest), packageManager: undefined }),
      );
      run("pnpm", ["install", "--lockfile-only", "--offline", "--ignore-scripts"]);
      writeFileSync(manifestPath, manifest);
      const lockfilePath = path.join(workspace, "pnpm-lock.yaml");
      if (environment !== null) {
        const { dependencies } = pnpmLockfileDocuments(readFileSync(lockfilePath, "utf8"));
        writeFileSync(lockfilePath, `---\n${environment}\n---\n${dependencies}`);
      }

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

        // Released Crabbox clears both native handoff markers before starting rehydration.
        if (initialState === "fallback-dangling") {
          // Native rehydration recreates the same lease's runner root before workflow steps.
          rmSync(runnerTemp, { recursive: true });
          mkdirSync(runnerTemp);
          expect(existsSync(externalModules)).toBe(false);
          expect(readlinkSync(path.join(workspace, "node_modules"))).toBe(linkedModules);
        }
      }

      let frozenLockfile: string | undefined;
      if (entrypoint === "shared setup action") {
        // Corepack's marker makes version probes synchronize the environment lockfile.
        env.COREPACK_ROOT = root;
        const { environment: managerEnvironment, dependencies } = pnpmLockfileDocuments(
          readFileSync(lockfilePath, "utf8"),
        );
        if (managerEnvironment !== null) {
          const document = parseDocument(managerEnvironment);
          const managers = ["importers", ".", "packageManagerDependencies"];
          // This unused engine already has real package and snapshot records.
          document.setIn(
            [...managers, "@pnpm/exe.linux-x64"],
            document.getIn([...managers, "pnpm"]),
          );
          writeFileSync(lockfilePath, `---\n${document.toString()}\n---\n${dependencies}`);
        }
        frozenLockfile = readFileSync(lockfilePath, "utf8");
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
          if (frozenLockfile !== undefined) {
            expect(readFileSync(path.join(workspace, "pnpm-lock.yaml"), "utf8")).toBe(
              frozenLockfile,
            );
          }
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
