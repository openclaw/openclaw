import type { SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  writeNpmBeforePolicyFixture,
  writeNpmFreshnessConflictFixture,
  writeNpmInstallRetryFixture,
  writeNpmRawConfigFixture,
  writeNpmLifecycleFixture,
} from "./install-npm-fixtures.js";
import { linkPnpmBootstrapShellTools } from "./test-helpers.js";

type InstallerContract = {
  scriptPath: string;
  runShell: (script: string, env?: NodeJS.ProcessEnv) => SpawnSyncReturns<string>;
  nodeExecutable: string;
  prefix: boolean;
  createTempDir: (prefix: string) => string;
};

export function defineInstallerShellIsolationContract({
  runShell,
  createTempDir,
}: InstallerContract) {
  it.each(["0", "1"])(
    "isolates installer shell startup and logout files at SHLVL=%s",
    (shellLevel) => {
      const root = createTempDir("openclaw-install-shell-env-");
      const home = join(root, "fixture home");
      const calls = join(root, "startup-calls");
      mkdirSync(home);
      for (const file of [
        ".bashrc",
        ".bash_profile",
        ".bash_login",
        ".profile",
        ".bash_logout",
        "bash_env",
        "env",
      ]) {
        writeFileSync(
          join(home, file),
          `printf '%s\\n' '${file}' >> "$INSTALLER_STARTUP_CALLS"\n${file === ".bash_logout" ? "exit 71\n" : ""}`,
        );
      }
      const result = runShell("printf 'home=%s\\n' \"$HOME\"\nexit 0", {
        HOME: home,
        SHLVL: shellLevel,
        BASH_ENV: join(home, "bash_env"),
        ENV: join(home, "env"),
        INSTALLER_STARTUP_CALLS: calls,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toBe(`home=${home}\n`);
      expect(existsSync(calls)).toBe(false);
    },
  );
}

export function defineInstallerPnpmContract({
  scriptPath: SCRIPT_PATH,
  runShell,
  nodeExecutable,
  createTempDir,
}: InstallerContract) {
  const script = readFileSync(SCRIPT_PATH, "utf8");
  it("preserves explicit pnpm prefer-offline settings", () => {
    const result = runShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      run_pnpm() { printf 'undefined\n'; }
      unset PNPM_CONFIG_PREFER_OFFLINE pnpm_config_prefer_offline
      if should_prefer_offline_pnpm_install; then printf 'default=true\\n'; fi
      PNPM_CONFIG_PREFER_OFFLINE=false
      if should_prefer_offline_pnpm_install; then printf 'upper=true\\n'; else printf 'upper=false\\n'; fi
      unset PNPM_CONFIG_PREFER_OFFLINE
      pnpm_config_prefer_offline=false
      if should_prefer_offline_pnpm_install; then printf 'lower=true\\n'; else printf 'lower=false\\n'; fi
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("default=true");
    expect(result.stdout).toContain("upper=false");
    expect(result.stdout).toContain("lower=false");
    expect(script).toContain(
      'run_pnpm -C "$repo_dir" install ${pnpm_prefer_offline_args[@]+"${pnpm_prefer_offline_args[@]}"} "$install_lockfile_flag"',
    );
  });

  it.each([
    ["undefined", "true"],
    ["null", "true"],
    ["false", "false"],
    ["true", "false"],
    ["failure", "false"],
  ])("uses pnpm's effective prefer-offline config when it returns %s", (configured, expected) => {
    const result = runShell(
      [
        "set -euo pipefail",
        `source "${SCRIPT_PATH}"`,
        'run_pnpm() { [[ "$*" == "-C $PWD config get prefer-offline" ]]; [[ "$CONFIGURED" != "failure" ]] || return 1; printf "%s\\n" "$CONFIGURED"; }',
        "unset PNPM_CONFIG_PREFER_OFFLINE pnpm_config_prefer_offline",
        'if should_prefer_offline_pnpm_install "$PWD"; then printf "result=true\\n"; else printf "result=false\\n"; fi',
      ].join("\n"),
      { CONFIGURED: configured },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`result=${expected}`);
  });

  it.each([
    ["corepack", "12.0.0", ""],
    ["missing", "12.0.0", ""],
    ["failing", "12.0.0", ""],
    ["corepack", "11.15.1", ""],
    ["missing", "11.15.1", ""],
    ["failing", "11.15.1", ""],
    ["corepack", "12.0.0", "install"],
    ["missing", "12.0.0", "build"],
  ])(
    "keeps selected pnpm through install and nested build (%s, %s, failure=%s)",
    (mode, version, failure) => {
      const tmp = createTempDir("openclaw-install-pnpm-boundary-");
      const bin = join(tmp, "bin");
      const repo = join(tmp, "repo");
      const outer = join(tmp, "outer");
      const temp = join(tmp, "temp");
      for (const dir of [bin, repo, outer, temp]) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ packageManager: `pnpm@${version}` }),
      );
      writeFileSync(join(repo, "pnpm-lock.yaml"), "unchanged lock\n");
      writeFileSync(join(outer, "package.json"), '{"packageManager":"yarn@4.5.0"}');
      linkPnpmBootstrapShellTools(bin);
      symlinkSync(nodeExecutable, join(bin, "node"));
      const executable = (name: string, body: string) => {
        writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`);
        chmodSync(join(bin, name), 0o755);
      };
      executable(
        "pnpm",
        `
      echo "$*" >> "$FIXTURE/ambient.log"
      echo corrupted > "$TARGET/pnpm-lock.yaml"
      if [[ "$1" == --version ]]; then echo "$VERSION"; fi
    `,
      );
      executable(
        "selected",
        `
      [[ "\${COREPACK_ENABLE_DOWNLOAD_PROMPT:-}" == 0 ]] || { echo "Corepack would await terminal input" >&2; exit 91; }
      [[ -z "\${CI:-}" ]]
      [[ "$PWD" == "$TARGET" ]]
      [[ "$NPM_CONFIG_WORKSPACE_DIR" == "$TARGET" && "$npm_config_workspace_dir" == "$TARGET" ]]
      [[ "$PNPM_CONFIG_LOCKFILE_DIR" == "$TARGET" && "$pnpm_config_lockfile_dir" == "$TARGET" ]]
      case "$1" in
        --version) echo "$VERSION" ;;
        config) echo undefined ;;
        install) [[ "$2" == --frozen-lockfile ]]; echo install >> "$FIXTURE/steps"; [[ "$FAILURE" != install ]] || exit 42 ;;
        build) echo build >> "$FIXTURE/steps"; pnpm nested ;;
        nested) [[ "$FAILURE" != build ]] || exit 42; echo "nested:$VERSION" >> "$FIXTURE/steps" ;;
        *) exit 90 ;;
      esac
    `,
      );
      executable(
        "npm",
        `
      if [[ "$1" == --version ]]; then echo 12.0.0; exit; fi
      [[ "$1 $2 $3" == 'install -g --prefix' ]]
      [[ "$4" == "$FIXTURE/"* && "$4" != "$TARGET" ]]
      [[ "$5" == "pnpm@$VERSION" && "$6" == "--allow-scripts=pnpm@$VERSION" ]]
      mkdir -p "$4/bin"
      cp "$FIXTURE/bin/selected" "$4/bin/pnpm"
      echo "$4" > "$FIXTURE/npm-prefix"
    `,
      );
      if (mode !== "missing") {
        executable(
          "corepack",
          `
        [[ "$1 $2" == 'enable --install-directory' && "$4" == pnpm ]]
        [[ "$3" == "$FIXTURE/"* ]]
        cp "$FIXTURE/bin/selected" "$3/pnpm"
        ${mode === "failing" ? 'echo "#!/bin/bash" > "$3/pnpm"; echo "exit 1" >> "$3/pnpm"' : ":"}
      `,
        );
      }
      const result = runShell(
        [
          "set -euo pipefail",
          "unset CI",
          `source '${SCRIPT_PATH}'`,
          'PREFIX="$FIXTURE/prefix"',
          'node_bin() { printf "%s\\n" "$FIXTURE/bin/node"; }',
          'npm_bin() { printf "%s\\n" "$FIXTURE/bin/npm"; }',
          'cd "$FOREIGN"',
          'ensure_pnpm "$TARGET"',
          'run_pnpm -C "$TARGET" config get prefer-offline',
          'run_pnpm -C "$TARGET" install --frozen-lockfile',
          'run_pnpm -C "$TARGET" build',
          '[[ "$NPM_CONFIG_WORKSPACE_DIR" == "$FOREIGN" && "$npm_config_workspace_dir" == "$FOREIGN" ]]',
          '[[ "$PNPM_CONFIG_LOCKFILE_DIR" == "$FOREIGN" && "$pnpm_config_lockfile_dir" == "$FOREIGN" ]]',
          '[[ "$(command -v pnpm)" == "$FIXTURE/bin/pnpm" ]]',
          '[[ "$COREPACK_ENABLE_DOWNLOAD_PROMPT" == 1 ]]',
          "echo completed",
        ].join("\n"),
        {
          PATH: bin,
          COREPACK_ENABLE_DOWNLOAD_PROMPT: "1",
          TMPDIR: temp,
          HOME: tmp,
          FIXTURE: tmp,
          TARGET: repo,
          FOREIGN: outer,
          VERSION: version,
          FAILURE: failure,
          NPM_CONFIG_WORKSPACE_DIR: outer,
          npm_config_workspace_dir: outer,
          PNPM_CONFIG_LOCKFILE_DIR: outer,
          pnpm_config_lockfile_dir: outer,
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(failure ? 42 : 0);
      expect(readFileSync(join(repo, "pnpm-lock.yaml"), "utf8")).toBe("unchanged lock\n");
      expect(existsSync(join(tmp, "ambient.log"))).toBe(false);
      expect(result.stdout.includes("completed")).toBe(!failure);
      expect(readFileSync(join(tmp, "steps"), "utf8").trim().split("\n")).toEqual(
        failure === "install"
          ? ["install"]
          : failure === "build"
            ? ["install", "build"]
            : ["install", "build", `nested:${version}`],
      );
      expect(existsSync(join(tmp, "npm-prefix"))).toBe(mode !== "corepack");
      expect(readdirSync(temp)).toEqual([]);
    },
  );
}

export function defineInstallerNpmConfigContract({
  scriptPath,
  runShell,
  nodeExecutable,
  prefix,
  createTempDir,
}: InstallerContract) {
  const cases = [
    {
      name: "does not emit --before when raw user npmrc config contains min-release-age",
      source: "user",
    },
    {
      name: "does not emit --before when default global npmrc config contains min-release-age",
      source: "global",
    },
    {
      name: "does not emit --before when builtin npmrc config contains min-release-age",
      source: "builtin",
    },
  ];
  const runCase = ({ source }: (typeof cases)[number]) => {
    const root = createTempDir("openclaw-install-npmrc-");
    const bin = join(root, "bin");
    const home = join(root, "home");
    const configPrefix = join(root, "prefix");
    const npmrc =
      source === "user"
        ? join(root, "user.npmrc")
        : source === "global"
          ? join(configPrefix, "etc", "npmrc")
          : join(root, "npmrc");
    const calls = join(root, "npm-calls.txt");
    const installArgs = join(root, "npm-install-args.txt");
    const nodeDir = join(root, "node");
    const fakeNpm = join(bin, "npm");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home);
    mkdirSync(join(configPrefix, "etc"), { recursive: true });
    writeFileSync(npmrc, "min-release-age=7\n");
    if (prefix) {
      writeInstalledEntry(nodeDir, nodeExecutable);
    }
    const logCalls = !prefix || source !== "user";
    writeNpmRawConfigFixture(fakeNpm, {
      prefixInstaller: prefix,
      globalConfig: source !== "user",
      logCalls,
    });
    const result = runShell(
      [
        "set -euo pipefail",
        `cd ${JSON.stringify(process.cwd())}`,
        `source ${JSON.stringify(scriptPath)}`,
        "npm_lifecycle_allow_arg() { :; }",
        ...(prefix
          ? [
              `npm_bin() { printf '%s\\n' ${JSON.stringify(fakeNpm)}; }`,
              `node_dir() { printf '%s\\n' ${JSON.stringify(nodeDir)}; }`,
              "emit_json() { :; }",
              "log() { :; }",
              `PREFIX=${JSON.stringify(join(root, "install-prefix"))}`,
              "SET_NPM_PREFIX=0",
              "OPENCLAW_VERSION=1.2.3",
              "install_openclaw",
            ]
          : [
              `run_npm_global_install openclaw@latest ${JSON.stringify(join(root, "install.log"))}`,
              'printf "cmd=%s\\n" "$LAST_NPM_INSTALL_CMD"',
            ]),
      ].join("\n"),
      {
        ...(prefix && source === "user" ? {} : { HOME: home }),
        ...(source === "user"
          ? { NPM_CONFIG_USERCONFIG: npmrc }
          : {
              NPM_CONFIG_GLOBALCONFIG: undefined,
              NPM_CONFIG_PREFIX: undefined,
              npm_config_globalconfig: undefined,
              npm_config_prefix: undefined,
              NPM_FAKE_GLOBALCONFIG:
                source === "global" ? npmrc : join(root, "missing-global-npmrc"),
            }),
        NPM_FAKE_CALLS: calls,
        NPM_FAKE_INSTALL_ARGS: installArgs,
        PATH: `${bin}:${!prefix && source === "user" ? "/usr/local/bin:/usr/bin:/bin" : process.env.PATH}`,
      },
    );
    expect(result.status).toBe(0);
    if (!prefix) {
      expect(result.stdout).toContain("--min-release-age=0");
      expect(result.stdout).not.toContain("--before=");
    }
    expect(readFileSync(installArgs, "utf8")).toContain("--min-release-age=0\n");
    expect(readFileSync(installArgs, "utf8")).not.toContain("--before=");
    if (logCalls) {
      expect(readFileSync(calls, "utf8")).not.toContain("config get before");
    }
  };
  for (const scenario of cases) {
    if (prefix && scenario.source !== "user") {
      it.each([scenario])("$name", runCase);
    } else {
      it(scenario.name, () => runCase(scenario));
    }
  }
}

function writeInstalledEntry(nodeDir: string, nodeExecutable: string) {
  mkdirSync(join(nodeDir, "bin"), { recursive: true });
  symlinkSync(nodeExecutable, join(nodeDir, "bin", "node"));
  const entry = join(nodeDir, "lib", "node_modules", "openclaw", "dist", "entry.js");
  mkdirSync(join(entry, ".."), { recursive: true });
  writeFileSync(entry, "");
}

function npmRetryFixture({
  scriptPath,
  runShell,
  nodeExecutable,
  prefix,
  createTempDir,
}: InstallerContract) {
  const root = createTempDir("openclaw-install-npm-retry-");
  const bin = join(root, "bin");
  const calls = join(root, "calls");
  const nodeDir = join(root, "node");
  const installPrefix = join(root, "prefix");
  const npmRoot = join(prefix ? nodeDir : root, "lib", "node_modules");
  const nodeBin = prefix ? join(nodeDir, "bin") : bin;
  const npm = prefix ? join(root, "npm") : join(bin, "npm");
  mkdirSync(nodeBin, { recursive: true });
  symlinkSync(nodeExecutable, join(nodeBin, "node"));
  writeNpmInstallRetryFixture(npm);
  return {
    calls,
    wrapper: join(installPrefix, "bin", "openclaw"),
    run(requested: string, outcome: string, error: string, packageProduced = true) {
      return runShell(
        [
          "set -euo pipefail",
          `source ${JSON.stringify(scriptPath)}`,
          ...(prefix
            ? [
                `npm_bin() { printf '%s\\n' ${JSON.stringify(npm)}; }`,
                `node_dir() { printf '%s\\n' ${JSON.stringify(nodeDir)}; }`,
                "npm_config_has_raw_key() { return 1; }",
                `PREFIX=${JSON.stringify(installPrefix)}`,
                "JSON=1",
              ]
            : [
                `PATH=${JSON.stringify(`${bin}:/usr/bin:/bin`)}`,
                "USE_BETA=0",
                "NPM_LOGLEVEL=error",
                `npm_global_bin_dir() { printf '%s\\n' ${JSON.stringify(bin)}; }`,
              ]),
          `OPENCLAW_VERSION=${requested}`,
          ...(packageProduced
            ? ["set +e", "install_openclaw", "status=$?", 'exit "$status"']
            : ["install_openclaw"]),
        ].join("\n"),
        {
          NPM_FAKE_CALLS: calls,
          NPM_FAKE_ERROR: error,
          NPM_FAKE_OUTCOME: outcome,
          ...(packageProduced ? { NPM_FAKE_PACKAGE_DIR: join(npmRoot, "openclaw") } : {}),
          ...(prefix ? {} : { NPM_FAKE_ROOT: npmRoot }),
        },
      );
    },
  };
}

export function defineInstallerNpmRetryContract(installer: InstallerContract) {
  it.each([
    { requested: "latest", outcome: "success", error: "", calls: 1, status: 0 },
    {
      requested: "beta",
      outcome: "transient",
      error: "ECONNRESET socket hang up",
      calls: 2,
      status: 0,
    },
    {
      requested: "next",
      outcome: "transient",
      error: "ECONNRESET socket hang up",
      calls: 2,
      status: 0,
    },
    {
      requested: "2026.8.1",
      outcome: "transient",
      error: "ECONNRESET socket hang up",
      calls: 2,
      status: 0,
    },
    {
      requested: "latest",
      outcome: "persistent",
      error: "EACCES permission denied",
      calls: 2,
      status: 1,
    },
    {
      requested: "beta",
      outcome: "persistent",
      error: "ENOSPC no space left",
      calls: 2,
      status: 1,
    },
  ])(
    "keeps openclaw@$requested immutable across $outcome npm installs",
    ({ requested, outcome, error, calls, status }) => {
      const fixture = npmRetryFixture(installer);
      const result = fixture.run(requested, outcome, error);
      expect(result.status).toBe(status);
      expect(readFileSync(fixture.calls, "utf8").trim().split("\n")).toEqual(
        Array.from({ length: calls }, () => `openclaw@${requested}`),
      );
      const output = `${result.stdout}\n${result.stderr}`;
      if (installer.prefix) {
        if (status !== 0) {
          expect(result.stderr).toContain(`${error} (attempt 2)`);
          expect(result.stdout).not.toContain('"status":"ok"');
          expect(existsSync(fixture.wrapper)).toBe(false);
        }
      } else {
        const advertisedLogs = [...output.matchAll(/^\s*Installer log:\s*(.+)$/gm)]
          .map((match) => match[1]?.trim())
          .filter((logPath) => logPath !== undefined);
        expect(advertisedLogs.filter((logPath) => !existsSync(logPath))).toEqual([]);
        if (status !== 0) {
          expect(output).toContain(`${error} (attempt 2)`);
          expect(output).toContain("showing last log lines");
        }
      }
      if (requested !== "next") {
        expect(output).not.toContain("openclaw@next");
      }
    },
  );

  it("fails after retrying the exact npm spec when npm exits zero without installing OpenClaw", () => {
    const fixture = npmRetryFixture(installer);
    const result = fixture.run("latest", "success", "", false);
    expect(result.status).toBe(1);
    expect(readFileSync(fixture.calls, "utf8").trim().split("\n")).toEqual([
      "openclaw@latest",
      "openclaw@latest",
    ]);
    const output = installer.prefix ? result.stdout : `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("npm install did not produce a usable OpenClaw package");
    expect(output).not.toContain("openclaw@next");
    if (installer.prefix) {
      expect(result.stdout).not.toContain('"status":"ok"');
      expect(existsSync(fixture.wrapper)).toBe(false);
    }
  });
}

