import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makePathEnv, makeTempDir } from "./exec-approvals-test-helpers.js";
import {
  evaluateExecAllowlist,
  resolvePlannedSegmentArgv,
  normalizeSafeBins,
  parseExecArgvToken,
  resolveCommandResolution,
  resolveCommandResolutionFromArgv,
  resolveExecutionTargetCandidatePath,
  resolvePolicyTargetCandidatePath,
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
        raw: params.argv.join(" "),
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
          const scriptName = process.platform === "win32" ? "run.cmd" : "run.sh";
          const script = path.join(cwd, "scripts", scriptName);
          fs.mkdirSync(path.dirname(script), { recursive: true });
          fs.writeFileSync(script, "");
          fs.chmodSync(script, 0o755);
          return {
            command: `./scripts/${scriptName} --flag`,
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
          const scriptName = process.platform === "win32" ? "tool.cmd" : "tool";
          const script = path.join(cwd, "bin", scriptName);
          fs.mkdirSync(path.dirname(script), { recursive: true });
          fs.writeFileSync(script, "");
          fs.chmodSync(script, 0o755);
          return {
            command: `"./bin/${scriptName}" --version`,
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
      expect(res?.execution.resolvedPath, testCase.name).toBe(setup.expectedPath);
      if (setup.expectedExecutableName) {
        expect(res?.execution.executableName, testCase.name).toBe(setup.expectedExecutableName);
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
    expect(envResolution?.execution.resolvedPath).toBe(fixture.exePath);
    expect(envResolution?.execution.executableName).toBe(fixture.exeName);

    const niceResolution = resolveCommandResolutionFromArgv([
      "/usr/bin/nice",
      "bash",
      "-lc",
      "echo hi",
    ]);
    expect(niceResolution?.execution.rawExecutable).toBe("bash");
    expect(niceResolution?.execution.executableName.toLowerCase()).toContain("bash");

    const timeResolution = resolveCommandResolutionFromArgv(
      ["/usr/bin/time", "-p", "rg", "-n", "needle"],
      undefined,
      makePathEnv(fixture.binDir),
    );
    expect(timeResolution?.execution.resolvedPath).toBe(fixture.exePath);
    expect(timeResolution?.execution.executableName).toBe(fixture.exeName);
  });

  it("keeps shell multiplexer wrappers as a separate policy target", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const busybox = path.join(dir, "busybox");
    fs.writeFileSync(busybox, "");
    fs.chmodSync(busybox, 0o755);

    const resolution = resolveCommandResolutionFromArgv([busybox, "sh", "-lc", "echo hi"]);
    expect(resolution?.execution.rawExecutable).toBe("sh");
    expect(resolution?.effectiveArgv).toEqual(["sh", "-lc", "echo hi"]);
    expect(resolution?.wrapperChain).toEqual(["busybox"]);
    expect(resolution?.policy.rawExecutable).toBe(busybox);
    expect(resolution?.policy.resolvedPath).toBe(busybox);
    expect(resolvePolicyTargetCandidatePath(resolution ?? null, dir)).toBe(busybox);
    expect(resolution?.execution.executableName.toLowerCase()).toContain("sh");
  });

  it("does not satisfy inner-shell allowlists when invoked through busybox wrappers", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const busybox = path.join(dir, "busybox");
    fs.writeFileSync(busybox, "");
    fs.chmodSync(busybox, 0o755);

    const shellResolution = resolveCommandResolutionFromArgv(["sh", "-lc", "echo hi"]);
    expect(shellResolution?.execution.resolvedPath).toBeTruthy();

    const wrappedResolution = resolveCommandResolutionFromArgv([busybox, "sh", "-lc", "echo hi"]);
    const evalResult = evaluateExecAllowlist({
      analysis: {
        ok: true,
        segments: [
          {
            raw: `${busybox} sh -lc echo hi`,
            argv: [busybox, "sh", "-lc", "echo hi"],
            resolution: wrappedResolution,
          },
        ],
      },
      allowlist: [{ pattern: shellResolution?.execution.resolvedPath ?? "" }],
      safeBins: normalizeSafeBins([]),
      cwd: dir,
    });

    expect(evalResult.allowlistSatisfied).toBe(false);
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
    expect(blockedEnv?.execution.rawExecutable).toBe("/usr/bin/env");

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
      resolveExecutionTargetCandidatePath(
        {
          rawExecutable: "~/bin/tool",
          executableName: "tool",
        },
        "/tmp",
      ),
    ).toContain("/bin/tool");

    expect(
      resolveExecutionTargetCandidatePath(
        {
          rawExecutable: "./scripts/run.sh",
          executableName: "run.sh",
        },
        "/repo",
      ),
    ).toBe(path.resolve("/repo", "./scripts/run.sh"));

    expect(
      resolveExecutionTargetCandidatePath(
        {
          rawExecutable: "rg",
          executableName: "rg",
        },
        "/repo",
      ),
    ).toBeUndefined();
  });

  it("keeps execution and policy targets coherent across wrapper classes", () => {
    if (process.platform === "win32") {
      return;
    }

    const dir = makeTempDir();
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const envPath = path.join(binDir, "env");
    const rgPath = path.join(binDir, "rg");
    const busybox = path.join(dir, "busybox");
    for (const file of [envPath, rgPath, busybox]) {
      fs.writeFileSync(file, "");
      fs.chmodSync(file, 0o755);
    }

    const cases = [
      {
        name: "transparent env wrapper",
        argv: [envPath, "rg", "-n", "needle"],
        env: makePathEnv(binDir),
        expectedExecutionPath: rgPath,
        expectedPolicyPath: rgPath,
        expectedPlannedArgv: [fs.realpathSync(rgPath), "-n", "needle"],
        allowlistPattern: rgPath,
        allowlistSatisfied: true,
      },
      {
        name: "busybox shell multiplexer",
        argv: [busybox, "sh", "-lc", "echo hi"],
        env: { PATH: `${binDir}${path.delimiter}/bin:/usr/bin` },
        expectedExecutionPath: "/bin/sh",
        expectedPolicyPath: busybox,
        expectedPlannedArgv: ["/bin/sh", "-lc", "echo hi"],
        allowlistPattern: busybox,
        allowlistSatisfied: true,
      },
      {
        name: "semantic env wrapper",
        argv: [envPath, "FOO=bar", "rg", "-n", "needle"],
        env: makePathEnv(binDir),
        expectedExecutionPath: envPath,
        expectedPolicyPath: envPath,
        expectedPlannedArgv: null,
        allowlistPattern: envPath,
        allowlistSatisfied: false,
      },
      {
        name: "wrapper depth overflow",
        argv: buildNestedEnvShellCommand({
          envExecutable: envPath,
          depth: 5,
          payload: "echo hi",
        }),
        env: makePathEnv(binDir),
        expectedExecutionPath: envPath,
        expectedPolicyPath: envPath,
        expectedPlannedArgv: null,
        allowlistPattern: envPath,
        allowlistSatisfied: false,
      },
    ] as const;

    for (const testCase of cases) {
      const argv = [...testCase.argv];
      const resolution = resolveCommandResolutionFromArgv(argv, dir, testCase.env);
      const segment = {
        raw: argv.join(" "),
        argv,
        resolution,
      };
      expect(
        resolveExecutionTargetCandidatePath(resolution ?? null, dir),
        `${testCase.name} execution`,
      ).toBe(testCase.expectedExecutionPath);
      expect(
        resolvePolicyTargetCandidatePath(resolution ?? null, dir),
        `${testCase.name} policy`,
      ).toBe(testCase.expectedPolicyPath);
      expect(resolvePlannedSegmentArgv(segment), `${testCase.name} planned argv`).toEqual(
        testCase.expectedPlannedArgv,
      );
      const evaluation = evaluateExecAllowlist({
        analysis: { ok: true, segments: [segment] },
        allowlist: [{ pattern: testCase.allowlistPattern }],
        safeBins: normalizeSafeBins([]),
        cwd: dir,
        env: testCase.env,
      });
      expect(evaluation.allowlistSatisfied, `${testCase.name} allowlist`).toBe(
        testCase.allowlistSatisfied,
      );
    }
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
