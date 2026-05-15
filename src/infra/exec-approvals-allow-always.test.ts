import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectPolicyInlineEval } from "./command-analysis/policy.js";
import {
  countAllowAlwaysApprovedSegments,
  resolveAllowAlwaysPatternEntries,
  resolveAllowAlwaysPatternEntriesFromPlanAsync,
} from "./exec-approvals-allowlist.js";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
  makePathEnv,
  makeTempDir,
} from "./exec-approvals-test-helpers.js";
import {
  analyzeArgvCommand,
  evaluateExecAllowlist,
  evaluateShellAllowlist,
  requiresExecApproval,
  resolveAllowAlwaysPatterns,
  resolveSafeBins,
} from "./exec-approvals.js";
import { matchAllowlist } from "./exec-command-resolution.js";
import { buildTrustedSafeBinDirs } from "./exec-safe-bin-trust.js";

describe("resolveAllowAlwaysPatterns", () => {
  function makeExecutable(dir: string, name: string): string {
    const fileName = process.platform === "win32" ? `${name}.exe` : name;
    const exe = path.join(dir, fileName);
    fs.writeFileSync(exe, "");
    fs.chmodSync(exe, 0o755);
    return exe;
  }

  async function resolvePersistedPatterns(params: {
    command: string;
    dir: string;
    env: Record<string, string | undefined>;
    safeBins: ReturnType<typeof resolveSafeBins>;
    strictInlineEval?: boolean;
  }) {
    const analysis = await evaluateShellAllowlist({
      command: params.command,
      allowlist: [],
      safeBins: params.safeBins,
      cwd: params.dir,
      env: params.env,
      platform: process.platform,
    });
    return {
      analysis,
      persisted: (analysis.authorizationPlan
        ? await resolveAllowAlwaysPatternEntriesFromPlanAsync({
            plan: analysis.authorizationPlan,
            approvedSegments: analysis.segments,
            approvedSegmentCount: countAllowAlwaysApprovedSegments({
              plan: analysis.authorizationPlan,
              segmentSatisfiedBy: analysis.segmentSatisfiedBy,
            }),
            cwd: params.dir,
            env: params.env,
            platform: process.platform,
            strictInlineEval: params.strictInlineEval,
          })
        : resolveAllowAlwaysPatternEntries({
            segments: analysis.segments,
            cwd: params.dir,
            env: params.env,
            platform: process.platform,
            strictInlineEval: params.strictInlineEval,
          })
      ).map((pattern) => pattern.pattern),
    };
  }

  async function expectAllowAlwaysBypassBlocked(params: {
    dir: string;
    firstCommand: string;
    secondCommand: string;
    env: Record<string, string | undefined>;
    persistedPattern: string;
  }) {
    const safeBins = resolveSafeBins(undefined);
    const { persisted } = await resolvePersistedPatterns({
      command: params.firstCommand,
      dir: params.dir,
      env: params.env,
      safeBins,
    });
    expect(persisted).toEqual([params.persistedPattern]);

    const second = await evaluateShellAllowlist({
      command: params.secondCommand,
      allowlist: [{ pattern: params.persistedPattern }],
      safeBins,
      cwd: params.dir,
      env: params.env,
      platform: process.platform,
    });
    expect(second.allowlistSatisfied).toBe(false);
    expect(
      requiresExecApproval({
        ask: "on-miss",
        security: "allowlist",
        analysisOk: second.analysisOk,
        allowlistSatisfied: second.allowlistSatisfied,
      }),
    ).toBe(true);
  }

  function createShellScriptFixture() {
    const dir = makeTempDir();
    const scriptsDir = path.join(dir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    const script = path.join(scriptsDir, "save_crystal.sh");
    fs.writeFileSync(script, "echo ok\n");
    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
    const safeBins = resolveSafeBins(undefined);
    return { dir, scriptsDir, script, env, safeBins };
  }

  async function expectPersistedShellScriptMatch(params: {
    command: string;
    script: string;
    dir: string;
    env: Record<string, string | undefined>;
    safeBins: ReturnType<typeof resolveSafeBins>;
  }) {
    const { persisted } = await resolvePersistedPatterns({
      command: params.command,
      dir: params.dir,
      env: params.env,
      safeBins: params.safeBins,
    });
    expect(persisted).toEqual([params.script]);

    const second = await evaluateShellAllowlist({
      command: params.command,
      allowlist: [{ pattern: params.script }],
      safeBins: params.safeBins,
      cwd: params.dir,
      env: params.env,
      platform: process.platform,
    });
    expect(second.allowlistSatisfied).toBe(true);
  }

  async function expectShellScriptFallbackRejected(command: string) {
    const { dir, scriptsDir, script, env, safeBins } = createShellScriptFixture();
    const rcFile = path.join(scriptsDir, "evilrc");
    fs.writeFileSync(rcFile, "echo blocked\n");

    const { persisted } = await resolvePersistedPatterns({
      command,
      dir,
      env,
      safeBins,
    });
    expect(persisted).toStrictEqual([]);

    const second = await evaluateShellAllowlist({
      command,
      allowlist: [{ pattern: script }],
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(second.allowlistSatisfied).toBe(false);
  }

  async function expectPositionalArgvCarrierResult(params: {
    command: string;
    expectPersisted: boolean;
  }) {
    const dir = makeTempDir();
    const touch = makeExecutable(dir, "touch");
    const touchRealPath = fs.realpathSync(touch);
    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
    const safeBins = resolveSafeBins(undefined);
    const marker = path.join(dir, "marker");
    const command = params.command.replaceAll("{marker}", marker);

    const { persisted } = await resolvePersistedPatterns({
      command,
      dir,
      env,
      safeBins,
    });
    if (params.expectPersisted) {
      expect(persisted).toEqual([touchRealPath]);
    } else {
      expect(persisted).toStrictEqual([]);
    }

    const second = await evaluateShellAllowlist({
      command,
      allowlist: [{ pattern: touchRealPath }],
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(second.allowlistSatisfied).toBe(params.expectPersisted);
  }

  it("returns direct executable paths for non-shell segments", async () => {
    const exe = path.join("/tmp", "openclaw-tool");
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: exe,
          argv: [exe],
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: exe,
              resolvedPath: exe,
              executableName: "openclaw-tool",
            }),
          }),
        },
      ],
    });
    expect(patterns).toEqual([exe]);
  });

  it("does not persist interpreter-like executables for allow-always", async () => {
    const awk = path.join("/tmp", "awk");
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: `${awk} '{print $1}' data.csv`,
          argv: [awk, "{print $1}", "data.csv"],
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: awk,
              resolvedPath: awk,
              executableName: "awk",
            }),
          }),
        },
      ],
    });
    expect(patterns).toStrictEqual([]);
  });

  it("persists benign awk interpreters when strict inline-eval is enabled", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const awk = makeExecutable(dir, "awk");
    const env = makePathEnv(dir);
    const safeBins = resolveSafeBins(undefined);

    const { persisted } = await resolvePersistedPatterns({
      command: "awk -F, -f script.awk data.csv",
      dir,
      env,
      safeBins,
      strictInlineEval: true,
    });
    expect(persisted).toEqual([awk]);

    const second = await evaluateShellAllowlist({
      command: "awk -F, -f script.awk data.csv",
      allowlist: persisted.map((pattern) => ({ pattern })),
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(second.allowlistSatisfied).toBe(true);
  });

  it("keeps Windows strict inline-eval interpreter approvals argv-bound", async () => {
    const awk = "C:\\temp\\awk.exe";
    const resolution = makeMockCommandResolution({
      execution: makeMockExecutableResolution({
        rawExecutable: awk,
        resolvedPath: awk,
        executableName: "awk",
      }),
    });
    const entries = resolveAllowAlwaysPatternEntries({
      segments: [
        {
          raw: `${awk} -F , -f script.awk data.csv`,
          argv: [awk, "-F", ",", "-f", "script.awk", "data.csv"],
          resolution,
        },
      ],
      platform: "win32",
      strictInlineEval: true,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.pattern).toBe(awk);
    expect(typeof entries[0]?.argPattern).toBe("string");
    const matched = matchAllowlist(
      entries,
      resolution.execution ?? null,
      [awk, "-F", ",", "-f", "script.awk", "data.csv"],
      "win32",
    );
    expect(matched?.pattern).toBe(awk);
    expect(typeof matched?.argPattern).toBe("string");
    expect(
      matchAllowlist(
        entries,
        resolution.execution ?? null,
        [awk, "-f", "other.awk", "secrets.csv"],
        "win32",
      ),
    ).toBeNull();
  });

  it.each([
    {
      name: "empty PowerShell file argument",
      argvPrefix: [],
      fileFlag: "-File",
      scriptArgs: [""],
      expectedArgPattern: "^\x00$",
    },
    {
      name: "PowerShell file alias argument",
      argvPrefix: [],
      fileFlag: "-fi",
      scriptArgs: ["arg"],
      expectedArgPattern: "^arg\x00$",
    },
    {
      name: "empty PowerShell file argument after dispatch unwrap",
      argvPrefix: ["env"],
      fileFlag: "/file",
      scriptArgs: [""],
      expectedArgPattern: "^\x00$",
    },
  ])(
    "persists allow-always patterns for $name",
    ({ argvPrefix, fileFlag, scriptArgs, expectedArgPattern }) => {
      const dir = makeTempDir();
      makeExecutable(dir, "env");
      makeExecutable(dir, "pwsh");
      const scriptPath = path.join(dir, "script.ps1");
      fs.writeFileSync(scriptPath, "");
      fs.chmodSync(scriptPath, 0o755);
      try {
        const env = makePathEnv(dir);
        const analysis = analyzeArgvCommand({
          argv: [...argvPrefix, "pwsh", fileFlag, scriptPath, ...scriptArgs],
          cwd: dir,
          env,
        });
        expect(analysis.ok).toBe(true);

        const entries = resolveAllowAlwaysPatternEntries({
          segments: analysis.segments,
          cwd: dir,
          env,
          platform: "win32",
        });
        expect(entries).toEqual([{ pattern: scriptPath, argPattern: expectedArgPattern }]);

        const result = evaluateExecAllowlist({
          analysis,
          allowlist: entries,
          safeBins: new Set(),
          cwd: dir,
          env,
          platform: "win32",
        });
        expect(result.allowlistSatisfied).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(["-fi", "/file"])(
    "persists planner allow-always patterns for POSIX PowerShell %s aliases",
    async (fileFlag) => {
      if (process.platform === "win32") {
        return;
      }
      const dir = makeTempDir();
      makeExecutable(dir, "pwsh");
      const scriptPath = path.join(dir, "script.ps1");
      fs.writeFileSync(scriptPath, "");
      fs.chmodSync(scriptPath, 0o755);
      try {
        const env = makePathEnv(dir);
        const { persisted } = await resolvePersistedPatterns({
          command: `pwsh ${fileFlag} ./script.ps1 arg`,
          dir,
          env,
          safeBins: resolveSafeBins(undefined),
        });

        expect(persisted).toEqual([scriptPath]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("keeps inline awk programs out of allow-always persistence in strict inline-eval mode", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    makeExecutable(dir, "awk");
    const env = makePathEnv(dir);
    const safeBins = resolveSafeBins(undefined);

    const { persisted } = await resolvePersistedPatterns({
      command: `awk 'BEGIN{system("id > ${path.join(dir, "marker")}")}'`,
      dir,
      env,
      safeBins,
      strictInlineEval: true,
    });
    expect(persisted).toStrictEqual([]);
  });

  it("does not satisfy allowlist for prompt-only inline eval units", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const python = makeExecutable(dir, "python");
    const env = makePathEnv(dir);
    const safeBins = resolveSafeBins(undefined);

    const result = await evaluateShellAllowlist({
      command: "python -c 'print(1)'",
      allowlist: [{ pattern: python }],
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });

    expect(result.analysisOk).toBe(true);
    expect(result.authorizationPlan?.kind).toBe("prompt-only");
    expect(result.allowlistSatisfied).toBe(false);
    expect(
      requiresExecApproval({
        ask: "on-miss",
        security: "allowlist",
        analysisOk: result.analysisOk,
        allowlistSatisfied: result.allowlistSatisfied,
      }),
    ).toBe(true);
  });

  it("keeps later inline-eval units visible after an earlier allowlist miss", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    makeExecutable(dir, "echo");
    makeExecutable(dir, "python");
    const env = makePathEnv(dir);
    const safeBins = new Set<string>();

    const result = await evaluateShellAllowlist({
      command: "echo ok; python -c 'print(1)'",
      allowlist: [],
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });

    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segments.map((segment) => segment.argv)).toEqual([
      ["echo", "ok"],
      ["python", "-c", "print(1)"],
    ]);
    expect(detectPolicyInlineEval(result.segments)?.normalizedExecutable).toBe("python");
  });

  it("does not satisfy allowlist or persist allow-always for shell state builtins", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const tool = makeExecutable(dir, "tool");
    const bash = makeExecutable(dir, "bash");
    const envPath = makeExecutable(dir, "env");
    const ls = makeExecutable(dir, "ls");
    const env = makePathEnv(dir);
    const safeBins = resolveSafeBins(undefined);

    for (const command of [
      "BASH_ENV=/tmp/payload bash -c 'echo ok'",
      "env BASH_ENV=/tmp/payload bash -c 'echo ok'",
      "cd /tmp; ./tool",
      "export BASH_ENV=/tmp/payload; bash -c 'echo ok'",
      "unset PATH; ls",
      "set -a; SECRET=value; ./tool",
      "hash -p /tmp/evil ls; ls",
      "trap 'id > /tmp/pwned' EXIT; echo ok",
    ]) {
      const { analysis, persisted } = await resolvePersistedPatterns({
        command,
        dir,
        env,
        safeBins,
      });
      expect(analysis.analysisOk).toBe(false);
      expect(persisted).toStrictEqual([]);

      const result = await evaluateShellAllowlist({
        command,
        allowlist: [{ pattern: tool }, { pattern: bash }, { pattern: envPath }, { pattern: ls }],
        safeBins,
        cwd: dir,
        env,
        platform: process.platform,
      });
      expect(result.allowlistSatisfied).toBe(false);
    }
  });

  it("does not authorize semantic shell wrappers from inner payload allowlist entries", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    makeExecutable(dir, "sh");
    const falsePath = makeExecutable(dir, "false");
    const rmPath = makeExecutable(dir, "rm");
    try {
      const env = makePathEnv(dir);
      const result = await evaluateShellAllowlist({
        command: "sh -e -c 'false; rm marker'",
        allowlist: [{ pattern: falsePath }, { pattern: rmPath }],
        safeBins: resolveSafeBins(undefined),
        cwd: dir,
        env,
        platform: process.platform,
      });

      const { persisted } = await resolvePersistedPatterns({
        command: "sh -e -c 'false; rm marker'",
        dir,
        env,
        safeBins: resolveSafeBins(undefined),
      });
      expect(persisted).toStrictEqual([]);

      const payloadOnly = await evaluateShellAllowlist({
        command: "false; rm marker",
        allowlist: [{ pattern: falsePath }, { pattern: rmPath }],
        safeBins: resolveSafeBins(undefined),
        cwd: dir,
        env,
        platform: process.platform,
      });
      expect(payloadOnly.allowlistSatisfied).toBe(true);

      expect(result.analysisOk).toBe(true);
      const plan = result.authorizationPlan;
      expect(plan?.kind).toBe("analyzable");
      if (!plan || plan.kind !== "analyzable") {
        throw new Error(`expected analyzable plan, got ${plan?.kind ?? "missing"}`);
      }
      expect(plan.units).toEqual([
        expect.objectContaining({
          argv: ["sh", "-e", "-c", "false; rm marker"],
          relationship: "simple",
        }),
      ]);
      expect(result.allowlistSatisfied).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unwraps shell wrappers and persists the inner executable instead", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const whoami = makeExecutable(dir, "whoami");
    const { persisted: patterns } = await resolvePersistedPatterns({
      command: "/bin/zsh -c 'whoami'",
      dir,
      env: makePathEnv(dir),
      safeBins: resolveSafeBins(undefined),
    });
    expect(patterns).toEqual([whoami]);
    expect(patterns).not.toContain("/bin/zsh");
  });

  it.each(["sh -c './tool'", "sh -c 'true; ./tool'", "sh -c 'env ./tool'"])(
    "does not persist relative shell-wrapper payload paths: %s",
    async (command) => {
      if (process.platform === "win32") {
        return;
      }
      const dir = makeTempDir();
      makeExecutable(dir, "true");
      makeExecutable(dir, "tool");
      const { persisted } = await resolvePersistedPatterns({
        command,
        dir,
        env: makePathEnv(dir),
        safeBins: resolveSafeBins(undefined),
      });

      expect(persisted).toStrictEqual([]);
    },
  );

  it("does not persist wrapper payloads when outer arguments are evaluated", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    makeExecutable(dir, "echo");
    makeExecutable(dir, "id");
    const { persisted: patterns } = await resolvePersistedPatterns({
      command: "sh -c 'echo safe' $(id)",
      dir,
      env: makePathEnv(dir),
      safeBins: resolveSafeBins(undefined),
    });
    expect(patterns).toStrictEqual([]);
  });

  it("persists the first missed inner binary from shell chains", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const whoami = makeExecutable(dir, "whoami");
    makeExecutable(dir, "ls");
    const { persisted: patterns } = await resolvePersistedPatterns({
      command: "/bin/zsh -c 'whoami && ls && whoami'",
      dir,
      env: makePathEnv(dir),
      safeBins: resolveSafeBins(undefined),
    });
    expect(patterns).toEqual([whoami]);
  });

  it("persists shell script paths for wrapper invocations without inline commands", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { dir, scriptsDir, script, env, safeBins } = createShellScriptFixture();
    await expectPersistedShellScriptMatch({
      command: "bash scripts/save_crystal.sh",
      script,
      dir,
      env,
      safeBins,
    });

    const other = path.join(scriptsDir, "other.sh");
    fs.writeFileSync(other, "echo other\n");
    const third = await evaluateShellAllowlist({
      command: "bash scripts/other.sh",
      allowlist: [{ pattern: script }],
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(third.allowlistSatisfied).toBe(false);
  });

  it("matches persisted shell script paths through dispatch wrappers", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { dir, script, env, safeBins } = createShellScriptFixture();
    await expectPersistedShellScriptMatch({
      command: "/usr/bin/nice bash scripts/save_crystal.sh",
      script,
      dir,
      env,
      safeBins,
    });
  });

  it("rejects shell rc and init-file options as persisted or allowlisted script paths", async () => {
    if (process.platform === "win32") {
      return;
    }
    for (const command of [
      "bash --rcfile scripts/evilrc scripts/save_crystal.sh",
      "bash --init-file scripts/evilrc scripts/save_crystal.sh",
      "bash --startup-file scripts/evilrc scripts/save_crystal.sh",
    ]) {
      await expectShellScriptFallbackRejected(command);
    }
  });

  it("rejects shell rc and init-file equals options as persisted or allowlisted script paths", async () => {
    if (process.platform === "win32") {
      return;
    }
    for (const command of [
      "bash --rcfile=scripts/evilrc scripts/save_crystal.sh",
      "bash --init-file=scripts/evilrc scripts/save_crystal.sh",
      "bash --startup-file=scripts/evilrc scripts/save_crystal.sh",
    ]) {
      await expectShellScriptFallbackRejected(command);
    }
  });

  it("rejects startup shell inline payloads for allow-always and inline-chain allowlist fallback", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const tool = makeExecutable(dir, "openclaw-ok");
    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
    const safeBins = resolveSafeBins(undefined);

    for (const command of [
      `bash --login -c "openclaw-ok && openclaw-ok"`,
      `bash -i -c "openclaw-ok && openclaw-ok"`,
      `bash -lc "openclaw-ok && openclaw-ok"`,
      `bash --login -c '$0 "$1"' ${tool} marker`,
      `bash -i -c '$0 "$1"' ${tool} marker`,
      `bash -lc '$0 "$1"' ${tool} marker`,
    ]) {
      const { persisted } = await resolvePersistedPatterns({
        command,
        dir,
        env,
        safeBins,
      });
      expect(persisted).toStrictEqual([]);

      const second = await evaluateShellAllowlist({
        command,
        allowlist: [{ pattern: tool }],
        safeBins,
        cwd: dir,
        env,
        platform: process.platform,
      });
      expect(second.allowlistSatisfied).toBe(false);
    }
  });

  it("persists shell-wrapper positional argv carrier executables", async () => {
    if (process.platform === "win32") {
      return;
    }
    await expectPositionalArgvCarrierResult({
      command: `sh -c '$0 "$1"' touch {marker}`,
      expectPersisted: true,
    });
  });

  it("persists positional argv carrier symlinks as canonical executable paths", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const target = makeExecutable(dir, "target-touch");
    const targetRealPath = fs.realpathSync(target);
    const link = path.join(binDir, "touch");
    fs.symlinkSync(target, link);
    const env = { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
    const safeBins = resolveSafeBins(undefined);
    const marker = path.join(dir, "marker");
    const command = `sh -c '$0 "$1"' touch ${marker}`;

    const { persisted } = await resolvePersistedPatterns({
      command,
      dir,
      env,
      safeBins,
    });
    expect(persisted).toEqual([targetRealPath]);

    const second = await evaluateShellAllowlist({
      command,
      allowlist: [{ pattern: targetRealPath }],
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(second.allowlistSatisfied).toBe(true);
    expect(second.segmentPinnedArgvTokens[0]?.replacement).toBe(targetRealPath);
  });

  it("persists exec positional argv carrier executables", async () => {
    if (process.platform === "win32") {
      return;
    }
    await expectPositionalArgvCarrierResult({
      command: `sh -c 'exec -- "$0" "$1"' touch {marker}`,
      expectPersisted: true,
    });
  });

  it("rejects positional argv carriers when $0 is single-quoted", async () => {
    if (process.platform === "win32") {
      return;
    }
    await expectPositionalArgvCarrierResult({
      command: `sh -c "'$0' "$1"" touch {marker}`,
      expectPersisted: false,
    });
  });

  it("rejects positional argv carriers when exec is separated from $0 by a newline", async () => {
    if (process.platform === "win32") {
      return;
    }
    await expectPositionalArgvCarrierResult({
      command: `sh -c "exec
$0 \\"$1\\"" touch {marker}`,
      expectPersisted: false,
    });
  });

  it("rejects positional argv carriers when inline command contains extra shell operations", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const touch = makeExecutable(dir, "touch");
    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
    const safeBins = resolveSafeBins(undefined);
    const marker = path.join(dir, "marker");

    const { persisted } = await resolvePersistedPatterns({
      command: `sh -c 'echo blocked; $0 "$1"' touch ${marker}`,
      dir,
      env,
      safeBins,
    });
    expect(persisted).not.toContain(touch);

    const second = await evaluateShellAllowlist({
      command: `sh -c 'echo blocked; $0 "$1"' touch ${marker}`,
      allowlist: [{ pattern: touch }],
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(second.allowlistSatisfied).toBe(false);
  });

  it("does not treat inline shell commands as persisted script paths", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { dir, script, env } = createShellScriptFixture();
    await expectAllowAlwaysBypassBlocked({
      dir,
      firstCommand: "bash scripts/save_crystal.sh",
      secondCommand: "bash -c 'scripts/save_crystal.sh'",
      env,
      persistedPattern: script,
    });
  });

  it("does not treat stdin shell mode as a persisted script path", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { dir, script, env } = createShellScriptFixture();
    await expectAllowAlwaysBypassBlocked({
      dir,
      firstCommand: "bash scripts/save_crystal.sh",
      secondCommand: "bash -s scripts/save_crystal.sh",
      env,
      persistedPattern: script,
    });
  });

  it("does not persist broad shell binaries when no inner command can be derived", async () => {
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: "/bin/zsh -s",
          argv: ["/bin/zsh", "-s"],
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: "/bin/zsh",
              resolvedPath: "/bin/zsh",
              executableName: "zsh",
            }),
          }),
        },
      ],
      platform: process.platform,
    });
    expect(patterns).toStrictEqual([]);
  });

  it("detects shell wrappers even when unresolved executableName is a full path", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const whoami = makeExecutable(dir, "whoami");
    const { persisted: patterns } = await resolvePersistedPatterns({
      command: "/usr/local/bin/zsh -c whoami",
      dir,
      env: makePathEnv(dir),
      safeBins: resolveSafeBins(undefined),
    });
    expect(patterns).toEqual([whoami]);
  });

  it("unwraps known dispatch wrappers before shell wrappers", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const whoami = makeExecutable(dir, "whoami");
    const { persisted: patterns } = await resolvePersistedPatterns({
      command: "/usr/bin/nice /bin/zsh -c whoami",
      dir,
      env: makePathEnv(dir),
      safeBins: resolveSafeBins(undefined),
    });
    expect(patterns).toEqual([whoami]);
    expect(patterns).not.toContain("/usr/bin/nice");

    const second = await evaluateShellAllowlist({
      command: "/usr/bin/nice /bin/zsh -c whoami",
      allowlist: [{ pattern: whoami }],
      safeBins: resolveSafeBins(undefined),
      cwd: dir,
      env: makePathEnv(dir),
      platform: process.platform,
    });
    expect(second.allowlistSatisfied).toBe(true);
  });

  it("does not persist semantic dispatch-wrapper payloads as allow-always executables", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    makeExecutable(dir, "sleep");
    const { persisted } = await resolvePersistedPatterns({
      command: "/bin/zsh -c 'timeout 1 sleep 100'",
      dir,
      env: makePathEnv(dir),
      safeBins: resolveSafeBins(undefined),
    });

    expect(persisted).toStrictEqual([]);
  });

  it("unwraps time wrappers and persists the inner executable instead", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const whoami = makeExecutable(dir, "whoami");
    const { persisted: patterns } = await resolvePersistedPatterns({
      command: "/usr/bin/time -p /bin/zsh -c whoami",
      dir,
      env: makePathEnv(dir),
      safeBins: resolveSafeBins(undefined),
    });
    expect(patterns).toEqual([whoami]);
    expect(patterns).not.toContain("/usr/bin/time");
  });

  it("unwraps busybox/toybox shell applets and persists inner executables", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const busybox = makeExecutable(dir, "busybox");
    makeExecutable(dir, "toybox");
    const whoami = makeExecutable(dir, "whoami");
    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
    const { persisted: patterns } = await resolvePersistedPatterns({
      command: `${busybox} sh -c whoami`,
      dir,
      env,
      safeBins: resolveSafeBins(undefined),
    });
    expect(patterns).toEqual([whoami]);
    expect(patterns).not.toContain(busybox);
  });

  it("fails closed for unsupported busybox/toybox applets", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const busybox = makeExecutable(dir, "busybox");
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: `${busybox} sed -n 1p`,
          argv: [busybox, "sed", "-n", "1p"],
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: busybox,
              resolvedPath: busybox,
              executableName: "busybox",
            }),
          }),
        },
      ],
      cwd: dir,
      env: makePathEnv(dir),
      platform: process.platform,
    });
    expect(patterns).toStrictEqual([]);
  });

  it("fails closed for unresolved dispatch wrappers", async () => {
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: "sudo /bin/zsh -lc whoami",
          argv: ["sudo", "/bin/zsh", "-lc", "whoami"],
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: "sudo",
              resolvedPath: "/usr/bin/sudo",
              executableName: "sudo",
            }),
          }),
        },
      ],
      platform: process.platform,
    });
    expect(patterns).toStrictEqual([]);
  });

  it("prevents allow-always bypass for busybox shell applets", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const busybox = makeExecutable(dir, "busybox");
    const echo = makeExecutable(dir, "echo");
    makeExecutable(dir, "id");
    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
    await expectAllowAlwaysBypassBlocked({
      dir,
      firstCommand: `${busybox} sh -c 'echo warmup-ok'`,
      secondCommand: `${busybox} sh -c 'id > marker'`,
      env,
      persistedPattern: echo,
    });
  });

  it("prevents allow-always bypass for caffeinate wrapper chains", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const echo = makeExecutable(dir, "echo");
    makeExecutable(dir, "id");
    const env = makePathEnv(dir);
    await expectAllowAlwaysBypassBlocked({
      dir,
      firstCommand: "/usr/bin/caffeinate -d -w 42 /bin/zsh -c 'echo warmup-ok'",
      secondCommand: "/usr/bin/caffeinate -d -w 42 /bin/zsh -c 'id > marker'",
      env,
      persistedPattern: echo,
    });
  });

  it("prevents allow-always bypass for dispatch-wrapper + shell-wrapper chains", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const echo = makeExecutable(dir, "echo");
    makeExecutable(dir, "id");
    const env = makePathEnv(dir);
    await expectAllowAlwaysBypassBlocked({
      dir,
      firstCommand: "/usr/bin/nice /bin/zsh -c 'echo warmup-ok'",
      secondCommand: "/usr/bin/nice /bin/zsh -c 'id > marker'",
      env,
      persistedPattern: echo,
    });
  });

  it("prevents allow-always bypass for sandbox-exec wrapper chains", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const echo = makeExecutable(dir, "echo");
    makeExecutable(dir, "id");
    const env = makePathEnv(dir);
    await expectAllowAlwaysBypassBlocked({
      dir,
      firstCommand:
        "/usr/bin/sandbox-exec -p '(deny default) (allow process*)' /bin/zsh -c 'echo warmup-ok'",
      secondCommand: "/usr/bin/sandbox-exec -p '(allow default)' /bin/zsh -c 'id > marker'",
      env,
      persistedPattern: echo,
    });
  });

  it("prevents allow-always bypass for time wrapper chains", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const echo = makeExecutable(dir, "echo");
    makeExecutable(dir, "id");
    const env = makePathEnv(dir);
    await expectAllowAlwaysBypassBlocked({
      dir,
      firstCommand: "/usr/bin/time -p /bin/zsh -c 'echo warmup-ok'",
      secondCommand: "/usr/bin/time -p /bin/zsh -c 'id > marker'",
      env,
      persistedPattern: echo,
    });
  });

  it("prevents allow-always bypass for macOS dispatch-wrapper chains", async () => {
    if (process.platform !== "darwin") {
      return;
    }
    const dir = makeTempDir();
    const echo = makeExecutable(dir, "echo");
    makeExecutable(dir, "id");
    const env = makePathEnv(dir);
    await expectAllowAlwaysBypassBlocked({
      dir,
      firstCommand: "/usr/bin/arch -arm64 /bin/zsh -c 'echo warmup-ok'",
      secondCommand: "/usr/bin/arch -arm64 /bin/zsh -c 'id > marker-arch'",
      env,
      persistedPattern: echo,
    });
    await expectAllowAlwaysBypassBlocked({
      dir,
      firstCommand: "/usr/bin/xcrun /bin/zsh -c 'echo warmup-ok'",
      secondCommand: "/usr/bin/xcrun /bin/zsh -c 'id > marker-xcrun'",
      env,
      persistedPattern: echo,
    });
  });

  it("prevents allow-always bypass for awk interpreters", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    makeExecutable(dir, "awk");
    const env = makePathEnv(dir);
    const safeBins = resolveSafeBins(undefined);

    const { persisted } = await resolvePersistedPatterns({
      command: "awk '{print $1}' data.csv",
      dir,
      env,
      safeBins,
    });
    expect(persisted).toStrictEqual([]);

    const second = await evaluateShellAllowlist({
      command: `awk 'BEGIN{system("id > ${path.join(dir, "marker")}")}'`,
      allowlist: persisted.map((pattern) => ({ pattern })),
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(second.allowlistSatisfied).toBe(false);
    expect(
      requiresExecApproval({
        ask: "on-miss",
        security: "allowlist",
        analysisOk: second.analysisOk,
        allowlistSatisfied: second.allowlistSatisfied,
      }),
    ).toBe(true);
  });

  it("prevents allow-always bypass for shell-carried awk interpreters", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    makeExecutable(dir, "awk");
    const env = makePathEnv(dir);
    const safeBins = resolveSafeBins(undefined);

    const { persisted } = await resolvePersistedPatterns({
      command: `sh -c '$0 "$@"' awk '{print $1}' data.csv`,
      dir,
      env,
      safeBins,
    });
    expect(persisted).toStrictEqual([]);

    const second = await evaluateShellAllowlist({
      command: `sh -c '$0 "$@"' awk 'BEGIN{system("id > /tmp/pwned")}'`,
      allowlist: persisted.map((pattern) => ({ pattern })),
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(second.allowlistSatisfied).toBe(false);
  });

  it("prevents allow-always bypass for script wrapper chains", async () => {
    if (process.platform !== "darwin" && process.platform !== "freebsd") {
      return;
    }
    const dir = makeTempDir();
    const echo = makeExecutable(dir, "echo");
    makeExecutable(dir, "id");
    const env = makePathEnv(dir);
    await expectAllowAlwaysBypassBlocked({
      dir,
      firstCommand: "/usr/bin/script -q /dev/null /bin/sh -c 'echo warmup-ok'",
      secondCommand: "/usr/bin/script -q /dev/null /bin/sh -c 'id > marker'",
      env,
      persistedPattern: echo,
    });
  });

  it("does not persist comment-tailed payload paths that never execute", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const benign = makeExecutable(dir, "benign");
    makeExecutable(dir, "payload");
    const env = makePathEnv(dir);
    await expectAllowAlwaysBypassBlocked({
      dir,
      firstCommand: `${benign} warmup # && payload`,
      secondCommand: "payload",
      env,
      persistedPattern: benign,
    });
  });

  it("rejects positional carrier when carried executable is a dispatch wrapper", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const envPath = makeExecutable(dir, "env");
    const env = makePathEnv(dir);
    const safeBins = resolveSafeBins(undefined);

    const { persisted } = await resolvePersistedPatterns({
      command: `sh -c '$0 "$@"' env echo SAFE`,
      dir,
      env,
      safeBins,
    });
    expect(persisted).toStrictEqual([]);

    const second = await evaluateShellAllowlist({
      command: `sh -c '$0 "$@"' env BASH_ENV=/tmp/payload.sh bash -c 'id > /tmp/pwned'`,
      allowlist: [{ pattern: envPath }],
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(second.allowlistSatisfied).toBe(false);
  });

  it("rejects positional carrier when carried executable is a shell wrapper", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const bashPath = makeExecutable(dir, "bash");
    const env = makePathEnv(dir);
    const safeBins = resolveSafeBins(undefined);

    const { persisted } = await resolvePersistedPatterns({
      command: `sh -c '$0 "$@"' bash -c 'echo safe'`,
      dir,
      env,
      safeBins,
    });
    expect(persisted).toStrictEqual([]);

    const second = await evaluateShellAllowlist({
      command: `sh -c '$0 "$@"' bash -c 'id > /tmp/pwned'`,
      allowlist: [{ pattern: bashPath }],
      safeBins,
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(second.allowlistSatisfied).toBe(false);
  });

  it("does not persist shell builtin carriers as allow-always executables", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    makeExecutable(dir, "command");
    makeExecutable(dir, "builtin");
    makeExecutable(dir, "exec");
    makeExecutable(dir, "tool");
    const env = makePathEnv(dir);
    const safeBins = resolveSafeBins(undefined);

    for (const command of ["command ./tool", "builtin ./tool", "exec ./tool"]) {
      const { persisted } = await resolvePersistedPatterns({
        command,
        dir,
        env,
        safeBins,
      });
      expect(persisted).toStrictEqual([]);
    }
  });

  it("allows positional carriers for unknown carried executables when explicitly allowlisted", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    makeExecutable(dir, "sh");
    const xargsPath = makeExecutable(dir, "xargs");
    const env = makePathEnv(dir);
    const safeBins = resolveSafeBins(undefined);

    const { persisted } = await resolvePersistedPatterns({
      command: `sh -c '$0 "$@"' xargs echo SAFE`,
      dir,
      env,
      safeBins,
    });
    expect(persisted).toStrictEqual([]);

    const second = await evaluateShellAllowlist({
      command: `sh -c '$0 "$@"' xargs sh -c 'id > /tmp/pwned'`,
      allowlist: [{ pattern: xargsPath }],
      safeBins,
      trustedSafeBinDirs: buildTrustedSafeBinDirs({ extraDirs: [dir] }),
      cwd: dir,
      env,
      platform: process.platform,
    });
    expect(second.allowlistSatisfied).toBe(true);
  });
});