export function defineInstallerNpmFreshnessContract({
  scriptPath,
  runShell,
  nodeExecutable,
  prefix,
  createTempDir,
}: InstallerContract) {
  for (const { name, projectConfig } of [
    {
      name: "does not emit before args when npmrc min-release-age computes a before cutoff",
      projectConfig: false,
    },
    {
      name: "ignores project npmrc when choosing global install freshness args",
      projectConfig: true,
    },
  ]) {
    it(name, () => {
      const root = createTempDir("openclaw-install-freshness-");
      const installPrefix = join(root, "prefix");
      const home = join(root, "home");
      const project = join(root, "project");
      const nodeDir = join(installPrefix, "tools", "node-v24.19.0");
      const bin = prefix ? join(nodeDir, "bin") : join(root, "bin");
      const argsLog = join(root, "npm-args.log");
      if (prefix) {
        writeInstalledEntry(nodeDir, nodeExecutable);
      } else {
        mkdirSync(bin, { recursive: true });
        symlinkSync(nodeExecutable, join(bin, "node"));
      }
      mkdirSync(home);
      writeFileSync(
        join(home, ".npmrc"),
        projectConfig ? "before=2026-01-01T00:00:00.000Z\n" : "min-release-age=7\n",
      );
      if (projectConfig) {
        mkdirSync(project);
        writeFileSync(join(project, ".npmrc"), "min-release-age=7\n");
      }
      const writeNpm = projectConfig
        ? writeNpmBeforePolicyFixture
        : writeNpmFreshnessConflictFixture;
      writeNpm(join(bin, "npm"), argsLog);
      const result = runShell(
        [
          "set -euo pipefail",
          ...(projectConfig ? [`cd ${JSON.stringify(project)}`] : []),
          ...(prefix
            ? [
                `HOME=${JSON.stringify(home)}`,
                `OPENCLAW_PREFIX=${JSON.stringify(installPrefix)}`,
                "OPENCLAW_VERSION=2026.5.19",
              ]
            : []),
          `source ${JSON.stringify(projectConfig ? resolve(scriptPath) : scriptPath)}`,
          ...(prefix
            ? ["ensure_git() { return 0; }", "install_openclaw"]
            : [
                `HOME=${JSON.stringify(home)}`,
                `PATH=${JSON.stringify(`${bin}:/usr/bin:/bin`)}`,
                "NPM_LOGLEVEL=error",
                `run_npm_global_install openclaw@latest ${JSON.stringify(join(root, "install.log"))}`,
              ]),
        ].join("\n"),
      );
      const argsOutput = readFileSync(argsLog, "utf8");
      expect(result.status).toBe(0);
      expect(argsOutput).toContain(projectConfig ? "--before=" : "--min-release-age=0");
      expect(argsOutput).not.toContain(projectConfig ? "--min-release-age=0" : "--before=");
    });
  }
}

