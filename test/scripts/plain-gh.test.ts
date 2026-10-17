// Exercise real subprocess boundaries with disposable PATH routes and synthetic credentials.
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  execGhApiRead,
  execGhJson,
  execGhRead,
  execGhReadAsync,
  execPlainGh,
  plainGhAuthenticatedEnv,
  resolvePlainGhBin,
} from "../../scripts/lib/plain-gh.mjs";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const testNodeExecPath = resolveTestNodeExecPath();

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const commandDirs = useAutoCleanupTempDirTracker(afterAll);
const shellHelper = path.resolve("scripts/lib/plain-gh.sh");
const tokenNames = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;
const engines = ["shell", "Node"] as const;
let commands: ReturnType<typeof makeCommandFixture>;

beforeAll(() => {
  commands = makeCommandFixture();
});

const versionArgs = ["--version"];
const protectedCall = (argv = versionArgs, override: string | null = null) => ({
  route: "protected",
  argv,
  override,
});
const secondCall = (override: string) => ({ route: "second", argv: versionArgs, override });
const normalizedColors = {
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  CLICOLOR: "0",
  CLICOLOR_FORCE: "0",
  COLORTERM: null,
  GH_FORCE_TTY: null,
};

function makeCommandFixture(parent?: string) {
  const root = commandDirs.make("plain-gh-commands-", parent);
  // Both extensionless command routes use CommonJS, independent of the temp parent.
  writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}\n');
  const home = path.join(root, "home");
  const protectedBin = path.join(home, "bin");
  const secondBin = path.join(root, "second");
  const toolsBin = path.join(root, "tools");
  for (const dir of [protectedBin, secondBin, toolsBin]) {
    mkdirSync(dir, { recursive: true });
  }
  symlinkSync("/usr/bin/env", path.join(toolsBin, "env"));
  for (const [dir, route] of [
    [protectedBin, "protected"],
    [secondBin, "second"],
  ] as const) {
    const gh = path.join(dir, "gh");
    writeFileSync(
      gh,
      `#!${testNodeExecPath}
const fs = require("node:fs");
const env = process.env;
const argv = process.argv.slice(2);
const route = ${JSON.stringify(route)};
fs.appendFileSync(env.FAKE_GH_CALLS, JSON.stringify({ route, argv, override: env.OPENCLAW_GH_BIN ?? null }) + "\\n");
if (argv[0] === "auth" && argv[1] === "token") {
  process.stdout.write("fixture-token\\n");
} else if (env.FAKE_GH_REJECT && route === "protected") {
  process.stdout.write("protected refusal\\n");
  process.stderr.write("policy denied\\n");
  process.exitCode = 23;
} else if (env.FAKE_GH_BYTES) {
  process.stdout.write(Buffer.alloc(Number(env.FAKE_GH_BYTES), 0xff));
} else {
  const colors = Object.fromEntries(["NO_COLOR", "FORCE_COLOR", "CLICOLOR", "CLICOLOR_FORCE", "COLORTERM", "GH_FORCE_TTY"].map(key => [key, env[key] ?? null]));
  const tokens = Object.fromEntries(${JSON.stringify(tokenNames)}.filter(key => env[key]).map(key => [key, env[key]]));
  const result = JSON.stringify({ route, argv, colors, tokens, override: env.OPENCLAW_GH_BIN ?? null, cwd: process.cwd() });
  const colored = env.NO_COLOR !== "1" || env.FORCE_COLOR !== "0" || env.CLICOLOR !== "0" || env.CLICOLOR_FORCE !== "0" || env.COLORTERM || env.GH_FORCE_TTY;
  process.stdout.write(colored ? "\\x1b[31m" + result + "\\x1b[0m" : result);
}
`,
    );
    chmodSync(gh, 0o755);
  }
  return { home, protectedBin, secondBin, toolsBin };
}

