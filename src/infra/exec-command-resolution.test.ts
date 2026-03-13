import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makePathEnv, makeTempDir } from "./exec-approvals-test-helpers.js";
import {
  evaluateExecAllowlist,
  normalizeSafeBins,
  parseExecArgvToken,
  resolveAllowlistCandidatePath,
  resolveCommandResolution,
  resolveCommandResolutionFromArgv,
} from "./exec-approvals.js";

function buildNestedEnvShellCommand(params: {
  envExecutable: string;
  depth: number;
  payload: string;
}): string[] {
  return [...Array(params.depth).fill(params.envExecutable), "/bin/sh", "-c", params.payload];
}

function analyzeEnvWrapperAllowlist(params: { argv: string[]; envPath: string; cwd: string }) {
  const analysis = {
    ok: true as const,
    segments: [
      {
        argv: params.argv,
        resolution: resolveCommandResolutionFromArgv(
          params.argv,
          params.cwd,
          makePathEnv(params.envPath),
        ),
      },
    ],
  };
  const allowlistEval = evaluateExecAllowlist({
    analysis,
    allowlist: [{ pattern: params.envPath }],
    safeBins: normalizeSafeBins([]),
    cwd: params.cwd,
  });
  return { analysis, allowlistEval };
}

function createPathExecutableFixture(params?: { executable?: string }): {
  exeName: string;
  exePath: string;
  binDir: string;
} {
  const dir = makeTempDir();
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const baseName = params?.executable ?? "rg";
  const exeName = process.platform === "win32" ? `${baseName}.exe` : baseName;
  const exePath = path.join(binDir, exeName);
  fs.writeFileSync(exePath, "");
  fs.chmodSync(exePath, 0o755);
  return { exeName, exePath, binDir };
}

