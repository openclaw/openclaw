import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, parse, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindGitInvocation } from "../../scripts/pr-lib/git-invocation.mjs";
import { execPrGh, execPrGhAsync } from "../../scripts/pr-lib/github.mjs";
import { resolveWindowsSystem32Path } from "../../scripts/windows-cmd-helpers.mjs";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createIndependentPrFixtureEnv, delegatingGitFixture } from "./pr-wrapper.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("selected Git invocation context", () => {
  function fixture() {
    const root = tempDirs.make("openclaw-pr-git-context-");
    const backend = join(root, "backend's bin");
    const adapter = join(root, "adapter");
    const poison = join(root, "alternate");
    for (const path of [backend, adapter, poison]) {
      mkdirSync(path);
    }
    const node = requireNodeTool("node");
    const records = join(root, "backend-calls");
    writeFileSync(
      join(backend, "git"),
      `#!${node}
require("node:fs").appendFileSync(process.env.PR_TEST_RECORDS, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), policy: process.env.GIT_CONFIG_PARAMETERS, depth: process.env.PR_TEST_GIT_DEPTH }) + "\\n");
process.exit(Number(process.env.PR_TEST_EXIT || 0));
`,
      { mode: 0o755 },
    );
    writeFileSync(join(poison, "git"), "#!/bin/sh\necho 'alternate backend' >&2\nexit 99\n", {
      mode: 0o755,
    });
    const guard = delegatingGitFixture(root, {
      ...createIndependentPrFixtureEnv(),
      PATH: `${backend}${delimiter}${process.env.PATH ?? ""}`,
      PR_TEST_RECORDS: records,
      GIT_CONFIG_PARAMETERS: "'fixture.policy=preserved'",
    });
    return { root, adapter, poison, node, records, guard };
  }

  it("binds direct, shell and Node children to the exact guard and original backend PATH", () => {
    const f = fixture();
    const bound = bindGitInvocation(f.adapter, f.guard.selected, f.guard.env);
    const args = ["argument with spaces", "quote'", "", "line\nbreak"];
    const run = (file: string, argv: string[], env = bound.env) =>
      spawnSync(file, argv, { cwd: f.root, env, encoding: "utf8" });
    expect(run(bound.executable, args, { ...bound.env, PATH: f.poison }).status).toBe(0);
    expect(run("/bin/sh", ["-c", 'git "$@"', "git-child", ...args]).status).toBe(0);
    expect(
      run(f.node, [
        "-e",
        'require("node:child_process").execFileSync("git", process.argv.slice(1), { stdio: "inherit" })',
        ...args,
      ]).status,
    ).toBe(0);
    const denied = run(bound.executable, args, { ...bound.env, PR_TEST_EXIT: "73" });
    expect(denied.status, denied.stderr).toBe(73);
    const records = readFileSync(f.records, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(4);
    for (const record of records) {
      expect(record).toEqual({
        args,
        cwd: f.root,
        policy: "'fixture.policy=preserved'",
        depth: "1",
      });
    }
    expect(bound.env.OPENCLAW_PR_GIT).toBe(bound.executable);
    expect(bound.env.GIT_EXEC).toBe(bound.executable);
  });

  it.each([false, true])(
    "preserves the same selected policy for GitHub calls (async=%s)",
    async (asynchronous) => {
      const f = fixture();
      const gh = join(f.root, "gh");
      writeFileSync(
        gh,
        `#!${f.node}
const result = require("node:child_process").spawnSync("git", process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
        { mode: 0o755 },
      );
      const options = {
        cwd: f.root,
        env: { ...f.guard.env, OPENCLAW_GH_BIN: gh, GH_TOKEN: "fixture-token" },
        encoding: "utf8" as const,
      };
      const args = ["api", "fixture endpoint", "quote'", ""];
      if (asynchronous) {
        await execPrGhAsync(args, options, "plain");
      } else {
        execPrGh(args, options, "plain");
      }
      expect(JSON.parse(readFileSync(f.records, "utf8"))).toEqual({
        args,
        cwd: f.root,
        policy: "'fixture.policy=preserved'",
        depth: "1",
      });
      const denied = { ...options, env: { ...options.env, PR_TEST_EXIT: "73" } };
      const failure = Promise.resolve().then(() =>
        asynchronous ? execPrGhAsync(args, denied, "plain") : execPrGh(args, denied, "plain"),
      );
      await expect(failure).rejects.toMatchObject({ status: 73 });
    },
  );
  it.skipIf(process.platform !== "darwin")(
    "uses actual native GH with the selected policy for offline lookup in each child cwd",
    async () => {
      const root = tempDirs.make("openclaw-pr-posix-native-gh-");
      const env = createIndependentPrFixtureEnv();
      for (const key of Object.keys(env)) {
        if (
          /^(?:GH_|GITHUB_|GIT_|GCM_|OPENCLAW_PR_)/i.test(key) ||
          ["openclaw_gh_bin", "home", "xdg_config_home", "godebug"].includes(key.toLowerCase())
        ) {
          delete env[key];
        }
      }
      const home = join(root, "home"),
        ghConfig = join(root, "gh-config");
      for (const path of [home, ghConfig]) {
        mkdirSync(path);
      }
      const globalConfig = join(home, ".gitconfig");
      writeFileSync(globalConfig, "[credential]\n\thelper =\n");
      writeFileSync(join(ghConfig, "config.yml"), "git_protocol: https\nprompt: disabled\n");
      writeFileSync(join(ghConfig, "hosts.yml"), "{}\n");
      Object.assign(env, {
        HOME: home,
        XDG_CONFIG_HOME: home,
        GH_CONFIG_DIR: ghConfig,
        GH_HOST: "github.com",
        GH_TOKEN: "fixture-token-not-a-credential",
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
        GH_TELEMETRY: "disabled",
        DO_NOT_TRACK: "1",
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      });
      const nativeTool = (name: "gh" | "git") => {
        const found = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "lookup", name], {
          cwd: root,
          env,
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(found.status, `actual native ${name} is required: ${found.stderr}`).toBe(0);
        const path = realpathSync(found.stdout.trim());
        expect(statSync(path).isFile()).toBe(true);
        const binary = readFileSync(path);
        expect(binary.subarray(0, 2).toString()).not.toBe("#!");
        const version = spawnSync(path, ["--version"], {
          cwd: root,
          env,
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(version.status, version.stderr).toBe(0);
        expect(version.stdout).toMatch(
          name === "gh" ? /^gh version \d+\.\d+\.\d+/ : /^git version /,
        );
        console.info(
          "native POSIX tool identity",
          JSON.stringify({
            tool: name,
            path,
            version: version.stdout.trim(),
            sha256: createHash("sha256").update(binary).digest("hex"),
          }),
        );
        return path;
      };
      const gh = nativeTool("gh"),
        git = nativeTool("git");
      const calls = join(root, "policy-calls"),
        denial = join(root, "policy-denied");
      const selected = join(root, "selected git'policy");
      const node = requireNodeTool("node");
      writeFileSync(
        selected,
        `#!${node}
const fs = require("node:fs");
const record = { args: process.argv.slice(2), cwd: process.cwd(), policy: process.env.GIT_CONFIG_PARAMETERS, depth: Number(process.env.PR_TEST_GIT_DEPTH || 0) + 1 };
fs.appendFileSync(process.env.PR_TEST_GIT_CALLS, JSON.stringify(record) + "\\n");
if (process.env.PR_TEST_GIT_DENY === "1") {
  fs.appendFileSync(process.env.PR_TEST_GIT_DENIAL, JSON.stringify(record) + "\\n");
  console.error("selected Git policy refused");
  process.exit(73);
}
const child = require("node:child_process").spawnSync(process.env.PR_TEST_NATIVE_GIT, process.argv.slice(2), { stdio: "inherit" });
if (child.error) throw child.error;
process.exit(child.status ?? 1);
`,
        { mode: 0o755 },
      );
      Object.assign(env, {
        OPENCLAW_GH_BIN: gh,
        OPENCLAW_PR_GIT: selected,
        GIT_EXEC: selected,
        PR_TEST_NATIVE_GIT: git,
        PR_TEST_GIT_CALLS: calls,
        PR_TEST_GIT_DENIAL: denial,
        PR_TEST_GIT_DEPTH: "0",
        GIT_CONFIG_PARAMETERS: "'fixture.policy=preserved'",
      });
      const repositories = [
        { cwd: join(root, "first"), name: "fixture-one/alpha" },
        { cwd: join(root, "second"), name: "fixture-two/beta" },
      ];
      const cwdBypass = join(root, "cwd-git-started");
      for (const { cwd, name } of repositories) {
        mkdirSync(cwd);
        for (const args of [
          ["init", "--template="],
          ["remote", "add", "origin", `https://github.com/${name}.git`],
          ["config", "remote.origin.gh-resolved", "base"],
        ]) {
          const result = spawnSync(git, args, { cwd, env, encoding: "utf8", timeout: 10_000 });
          expect(result.status, result.stderr).toBe(0);
        }
        writeFileSync(
          join(cwd, "git"),
          `#!${node}
require("node:fs").writeFileSync(${JSON.stringify(cwdBypass)}, "unexpected cwd Git");
process.exit(99);
`,
          { mode: 0o755 },
        );
      }
      const configPaths = [
        globalConfig,
        join(ghConfig, "config.yml"),
        join(ghConfig, "hosts.yml"),
        ...repositories.map(({ cwd }) => join(cwd, ".git", "config")),
      ];
      const before = configPaths.map((path) => readFileSync(path));
      const beforeNames = readdirSync(ghConfig).toSorted();
      const readCalls = () =>
        existsSync(calls)
          ? readFileSync(calls, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
          : [];
      // GH's local --view path returns before HTTP construction; the real policy
      // receipt proves native GH reached the selected executable in both modes.
      for (const { cwd, name } of repositories) {
        for (const asynchronous of [false, true]) {
          const count = readCalls().length;
          const options = { cwd, env, encoding: "utf8" as const, timeout: 10_000 };
          const result = asynchronous
            ? await execPrGhAsync(["repo", "set-default", "--view"], options, "plain")
            : execPrGh(["repo", "set-default", "--view"], options, "plain");
          expect(String(result).trim()).toBe(name);
          const observed = readCalls().slice(count);
          expect(observed.length).toBeGreaterThan(0);
          for (const record of observed) {
            expect(record).toMatchObject({ cwd, policy: "'fixture.policy=preserved'", depth: 1 });
          }
        }
      }
      for (const { cwd } of repositories) {
        for (const asynchronous of [false, true]) {
          const count = readCalls().length;
          const options = {
            cwd,
            env: { ...env, PR_TEST_GIT_DENY: "1" },
            encoding: "utf8" as const,
            timeout: 10_000,
          };
          const task = Promise.resolve().then(() =>
            asynchronous
              ? execPrGhAsync(["repo", "set-default", "--view"], options, "plain")
              : execPrGh(["repo", "set-default", "--view"], options, "plain"),
          );
          await expect(task).rejects.toMatchObject({ status: expect.any(Number) });
          await expect(task).rejects.not.toMatchObject({ status: 0 });
          const observed = readCalls().slice(count);
          expect(observed.length).toBeGreaterThan(0);
          expect(observed.every((record) => record.cwd === cwd && record.depth === 1)).toBe(true);
        }
      }
      expect(readFileSync(denial, "utf8").trim().split("\n")).toHaveLength(4);
      expect(existsSync(cwdBypass)).toBe(false);
      configPaths.forEach((path, index) => expect(readFileSync(path)).toEqual(before[index]));
      expect(readdirSync(ghConfig).toSorted()).toEqual(beforeNames);
      console.info(
        "native POSIX GH selected-policy proof",
        JSON.stringify({
          cwdCases: 2,
          modes: ["sync", "async"],
          allowed: 4,
          denied: 4,
          configUnchanged: true,
          cwdGitStarted: false,
        }),
      );
    },
    30_000,
  );
});