function makeFixture(fixtureCommands = commands) {
  const root = tempDirs.make("plain-gh-");
  // Share executable files only; environments and outputs stay private to each test.
  const { home, protectedBin, secondBin, toolsBin } = fixtureCommands;
  const calls = path.join(root, "calls.jsonl");
  writeFileSync(calls, "");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: [protectedBin, secondBin, toolsBin].join(path.delimiter),
    FAKE_GH_CALLS: calls,
    CLICOLOR: "1",
    CLICOLOR_FORCE: "1",
    COLORTERM: "truecolor",
    FORCE_COLOR: "3",
    GH_FORCE_TTY: "120",
  };
  return {
    root,
    home,
    protectedBin,
    secondBin,
    toolsBin,
    env,
    options: { env, encoding: "utf8" as const, stdio: "pipe" as const },
    override: path.join(secondBin, "gh"),
    calls: () =>
      readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

function runShell(script: string, env: NodeJS.ProcessEnv, args: string[] = [], cwd?: string) {
  return execFileSync("/bin/bash", ["-c", script, "plain-gh", shellHelper, ...args], {
    encoding: "utf8",
    env,
    cwd,
    stdio: "pipe",
  });
}

function runGh(engine: (typeof engines)[number], env: NodeJS.ProcessEnv, cwd?: string) {
  const options = { cwd, encoding: "utf8" as const, env, stdio: "pipe" as const };
  if (engine === "Node") {
    return execPlainGh(["--version"], options);
  }
  return runShell('source "$1"; shift; gh_plain "$@"', env, versionArgs, cwd);
}

describe.each(engines)("%s plain gh execution", (engine) => {
  it.each([false, true])(
    "runs CommonJS command fixtures below an ESM parent with explicit override=%s",
    (explicit) => {
      const parent = commandDirs.make("plain-gh-esm-");
      const parentPackage = path.join(parent, "package.json");
      writeFileSync(parentPackage, '{"type":"module"}\n');
      const fixture = makeFixture(makeCommandFixture(parent));
      fixture.env.OPENCLAW_GH_BIN = explicit ? fixture.override : undefined;
      const before = { ...fixture.env };
      const result = JSON.parse(runGh(engine, fixture.env));
      expect(result).toMatchObject({
        route: explicit ? "second" : "protected",
        argv: ["--version"],
        override: explicit ? fixture.override : null,
        colors: normalizedColors,
      });
      expect(result.tokens).toEqual(explicit ? { GH_TOKEN: "fixture-token" } : {});
      expect(fixture.calls()).toEqual([
        ...(explicit ? [protectedCall(["auth", "token"], engine === "shell" ? "" : null)] : []),
        explicit ? secondCall(fixture.override) : protectedCall(),
      ]);
      expect(fixture.env).toEqual(before);
      expect(JSON.parse(readFileSync(parentPackage, "utf8"))).toEqual({ type: "module" });
    },
  );

  it("preserves a protected refusal and both output streams without fallback", () => {
    const fixture = makeFixture();
    fixture.env.FAKE_GH_REJECT = "1";
    expect(() => runGh(engine, fixture.env)).toThrow(
      expect.objectContaining({
        status: 23,
        stdout: "protected refusal\n",
        stderr: "policy denied\n",
      }),
    );
    expect(fixture.calls()).toEqual([protectedCall()]);
  });

  it.each(["missing PATH command", "nonexecutable override"])(
    "refuses %s without native discovery",
    (failure) => {
      const fixture = makeFixture();
      if (failure === "missing PATH command") {
        fixture.env.PATH = fixture.toolsBin;
      } else {
        fixture.env.OPENCLAW_GH_BIN = path.join(fixture.root, "not-executable");
        writeFileSync(fixture.env.OPENCLAW_GH_BIN, "not executable");
        // Existing ambient credentials isolate executable validation from split-auth probing.
        fixture.env.GH_TOKEN = "fixture-ambient";
      }
      expect(() => runGh(engine, fixture.env)).toThrow();
      expect(fixture.calls()).toEqual([]);
    },
  );

  it.each(["GH_TOKEN"])("preserves ambient %s without probing in either route", (tokenName) => {
    const fixture = makeFixture();
    fixture.env[tokenName] = "fixture-ambient";
    for (const explicit of [false, true]) {
      fixture.env.OPENCLAW_GH_BIN = explicit ? fixture.override : undefined;
      const before = { ...fixture.env };
      const result = JSON.parse(runGh(engine, fixture.env));
      expect(result).toMatchObject({
        route: explicit ? "second" : "protected",
        override: explicit ? fixture.override : null,
      });
      expect(result.tokens).toEqual({ [tokenName]: "fixture-ambient" });
      expect(fixture.env).toEqual(before);
    }
    expect(fixture.calls()).toEqual([protectedCall(), secondCall(fixture.override)]);
  });

  it.each([
    { host: "github.com", tokenName: "GH_TOKEN" },
    { host: "github.example.com", tokenName: "GH_ENTERPRISE_TOKEN" },
  ])(
    "forwards explicit override credentials for host $host only to the child",
    ({ host, tokenName }) => {
      const fixture = makeFixture();
      Object.assign(fixture.env, { GH_HOST: host, OPENCLAW_GH_BIN: fixture.override });
      const before = { ...fixture.env };
      const output =
        engine === "Node"
          ? execFileSync(
              testNodeExecPath,
              [
                "--input-type=module",
                "-e",
                `import { execPlainGh } from ${JSON.stringify(path.resolve("scripts/lib/plain-gh.mjs"))};
const before = JSON.stringify(process.env);
process.stdout.write(execPlainGh(["--version"], { encoding: "utf8" }));
if (JSON.stringify(process.env) !== before) throw new Error("parent environment changed");`,
              ],
              fixture.options,
            )
          : runShell(
              'source "$1"; gh_plain --version && test -z "${GH_TOKEN-}${GH_ENTERPRISE_TOKEN-}"',
              fixture.env,
            );
      const result = JSON.parse(output);
      expect(result).toMatchObject({
        route: "second",
        override: fixture.override,
      });
      expect(result.tokens).toEqual({ [tokenName]: "fixture-token" });
      expect(fixture.calls()).toEqual([
        protectedCall(["auth", "token", "--hostname", host], engine === "shell" ? "" : null),
        secondCall(fixture.override),
      ]);
      expect(fixture.env).toEqual(before);
    },
  );
});

describe("plain gh subprocess contracts", () => {
  it("ignores a shell function shadowing the external PATH executable", () => {
    const fixture = makeFixture();
    const output = runShell(
      'source "$1"; gh() { echo function-shadow >&2; return 71; }; resolved=$(resolve_plain_gh_bin); "$resolved" --version',
      fixture.env,
    );
    expect(output).toContain('"route":"protected"');
    expect(fixture.calls()).toHaveLength(1);
  });

  it.each([""])("uses the Node child cwd for relative PATH entry %j", (entry) => {
    const fixture = makeFixture();
    const cwd = entry ? fixture.home : fixture.protectedBin;
    fixture.env.PATH = [entry, fixture.secondBin, fixture.toolsBin].join(path.delimiter);
    expect(JSON.parse(runGh("Node", fixture.env, cwd))).toMatchObject({ route: "protected", cwd });
    expect(fixture.calls()).toHaveLength(1);
  });

  it("keeps direct resolver/environment consumers on PATH without an auth probe", () => {
    const fixture = makeFixture();
    const output = execFileSync(resolvePlainGhBin(fixture.env), ["--version"], {
      ...fixture.options,
      env: plainGhAuthenticatedEnv(fixture.env),
    });
    expect(JSON.parse(output).route).toBe("protected");
    expect(fixture.calls()).toEqual([protectedCall()]);
  });

  it("keeps explicit reads override-independent and parses normalized JSON", async () => {
    const fixture = makeFixture();
    fixture.env.OPENCLAW_GH_BIN = "/invalid-explicit-override";
    const options = { encoding: "utf8" as const, env: fixture.env };
    expect(JSON.parse(execGhApiRead("repos/example/repo", options))).toMatchObject({
      route: "protected",
      argv: ["api", "repos/example/repo", "--method", "GET"],
      override: null,
    });
    expect(execGhJson(["--version"], options)).toMatchObject({
      route: "protected",
      override: null,
    });
    expect(JSON.parse(await execGhReadAsync(["--version"], options))).toMatchObject({
      route: "protected",
      override: null,
      colors: { NO_COLOR: "1", FORCE_COLOR: "0", CLICOLOR: "0", CLICOLOR_FORCE: "0" },
    });
    expect(fixture.calls()).toHaveLength(3);
    expect(fixture.env.OPENCLAW_GH_BIN).toBe("/invalid-explicit-override");
  });

  it("preserves asynchronous read refusals and buffer limits without another route", async () => {
    const fixture = makeFixture();
    fixture.env.OPENCLAW_GH_BIN = fixture.override;
    fixture.env.FAKE_GH_REJECT = "1";
    const options = { env: fixture.env, timeout: 10_000, killSignal: "SIGKILL" as const };
    await expect(execGhReadAsync(["--version"], options)).rejects.toMatchObject({
      code: 23,
      stderr: "policy denied\n",
      stdout: "protected refusal\n",
    });
    delete fixture.env.FAKE_GH_REJECT;
    fixture.env.FAKE_GH_BYTES = "4096";
    await expect(
      execGhReadAsync(["--version"], { ...options, maxBuffer: 1024 }),
    ).rejects.toMatchObject({
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    });
    expect(fixture.calls()).toEqual([protectedCall(), protectedCall()]);
  });

  it.each([execPlainGh, execGhRead])(
    "preserves binary output, streaming, and caller buffer limits (%#)",
    (execute) => {
      const fixture = makeFixture();
      // Explicit selection also keeps this payload proof harmless on the pre-fix resolver.
      fixture.env.OPENCLAW_GH_BIN = fixture.override;
      fixture.env.GH_TOKEN = "fixture-ambient";
      fixture.env.FAKE_GH_BYTES = String(2 * 1024 * 1024);
      const options = {
        env: fixture.env,
        stdio: "pipe" as const,
        timeout: 10_000,
        killSignal: "SIGKILL" as const,
      };
      const output = execute(["--version"], options);
      expect(Buffer.isBuffer(output)).toBe(true);
      expect(Buffer.alloc(2 * 1024 * 1024, 0xff).equals(output)).toBe(true);
      expect(() => execute(["--version"], { ...options, maxBuffer: 1024 })).toThrow(
        expect.objectContaining({ code: "ENOBUFS" }),
      );
      const destination = path.join(fixture.root, "artifact.bin");
      const fd = openSync(destination, "w");
      try {
        execute(["--version"], { ...options, stdio: ["ignore", fd, "pipe"] });
      } finally {
        closeSync(fd);
      }
      expect(readFileSync(destination).equals(output)).toBe(true);
    },
  );

  it("preserves bounded read options and invocation errors", () => {
    const options = {
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 60_000,
    } satisfies ExecFileSyncOptions;
    const execFileSyncImpl = vi.fn(() => '{"ok":true}');
    expect(execGhJson(["api", "repos/example/repo"], options, { execFileSyncImpl })).toEqual({
      ok: true,
    });
    expect(execFileSyncImpl).toHaveBeenCalledExactlyOnceWith(
      "gh",
      ["api", "repos/example/repo"],
      expect.objectContaining({ ...options, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }),
    );
    const failure = new Error("gh read failed");
    expect(() =>
      execGhRead(
        ["--version"],
        {},
        {
          execFileSyncImpl: () => {
            throw failure;
          },
        },
      ),
    ).toThrow(failure);
  });
});