function npmIdentityFixture(
  { scriptPath, runShell, nodeExecutable, prefix, createTempDir }: InstallerContract,
  tempPrefix: string,
) {
  const root = createTempDir(tempPrefix);
  const npm = join(root, "npm");
  const cwd = join(root, "work");
  mkdirSync(cwd);
  writeNpmLifecycleFixture(npm);
  return {
    root,
    run(spec: string) {
      return runShell(
        [
          `source ${JSON.stringify(scriptPath)}`,
          ...(prefix ? [`node_bin() { printf '%s\\n' ${JSON.stringify(nodeExecutable)}; }`] : []),
          `cd ${JSON.stringify(cwd)}`,
          `npm_lifecycle_allow_arg ${JSON.stringify(npm)} ${JSON.stringify(spec)} "$PWD"`,
        ].join("\n"),
        { NPM_FAKE_VERSION: "12.0.0" },
      );
    },
  };
}

export function defineInstallerNpmArchiveIdentityContract(installer: InstallerContract) {
  it.each(["absolute", "relative", "file:absolute", "file:relative"])(
    "uses the absolute npm tarball identity for %s input",
    (form) => {
      const fixture = npmIdentityFixture(installer, "openclaw-install-archive-identity-");
      const candidate = join(fixture.root, "candidate.tgz");
      const protocol = form.startsWith("file:") ? "file:" : "";
      const spec = `${protocol}${form.endsWith("relative") ? "../candidate.tgz" : candidate}`;
      const result = fixture.run(spec);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(`--allow-scripts=${protocol}${candidate}`);
    },
  );
}

export function defineInstallerNpmDirectoryIdentityContract(installer: InstallerContract) {
  it("retains relative directory identities under comma ancestors", () => {
    const fixture = npmIdentityFixture(installer, "openclaw-install-identity-comma,");
    const result = fixture.run(join(fixture.root, "candidate"));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("--allow-scripts=../candidate");
  });
}