const describeWindows = process.platform === "win32" ? describe : describe.skip;
describeWindows("native Windows selected Git admission", () => {
  function fixture() {
    const root = tempDirs.make("openclaw-pr-native-git-");
    const env = createIndependentPrFixtureEnv();
    const where = spawnSync(resolveWindowsSystem32Path("where.exe"), ["git.exe"], {
      env,
      encoding: "utf8",
    });
    expect(where.status, where.stderr).toBe(0);
    const git = realpathSync(where.stdout.trim().split(/\r?\n/)[0]!);
    const path = Object.keys(env)
      .toSorted()
      .find((key) => key.toLowerCase() === "path");
    const inheritedPath = path ? env[path] : "";
    for (const key of Object.keys(env)) {
      if (["path", "pathext"].includes(key.toLowerCase())) {
        delete env[key];
      }
    }
    env.Path = `${dirname(git)};${inheritedPath ?? ""}`;
    env.PATHEXT = ".EXE";
    env.OPENCLAW_PR_GIT = git;
    env.GIT_EXEC = git;
    env.GH_TOKEN = "fixture-token";
    env.OPENCLAW_GH_BIN = requireNodeTool("node");
    const receipt = join(root, "gh-started");
    const cli = join(root, "fake-gh.cjs");
    writeFileSync(
      cli,
      `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ path: process.env.PATH, pathExt: process.env.PATHEXT, args: process.argv.slice(2) }));
const git = require("node:child_process").spawnSync("git", ["--version"], { stdio: "inherit" });
process.exit(git.status ?? 1);
`,
    );
    return { root, env, git, cli, receipt };
  }

  it("uses actual native GH for offline default-repository lookup in each child cwd", async () => {
    const f = fixture();
    const env: NodeJS.ProcessEnv = { ...f.env };
    // These fixtures own all authentication and Git configuration. Keep the
    // Windows runtime environment, never the worker's credential/config routes.
    for (const key of Object.keys(env)) {
      if (
        /^(?:GH_|GITHUB_|GIT_|GCM_|OPENCLAW_PR_)/i.test(key) ||
        [
          "openclaw_gh_bin",
          "home",
          "userprofile",
          "appdata",
          "localappdata",
          "xdg_config_home",
          "nodefaultcurrentdirectoryinexepath",
          "godebug",
        ].includes(key.toLowerCase())
      ) {
        delete env[key];
      }
    }
    const home = join(f.root, "home"),
      ghConfig = join(f.root, "gh-config");
    const roaming = join(home, "AppData", "Roaming"),
      local = join(home, "AppData", "Local");
    for (const path of [home, ghConfig, roaming, local]) {
      mkdirSync(path, { recursive: true });
    }
    const globalConfig = join(home, ".gitconfig");
    writeFileSync(globalConfig, "[credential]\n\thelper =\n");
    writeFileSync(join(ghConfig, "config.yml"), "git_protocol: https\nprompt: disabled\n");
    writeFileSync(join(ghConfig, "hosts.yml"), "{}\n");
    // Disabled selects NoOpService before gh creates telemetry device state.
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      APPDATA: roaming,
      LOCALAPPDATA: local,
      XDG_CONFIG_HOME: home,
      GH_CONFIG_DIR: ghConfig,
      GH_HOST: "github.com",
      GH_TOKEN: "fixture-token-not-a-credential",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      GH_TELEMETRY: "disabled",
      DO_NOT_TRACK: "1",
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    const where = spawnSync(resolveWindowsSystem32Path("where.exe"), ["gh.exe"], {
      cwd: f.root,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(
      where.status,
      "actual native gh.exe is required; a missing binary is not Windows proof",
    ).toBe(0);
    const gh = realpathSync(where.stdout.trim().split(/\r?\n/)[0]!);
    expect(statSync(gh).isFile()).toBe(true);
    const binary = readFileSync(gh);
    expect(binary.subarray(0, 2).toString()).toBe("MZ");
    const version = spawnSync(gh, ["--version"], {
      cwd: f.root,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout).toMatch(/^gh version \d+\.\d+\.\d+/);
    console.info(
      "native GH smoke identity",
      JSON.stringify({
        path: gh,
        version: version.stdout.trim(),
        sha256: createHash("sha256").update(binary).digest("hex"),
      }),
    );
    const repositories = [
      { cwd: join(f.root, "first"), name: "fixture-one/alpha", path: dirname(f.git) },
      { cwd: join(f.root, "second"), name: "fixture-two/beta", path: `"${dirname(f.git)}"` },
    ];
    const runGit = (cwd: string, args: string[]) => {
      const result = spawnSync(f.git, args, { cwd, env, encoding: "utf8", timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
    };
    for (const { cwd, name } of repositories) {
      mkdirSync(cwd);
      runGit(cwd, ["init", "--template="]);
      runGit(cwd, ["remote", "add", "origin", `https://github.com/${name}.git`]);
      runGit(cwd, ["config", "remote.origin.gh-resolved", "base"]);
      // Go safeexec must ignore an implicit cwd candidate. This invalid PE
      // would fail visibly if actual GH dispatches it instead of the PATH Git.
      writeFileSync(join(cwd, "git.exe"), "fixture sentinel: not an executable\n");
    }
    const configPaths = [
      globalConfig,
      join(ghConfig, "config.yml"),
      join(ghConfig, "hosts.yml"),
      ...repositories.map(({ cwd }) => join(cwd, ".git", "config")),
    ];
    const before = configPaths.map((path) => readFileSync(path));
    const beforeNames = readdirSync(ghConfig).toSorted();
    // GH 2.102.1 setdefault.go:136–144 returns before HttpClient/API creation;
    // gh-resolved=base keeps this command local without API calls or config writes.
    for (const { cwd, name, path } of repositories) {
      const options = {
        cwd,
        env: { ...env, Path: path, OPENCLAW_PR_GIT: f.git, GIT_EXEC: f.git, OPENCLAW_GH_BIN: gh },
        encoding: "utf8" as const,
        timeout: 10_000,
      };
      for (const asynchronous of [false, true]) {
        const args = ["repo", "set-default", "--view"];
        const result = asynchronous
          ? await execPrGhAsync(args, options, "plain")
          : execPrGh(args, options, "plain");
        expect(String(result).trim()).toBe(name);
      }
    }
    const alternate = join(f.root, "alternate.exe");
    copyFileSync(f.git, alternate);
    const denied = {
      cwd: repositories[0]!.cwd,
      env: {
        ...env,
        Path: dirname(f.git),
        OPENCLAW_PR_GIT: alternate,
        GIT_EXEC: alternate,
        OPENCLAW_GH_BIN: gh,
      },
      encoding: "utf8" as const,
      timeout: 10_000,
    };
    for (const asynchronous of [false, true]) {
      const result = Promise.resolve().then(() =>
        asynchronous
          ? execPrGhAsync(["repo", "set-default", "--view"], denied, "plain")
          : execPrGh(["repo", "set-default", "--view"], denied, "plain"),
      );
      await expect(result).rejects.toMatchObject({
        code: "OPENCLAW_PR_GIT_CAPABILITY",
        status: 78,
      });
    }
    configPaths.forEach((path, index) => expect(readFileSync(path)).toEqual(before[index]));
    expect(readdirSync(ghConfig).toSorted()).toEqual(beforeNames);
  }, 30_000);

  it.each([false, true])(
    "runs the actual PATH Git through native Node fake GH (async=%s)",
    async (asynchronous) => {
      const f = fixture();
      const args = [f.cli, "argument with spaces", "quote'", ""];
      const options = { cwd: f.root, env: f.env, encoding: "utf8" as const };
      const result = asynchronous
        ? await execPrGhAsync(args, options, "plain")
        : execPrGh(args, options, "plain");
      expect(String(result)).toMatch(/^git version /);
      expect(JSON.parse(readFileSync(f.receipt, "utf8"))).toEqual({
        path: f.env.Path,
        pathExt: ".EXE",
        args: args.slice(1),
      });
      const bound = bindGitInvocation(undefined, f.git, f.env, f.root);
      expect(bound.executable).toBe(f.git);
      expect(bound.env).toBe(f.env);
    },
  );

  it("keeps ordinary native Windows GH calls working without explicit Git selection", () => {
    const f = fixture();
    delete f.env.OPENCLAW_PR_GIT;
    delete f.env.GIT_EXEC;
    expect(
      String(execPrGh([f.cli], { cwd: f.root, env: f.env, encoding: "utf8" }, "plain")),
    ).toMatch(/^git version /);
    expect(JSON.parse(readFileSync(f.receipt, "utf8"))).toEqual({
      path: f.env.Path,
      pathExt: ".EXE",
      args: [],
    });
  });

  it.each([false, true])(
    "refuses a different policy executable before any GH child (async=%s)",
    async (asynchronous) => {
      const f = fixture();
      const alternate = join(f.root, "alternate-git.exe");
      copyFileSync(f.git, alternate);
      const options = {
        cwd: f.root,
        env: { ...f.env, OPENCLAW_PR_GIT: alternate },
        encoding: "utf8" as const,
      };
      const task = Promise.resolve().then(() =>
        asynchronous
          ? execPrGhAsync([f.cli], options, "plain")
          : execPrGh([f.cli], options, "plain"),
      );
      await expect(task).rejects.toMatchObject({
        code: "OPENCLAW_PR_GIT_CAPABILITY",
        status: 78,
        message: expect.stringContaining(
          "Make the selected policy executable the actual PATH Git or use WSL.",
        ),
      });
      expect(existsSync(f.receipt)).toBe(false);
    },
  );

  it.each([false, true])(
    "keeps an undefined first-case PATHEXT authoritative before GH admission (async=%s)",
    async (asynchronous) => {
      const f = fixture();
      const backend = join(f.root, "competing-git");
      mkdirSync(backend);
      const exe = join(backend, "git.exe"),
        com = join(backend, "git.com");
      for (const path of [exe, com]) {
        copyFileSync(f.git, path);
      }
      const env = {
        ...f.env,
        Path: backend,
        PATHEXT: undefined,
        PathExt: ".EXE",
        OPENCLAW_PR_GIT: exe,
        GIT_EXEC: exe,
      };
      // Node keeps the first sorted case-insensitive key before omitting
      // undefined values; gh must therefore use its default .COM-first order.
      const options = { cwd: f.root, env, encoding: "utf8" as const };
      const task = Promise.resolve().then(() =>
        asynchronous
          ? execPrGhAsync([f.cli], options, "plain")
          : execPrGh([f.cli], options, "plain"),
      );
      await expect(task).rejects.toMatchObject({ code: "OPENCLAW_PR_GIT_CAPABILITY", status: 78 });
      expect(existsSync(f.receipt)).toBe(false);
      const definedFirst = { ...env, PATHEXT: ".EXE", PathExt: undefined };
      expect(bindGitInvocation(undefined, exe, definedFirst, f.root).executable).toBe(
        realpathSync(exe),
      );
    },
  );

  it("matches gh safeexec PATH/PATHEXT precedence without implicitly searching cwd", () => {
    const f = fixture();
    const backend = join(f.root, "relative;backend");
    mkdirSync(backend);
    const exe = join(backend, "git.exe"),
      com = join(backend, "git.com");
    const cwdGit = join(f.root, "git.exe");
    for (const path of [exe, com, cwdGit]) {
      copyFileSync(f.git, path);
    }
    const admit = (selected: string, overrides: NodeJS.ProcessEnv) =>
      bindGitInvocation(undefined, selected, { ...f.env, ...overrides }, f.root);
    const quotedPath = '"relative;backend"';
    expect(admit(exe, { Path: quotedPath, PATHEXT: "EXE;com" }).executable).toBe(realpathSync(exe));
    expect(admit(com, { Path: quotedPath, PATHEXT: ".COM;.EXE" }).executable).toBe(
      realpathSync(com),
    );
    expect(admit(com, { Path: quotedPath, PATHEXT: undefined }).executable).toBe(realpathSync(com));
    // Native Node passes the lexicographically first case-insensitive env key.
    expect(admit(exe, { PATH: `"${backend}"`, Path: f.root, PATHEXT: ".EXE" }).executable).toBe(
      realpathSync(exe),
    );
    expect(() => admit(cwdGit, { PATH: backend, Path: f.root, PATHEXT: ".EXE" })).toThrow(
      "(not found)",
    );
    expect(() => admit(cwdGit, { Path: quotedPath })).toThrow("does not match Windows PATH Git");
    expect(() => admit(cwdGit, { Path: "" })).toThrow("(not found)");
    expect(() => admit(cwdGit, { Path: `;${quotedPath}` })).toThrow("GitHub CLI searches again");
    expect(() => admit(cwdGit, { Path: "." })).toThrow("GitHub CLI searches again");
  });

  it.each([false, true])(
    "refuses a bare safeexec result before GH can look up another Git (async=%s)",
    async (asynchronous) => {
      const f = fixture();
      const cwdGit = join(f.root, "git.exe");
      copyFileSync(f.git, cwdGit);
      const options = {
        cwd: f.root,
        env: {
          ...f.env,
          Path: `;${dirname(f.git)}`,
          NoDefaultCurrentDirectoryInExePath: "1",
          OPENCLAW_PR_GIT: cwdGit,
          GIT_EXEC: cwdGit,
        },
        encoding: "utf8" as const,
      };
      const task = Promise.resolve().then(() =>
        asynchronous
          ? execPrGhAsync([f.cli], options, "plain")
          : execPrGh([f.cli], options, "plain"),
      );
      await expect(task).rejects.toMatchObject({
        code: "OPENCLAW_PR_GIT_CAPABILITY",
        status: 78,
        message: expect.stringContaining("GitHub CLI searches again"),
      });
      expect(existsSync(f.receipt)).toBe(false);
    },
  );

  it("resolves relative and root-relative child cwd before drive-relative Git lookup", () => {
    const f = fixture();
    // Keep the child cwd on the worker's drive even when TEMP uses another one.
    const root = tempDirs.make("openclaw-pr-relative-git-", process.cwd());
    const work = join(root, "work");
    mkdirSync(work);
    const wanted = join(work, "git.exe");
    const wrong = join(root, "git.exe");
    copyFileSync(f.git, wanted);
    copyFileSync(f.git, wrong);
    const drive = parse(work).root.slice(0, -1);
    const env = { ...f.env, Path: drive, PATHEXT: ".EXE", [`=${drive}`]: root };
    for (const cwd of [relative(process.cwd(), work), work.slice(drive.length)]) {
      expect(bindGitInvocation(undefined, wanted, env, cwd).executable).toBe(realpathSync(wanted));
      expect(() => bindGitInvocation(undefined, wrong, env, cwd)).toThrow(
        "does not match Windows PATH Git",
      );
    }
  });
});
