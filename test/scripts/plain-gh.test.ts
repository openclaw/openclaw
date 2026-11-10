import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as gh from "../../scripts/lib/plain-gh.mjs";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const testNodeExecPath = resolveTestNodeExecPath();

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const commandDirs = useAutoCleanupTempDirTracker(afterAll);
const shellHelper = path.resolve("scripts/lib/plain-gh.sh");
const engines = ["shell", "Node"] as const;
let commands: ReturnType<typeof makeCommandFixture>;

beforeAll(() => {
  commands = makeCommandFixture();
});

const versionArgs = ["--version"];
const subprocessOptions = { encoding: "utf8" as const, stdio: "pipe" as const };
const boundedOptions = { timeout: 10_000, killSignal: "SIGKILL" as const };
const refusalOutput = { stdout: "protected refusal\n", stderr: "policy denied\n" };
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

function makeCommandFixture() {
  const root = commandDirs.make("plain-gh-commands-");
  // Extensionless fixture commands use CommonJS.
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}\n');
  const home = path.join(root, "home");
  const protectedBin = path.join(home, "bin");
  const secondBin = path.join(root, "second");
  const toolsBin = path.join(root, "tools");
  for (const dir of [protectedBin, secondBin, toolsBin]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.symlinkSync("/usr/bin/env", path.join(toolsBin, "env"));
  for (const [dir, route] of [
    [protectedBin, "protected"],
    [secondBin, "second"],
  ] as const) {
    const ghBin = path.join(dir, "gh");
    fs.writeFileSync(
      ghBin,
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
  const tokens = Object.fromEntries(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].filter(key => env[key]).map(key => [key, env[key]]));
  const result = JSON.stringify({ route, argv, colors, tokens, override: env.OPENCLAW_GH_BIN ?? null, cwd: process.cwd() });
  const colored = env.NO_COLOR !== "1" || env.FORCE_COLOR !== "0" || env.CLICOLOR !== "0" || env.CLICOLOR_FORCE !== "0" || env.COLORTERM || env.GH_FORCE_TTY;
  process.stdout.write(colored ? "\\x1b[31m" + result + "\\x1b[0m" : result);
}
`,
    );
    fs.chmodSync(ghBin, 0o755);
  }
  return { home, protectedBin, secondBin, toolsBin };
}

function makeFixture() {
  const root = tempDirs.make("plain-gh-");
  // Share executable files only; environments and outputs stay private to each test.
  const { home, protectedBin, secondBin, toolsBin } = commands;
  const calls = path.join(root, "calls.jsonl");
  fs.writeFileSync(calls, "");
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
    ...commands,
    env,
    options: { ...subprocessOptions, env },
    override: path.join(secondBin, "gh"),
    calls: () =>
      fs
        .readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

function runShell(script: string, env: NodeJS.ProcessEnv, args: string[] = [], cwd?: string) {
  return execFileSync("/bin/bash", ["-c", script, "plain-gh", shellHelper, ...args], {
    ...subprocessOptions,
    env,
    cwd,
  });
}

function runGh(engine: (typeof engines)[number], env: NodeJS.ProcessEnv, cwd?: string) {
  const options = { ...subprocessOptions, cwd, env };
  if (engine === "Node") {
    return gh.execPlainGh(["--version"], options);
  }
  return runShell('source "$1"; shift; gh_plain "$@"', env, versionArgs, cwd);
}

describe.each(engines)("%s plain gh execution", (engine) => {
  it("preserves a protected refusal and both output streams without fallback", () => {
    const fixture = makeFixture();
    fixture.env.FAKE_GH_REJECT = "1";
    expect(() => runGh(engine, fixture.env)).toThrow(
      expect.objectContaining({ status: 23, ...refusalOutput }),
    );
    expect(fixture.calls()).toEqual([protectedCall()]);
  });

  it.each(["missing PATH command", "nonexecutable override"])("refuses %s", (failure) => {
    const fixture = makeFixture();
    if (failure === "missing PATH command") {
      fixture.env.PATH = fixture.toolsBin;
    } else {
      fixture.env.OPENCLAW_GH_BIN = path.join(fixture.root, "not-executable");
      fs.writeFileSync(fixture.env.OPENCLAW_GH_BIN, "not executable");
      // Existing ambient credentials isolate executable validation from split-auth probing.
      fixture.env.GH_TOKEN = "fixture-ambient";
    }
    expect(() => runGh(engine, fixture.env)).toThrow();
    expect(fixture.calls()).toEqual([]);
  });

  it("preserves ambient GH_TOKEN without probing in either route", () => {
    const fixture = makeFixture();
    fixture.env.GH_TOKEN = "fixture-ambient";
    for (const explicit of [false, true]) {
      fixture.env.OPENCLAW_GH_BIN = explicit ? fixture.override : undefined;
      const before = { ...fixture.env };
      const result = JSON.parse(runGh(engine, fixture.env));
      expect(result).toMatchObject({
        ...(explicit ? secondCall(fixture.override) : protectedCall()),
        colors: normalizedColors,
      });
      expect(result.tokens).toEqual({ GH_TOKEN: "fixture-ambient" });
      expect(fixture.env).toEqual(before);
    }
    expect(fixture.calls()).toEqual([protectedCall(), secondCall(fixture.override)]);
  });

  it.each([
    { host: undefined, tokenName: "GH_TOKEN" },
    { host: "github.com", tokenName: "GH_TOKEN" },
    { host: "github.example.com", tokenName: "GH_ENTERPRISE_TOKEN" },
  ])("forwards $host credentials only to the child", ({ host, tokenName }) => {
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
    expect(result).toMatchObject({ ...secondCall(fixture.override), colors: normalizedColors });
    expect(result.tokens).toEqual({ [tokenName]: "fixture-token" });
    expect(fixture.calls()).toEqual([
      protectedCall(
        ["auth", "token", ...(host ? ["--hostname", host] : [])],
        engine === "shell" ? "" : null,
      ),
      secondCall(fixture.override),
    ]);
    expect(fixture.env).toEqual(before);
  });
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

  it("resolves an empty PATH entry against the Node child cwd", () => {
    const fixture = makeFixture();
    const cwd = fixture.protectedBin;
    fixture.env.PATH = ["", fixture.secondBin, fixture.toolsBin].join(path.delimiter);
    expect(JSON.parse(runGh("Node", fixture.env, cwd))).toMatchObject({ route: "protected", cwd });
    expect(fixture.calls()).toHaveLength(1);
  });

  it("keeps direct resolver/environment consumers on PATH without an auth probe", () => {
    const fixture = makeFixture();
    const output = execFileSync(gh.resolvePlainGhBin(fixture.env), ["--version"], {
      ...fixture.options,
      env: gh.plainGhAuthenticatedEnv(fixture.env),
    });
    expect(JSON.parse(output).route).toBe("protected");
    expect(fixture.calls()).toEqual([protectedCall()]);
  });

  it("keeps explicit reads override-independent and parses normalized JSON", async () => {
    const fixture = makeFixture();
    fixture.env.OPENCLAW_GH_BIN = "/invalid-explicit-override";
    const options = { encoding: "utf8" as const, env: fixture.env };
    expect(JSON.parse(gh.execGhApiRead("repos/example/repo", options))).toMatchObject(
      protectedCall(["api", "repos/example/repo", "--method", "GET"]),
    );
    expect(gh.execGhJson(versionArgs, options)).toMatchObject(protectedCall());
    const result = JSON.parse(await gh.execGhReadAsync(versionArgs, options));
    expect(result).toMatchObject({ ...protectedCall(), colors: normalizedColors });
    expect(fixture.calls()).toHaveLength(3);
    expect(fixture.env.OPENCLAW_GH_BIN).toBe("/invalid-explicit-override");
  });

  it("preserves asynchronous read refusals and buffer limits without another route", async () => {
    const fixture = makeFixture();
    fixture.env.OPENCLAW_GH_BIN = fixture.override;
    fixture.env.FAKE_GH_REJECT = "1";
    const options = { env: fixture.env, ...boundedOptions };
    await expect(gh.execGhReadAsync(versionArgs, options)).rejects.toMatchObject({
      code: 23,
      ...refusalOutput,
    });
    delete fixture.env.FAKE_GH_REJECT;
    fixture.env.FAKE_GH_BYTES = "4096";
    const limitedRead = gh.execGhReadAsync(versionArgs, { ...options, maxBuffer: 1024 });
    await expect(limitedRead).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    expect(fixture.calls()).toEqual([protectedCall(), protectedCall()]);
  });

  it.each([gh.execPlainGh, gh.execGhRead])(
    "preserves bytes, streams, and limits (%#)",
    (execute) => {
      const fixture = makeFixture();
      // Explicit selection also keeps this payload proof harmless on the pre-fix resolver.
      fixture.env.OPENCLAW_GH_BIN = fixture.override;
      fixture.env.GH_TOKEN = "fixture-ambient";
      fixture.env.FAKE_GH_BYTES = String(2 * 1024 * 1024);
      const options = { ...fixture.options, ...boundedOptions, encoding: null };
      const output = execute(["--version"], options);
      expect(Buffer.isBuffer(output)).toBe(true);
      expect(Buffer.alloc(2 * 1024 * 1024, 0xff).equals(output)).toBe(true);
      expect(() => execute(["--version"], { ...options, maxBuffer: 1024 })).toThrow(
        expect.objectContaining({ code: "ENOBUFS" }),
      );
      const destination = path.join(fixture.root, "artifact.bin");
      const fd = fs.openSync(destination, "w");
      try {
        execute(["--version"], { ...options, stdio: ["ignore", fd, "pipe"] });
      } finally {
        fs.closeSync(fd);
      }
      expect(fs.readFileSync(destination).equals(output)).toBe(true);
    },
  );
});