describe("exec-command-resolution", () => {
  it("resolves PATH, relative, and quoted executables", () => {
    const cases = [
      {
        name: "PATH executable",
        setup: () => {
          const fixture = createPathExecutableFixture();
          return {
            command: "rg -n foo",
            cwd: undefined as string | undefined,
            envPath: makePathEnv(fixture.binDir),
            expectedPath: fixture.exePath,
            expectedExecutableName: fixture.exeName,
          };
        },
      },
      {
        name: "relative executable",
        setup: () => {
          const dir = makeTempDir();
          const cwd = path.join(dir, "project");
          const script = path.join(cwd, "scripts", "run.sh");
          fs.mkdirSync(path.dirname(script), { recursive: true });
          fs.writeFileSync(script, "");
          fs.chmodSync(script, 0o755);
          return {
            command: "./scripts/run.sh --flag",
            cwd,
            envPath: undefined as NodeJS.ProcessEnv | undefined,
            expectedPath: script,
            expectedExecutableName: undefined,
          };
        },
      },
      {
        name: "quoted executable",
        setup: () => {
          const dir = makeTempDir();
          const cwd = path.join(dir, "project");
          const script = path.join(cwd, "bin", "tool");
          fs.mkdirSync(path.dirname(script), { recursive: true });
          fs.writeFileSync(script, "");
          fs.chmodSync(script, 0o755);
          return {
            command: '"./bin/tool" --version',
            cwd,
            envPath: undefined as NodeJS.ProcessEnv | undefined,
            expectedPath: script,
            expectedExecutableName: undefined,
          };
        },
      },
    ] as const;

    for (const testCase of cases) {
      const setup = testCase.setup();
      const res = resolveCommandResolution(setup.command, setup.cwd, setup.envPath);
      expect(res?.resolvedPath, testCase.name).toBe(setup.expectedPath);
      if (setup.expectedExecutableName) {
        expect(res?.executableName, testCase.name).toBe(setup.expectedExecutableName);
      }
    }
  });

  it("unwraps transparent env and nice wrappers to the effective executable", () => {
    const fixture = createPathExecutableFixture();

    const envResolution = resolveCommandResolutionFromArgv(
      ["/usr/bin/env", "rg", "-n", "needle"],
      undefined,
      makePathEnv(fixture.binDir),
    );
    expect(envResolution?.resolvedPath).toBe(fixture.exePath);
    expect(envResolution?.executableName).toBe(fixture.exeName);

    const niceResolution = resolveCommandResolutionFromArgv([
      "/usr/bin/nice",
      "bash",
      "-lc",
      "echo hi",
    ]);
    expect(niceResolution?.rawExecutable).toBe("bash");
    expect(niceResolution?.executableName.toLowerCase()).toContain("bash");
  });

  it("blocks semantic env wrappers, env -S, and deep transparent-wrapper chains", () => {
    const blockedEnv = resolveCommandResolutionFromArgv([
      "/usr/bin/env",
      "FOO=bar",
      "rg",
      "-n",
      "needle",
    ]);
    expect(blockedEnv?.policyBlocked).toBe(true);
    expect(blockedEnv?.rawExecutable).toBe("/usr/bin/env");

    if (process.platform === "win32") {
      return;
    }

    const dir = makeTempDir();
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const envPath = path.join(binDir, "env");
    fs.writeFileSync(envPath, "#!/bin/sh\n");
    fs.chmodSync(envPath, 0o755);

    const envS = analyzeEnvWrapperAllowlist({
      argv: [envPath, "-S", 'sh -c "echo pwned"'],
      envPath,
      cwd: dir,
    });
    expect(envS.analysis.segments[0]?.resolution?.policyBlocked).toBe(true);
    expect(envS.allowlistEval.allowlistSatisfied).toBe(false);

    const deep = analyzeEnvWrapperAllowlist({
      argv: buildNestedEnvShellCommand({
        envExecutable: envPath,
        depth: 5,
        payload: "echo pwned",
      }),
      envPath,
      cwd: dir,
    });
    expect(deep.analysis.segments[0]?.resolution?.policyBlocked).toBe(true);
    expect(deep.analysis.segments[0]?.resolution?.blockedWrapper).toBe("env");
    expect(deep.allowlistEval.allowlistSatisfied).toBe(false);
  });

  it("resolves allowlist candidate paths from unresolved raw executables", () => {
    expect(
      resolveAllowlistCandidatePath(
        {
          rawExecutable: "~/bin/tool",
          executableName: "tool",
        },
        "/tmp",
      ),
    ).toContain("/bin/tool");

    expect(
      resolveAllowlistCandidatePath(
        {
          rawExecutable: "./scripts/run.sh",
          executableName: "run.sh",
        },
        "/repo",
      ),
    ).toBe(path.resolve("/repo", "./scripts/run.sh"));

    expect(
      resolveAllowlistCandidatePath(
        {
          rawExecutable: "rg",
          executableName: "rg",
        },
        "/repo",
      ),
    ).toBeUndefined();
  });

  it("normalizes argv tokens for short clusters, long options, and special sentinels", () => {
    expect(parseExecArgvToken("")).toEqual({ kind: "empty", raw: "" });
    expect(parseExecArgvToken("--")).toEqual({ kind: "terminator", raw: "--" });
    expect(parseExecArgvToken("-")).toEqual({ kind: "stdin", raw: "-" });
    expect(parseExecArgvToken("echo")).toEqual({ kind: "positional", raw: "echo" });

    const short = parseExecArgvToken("-oblocked.txt");
    expect(short.kind).toBe("option");
    if (short.kind === "option" && short.style === "short-cluster") {
      expect(short.flags[0]).toBe("-o");
      expect(short.cluster).toBe("oblocked.txt");
    }

    const long = parseExecArgvToken("--output=blocked.txt");
    expect(long.kind).toBe("option");
    if (long.kind === "option" && long.style === "long") {
      expect(long.flag).toBe("--output");
      expect(long.inlineValue).toBe("blocked.txt");
    }
  });
});
