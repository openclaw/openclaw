/** Tests system.run approval plans, cwd snapshots, and mutable script operand binding. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveMutableFileOperandSnapshotSync } from "../infra/system-run-approval-binding.js";
import { formatExecCommand } from "../infra/system-run-command.js";
import { revalidateApprovedMutableFileOperand } from "../infra/system-run-file-snapshot.js";
import { withEnv } from "../test-utils/env.js";
import {
  buildSystemRunApprovalPlan,
  hardenApprovedExecutionPaths,
} from "./invoke-system-run-plan.js";
import {
  canMutateNativeBinaryFixturePath,
  resolveNativeBinaryFixturePath,
} from "./system-run-native-binary.test-helpers.js";

type HardeningCase = {
  name: string;
  mode: "build-plan" | "harden";
  argv: string[];
  withPathToken?: boolean;
  expectedArgv?: (pathToken: string | null) => string[];
  expectedCmdText?: string;
  checkRawCommandMatchesArgv?: boolean;
  expectedCommandPreview?: string | null;
};

type ScriptOperandFixture = {
  command: string[];
  scriptPath: string;
  initialBody: string;
  expectedArgvIndex: number;
};

type RuntimeFixture = {
  name: string;
  argv: string[];
  scriptName: string;
  initialBody: string;
  expectedArgvIndex: number;
  binName?: string;
  binNames?: string[];
  skipOnWin32?: boolean;
};

type UnsafeRuntimeInvocationCase = {
  name: string;
  binName: string;
  command: string[];
  files: [string, string][];
};

const shellFixture: RuntimeFixture = {
  name: "shell script",
  argv: ["/bin/sh", "./run.sh"],
  scriptName: "run.sh",
  initialBody: "#!/bin/sh\necho SAFE\n",
  expectedArgvIndex: 1,
};

function requirePathToken(pathToken: string | null): string {
  if (!pathToken) {
    throw new Error("Expected PATH token fixture");
  }
  return pathToken;
}

function shellPlan(command: string, cwd: string) {
  return buildSystemRunApprovalPlan({
    command: ["/bin/sh", "-lc", command],
    rawCommand: command,
    cwd,
  });
}

function requireSuccess<T extends { ok: boolean }>(result: T): asserts result is T & { ok: true } {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("unreachable");
  }
}

function sha256FileSync(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function createScriptOperandFixture(tmp: string, fixture?: RuntimeFixture): ScriptOperandFixture {
  const windows = process.platform === "win32";
  const scriptName = fixture?.scriptName ?? (windows ? "run.js" : "run.sh");
  return {
    command: fixture?.argv ?? (windows ? [process.execPath, "./run.js"] : ["/bin/sh", "./run.sh"]),
    scriptPath: path.join(tmp, scriptName),
    initialBody:
      fixture?.initialBody ?? (windows ? 'console.log("SAFE");\n' : "#!/bin/sh\necho SAFE\n"),
    expectedArgvIndex: fixture?.expectedArgvIndex ?? 1,
  };
}

let sharedFixtureRoot = "";
let sharedRuntimeBinDir = "";
let sharedFixtureId = 0;
const sharedRuntimeBins = new Set<string>();

beforeAll(() => {
  sharedFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-run-plan-fixtures-"));
  sharedRuntimeBinDir = path.join(sharedFixtureRoot, "bin");
  fs.mkdirSync(sharedRuntimeBinDir, { recursive: true });
});

afterAll(() => {
  if (sharedFixtureRoot) {
    fs.rmSync(sharedFixtureRoot, { recursive: true, force: true });
  }
});

function createFixtureDir(prefix: string): string {
  const dir = path.join(sharedFixtureRoot, `${prefix}${sharedFixtureId++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFiles(tmp: string, files: [string, string][]) {
  for (const [name, body] of files) {
    const file = path.join(tmp, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
}

function copyNativeBinary(tmp: string, mode = 0o755) {
  const binary = path.join(tmp, "tool");
  fs.copyFileSync(resolveNativeBinaryFixturePath(), binary);
  fs.chmodSync(binary, mode);
  return binary;
}

function expectSnapshotRejectsRewrite(
  argv: string[],
  cwd: string,
  script: string,
  argvIndex: number,
) {
  const result = resolveMutableFileOperandSnapshotSync({ argv, cwd, shellCommand: null });
  expect(result).toEqual({
    ok: true,
    snapshot: { argvIndex, path: fs.realpathSync(script), sha256: sha256FileSync(script) },
  });
  if (!result.ok || result.snapshot === null) {
    throw new Error("expected mutable file operand snapshot");
  }
  fs.writeFileSync(script, "echo CHANGED\n");
  expect(revalidateApprovedMutableFileOperand({ snapshot: result.snapshot, argv, cwd })).toBe(
    false,
  );
}

function writeFakeRuntimeBin(binDir: string, binName: string) {
  const runtimePath =
    process.platform === "win32" ? path.join(binDir, `${binName}.cmd`) : path.join(binDir, binName);
  const runtimeBody =
    process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n";
  fs.writeFileSync(runtimePath, runtimeBody, { mode: 0o755 });
  if (process.platform !== "win32") {
    fs.chmodSync(runtimePath, 0o755);
  }
}

function withFakeRuntimeBins<T>(binNames: string[], run: () => T): T {
  for (const binName of binNames) {
    if (sharedRuntimeBins.has(binName)) {
      continue;
    }
    writeFakeRuntimeBin(sharedRuntimeBinDir, binName);
    sharedRuntimeBins.add(binName);
  }
  return withEnv({ PATH: `${sharedRuntimeBinDir}${path.delimiter}${process.env.PATH ?? ""}` }, run);
}

function uniqueRuntimeBinNames(
  cases: ReadonlyArray<Pick<RuntimeFixture, "binName" | "binNames">>,
): string[] {
  return [
    ...new Set(
      cases.flatMap(
        (runtimeCase) =>
          runtimeCase.binNames ??
          (runtimeCase.binName ? [runtimeCase.binName] : ["bunx", "pnpm", "npm", "npx", "tsx"]),
      ),
    ),
  ];
}

function expectShellPayloadApprovalDenied(fileName: string, body: string) {
  if (process.platform === "win32") {
    return;
  }
  const tmp = createFixtureDir("openclaw-shell-payload-");
  const scriptPath = path.join(tmp, fileName);
  fs.writeFileSync(scriptPath, body);
  fs.chmodSync(scriptPath, 0o755);
  expect(shellPlan(scriptPath, tmp)).toEqual(DENIED_RUNTIME_APPROVAL);
}

function expectMutableFileOperandApprovalPlan(fixture: ScriptOperandFixture, cwd: string) {
  const prepared = buildSystemRunApprovalPlan({ command: fixture.command, cwd });
  requireSuccess(prepared);
  expect(prepared.plan.mutableFileOperand).toEqual({
    argvIndex: fixture.expectedArgvIndex,
    path: fs.realpathSync(fixture.scriptPath),
    sha256: sha256FileSync(fixture.scriptPath),
  });
}

function writeScriptOperandFixture(fixture: ScriptOperandFixture) {
  fs.writeFileSync(fixture.scriptPath, fixture.initialBody);
  if (process.platform !== "win32") {
    fs.chmodSync(fixture.scriptPath, 0o755);
  }
}

function makeScriptFixture(prefix: string, runtime?: RuntimeFixture) {
  const tmp = createFixtureDir(prefix);
  const fixture = createScriptOperandFixture(tmp, runtime);
  writeScriptOperandFixture(fixture);
  return { fixture, tmp };
}

const DENIED_RUNTIME_APPROVAL = expect.objectContaining({
  ok: false,
  reason: "unsupported-command-shape",
});

function runNamedCase(name: string, run: () => void) {
  try {
    run();
  } catch (error) {
    throw new Error(`case failed: ${name}`, { cause: error });
  }
}

function expectRuntimeApprovalDenied(command: string[], cwd: string) {
  const prepared = buildSystemRunApprovalPlan({ command, cwd });
  expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
}

function expectApprovalPlanWithoutMutableOperand(command: string[], cwd: string) {
  const prepared = buildSystemRunApprovalPlan({ command, cwd });
  requireSuccess(prepared);
  expect(prepared.plan.mutableFileOperand).toBeUndefined();
}

function unsafeRuntime(
  name: string,
  command: [string, ...string[]],
  files: string[] = [],
  binName = command[0],
): UnsafeRuntimeInvocationCase {
  return {
    name,
    binName,
    command,
    files: files.map((file) => [file, "SAFE\n"]),
  };
}

function runtimeFixture(
  name: string,
  argv: string[],
  expectedArgvIndex: number,
  options: Pick<RuntimeFixture, "binName" | "binNames" | "skipOnWin32"> = {},
): RuntimeFixture {
  const operand = argv[expectedArgvIndex];
  if (operand === undefined) {
    throw new Error(`missing script operand for ${name}`);
  }
  const scriptName = path.basename(operand);
  return {
    name,
    argv,
    expectedArgvIndex,
    scriptName,
    initialBody: /\.(py|lua)$/.test(scriptName) ? 'print("SAFE")\n' : 'console.log("SAFE");\n',
    ...options,
  };
}

const unsafeRuntimeInvocationCases = [
  unsafeRuntime("bun package script", ["bun", "run", "dev"]),
  unsafeRuntime("deno eval", ["deno", "eval", "console.log('SAFE')"]),
  unsafeRuntime("tsx eval", ["tsx", "--eval", "console.log('SAFE')"]),
  unsafeRuntime("busybox applet", ["busybox", "awk", 'BEGIN{system("id")}']),
  unsafeRuntime("busybox applet file bait", ["busybox", "awk", 'BEGIN{system("id")}'], ["awk"]),
  unsafeRuntime("toybox applet", ["toybox", "awk", 'BEGIN{system("id")}']),
  unsafeRuntime(
    "node inline import",
    ["node", "--import=./preload.mjs", "./main.mjs"],
    ["main.mjs", "preload.mjs"],
  ),
  unsafeRuntime(
    "node import containing equals",
    ["node", "--import=./pre=load.mjs", "./main.mjs"],
    ["main.mjs", "pre=load.mjs"],
  ),
  unsafeRuntime("ruby require preload", ["ruby", "-r", "attacker", "./safe.rb"], ["safe.rb"]),
  unsafeRuntime("perl module preload", ["perl", "-MPreload", "./safe.pl"], ["safe.pl"]),
  unsafeRuntime("perl load path", ["perl", "-Ilib", "./safe.pl"], ["safe.pl"]),
  unsafeRuntime("shell-hidden interpreter", ["sh", "-lc", "node ./run.js"], ["run.js"], "node"),
  unsafeRuntime(
    "pnpm dlx unknown flag",
    ["pnpm", "dlx", "--future-flag", "tsx", "./run.ts"],
    ["run.ts"],
  ),
  unsafeRuntime(
    "pnpm unknown global flag",
    ["pnpm", "--future-flag", "value", "dlx", "tsx", "./run.ts"],
    ["run.ts"],
  ),
];

describe("hardenApprovedExecutionPaths", () => {
  const cases: HardeningCase[] = [
    {
      name: "preserves shell-wrapper argv during approval hardening",
      mode: "build-plan",
      argv: ["env", "sh", "-c", "echo SAFE"],
      expectedCmdText: 'env sh -c "echo SAFE"',
      expectedCommandPreview: "echo SAFE",
    },
    {
      name: "preserves dispatch-wrapper argv during approval hardening",
      mode: "harden",
      argv: ["env", "tr", "a", "b"],
    },
    {
      name: "pins direct PATH-token executable during approval hardening",
      mode: "harden",
      argv: ["poccmd", "SAFE"],
      withPathToken: true,
      expectedArgv: (pathToken) => [requirePathToken(pathToken), "SAFE"],
    },
    {
      name: "preserves env-wrapper PATH-token argv during approval hardening",
      mode: "harden",
      argv: ["env", "poccmd", "SAFE"],
      withPathToken: true,
    },
    {
      name: "rawCommand matches hardened argv after executable path pinning",
      mode: "build-plan",
      argv: ["poccmd", "hello"],
      withPathToken: true,
      expectedArgv: (pathToken) => [requirePathToken(pathToken), "hello"],
      checkRawCommandMatchesArgv: true,
      expectedCommandPreview: null,
    },
    {
      name: "stores full approval text and preview for path-qualified env wrappers",
      mode: "build-plan",
      argv: ["./env", "sh", "-c", "echo SAFE"],
      expectedCmdText: './env sh -c "echo SAFE"',
      checkRawCommandMatchesArgv: true,
      expectedCommandPreview: "echo SAFE",
    },
  ];

  it.runIf(process.platform !== "win32")("handles approval hardening cases", () => {
    for (const testCase of cases) {
      runNamedCase(testCase.name, () => {
        const tmp = createFixtureDir("openclaw-approval-hardening-");
        let pathToken: string | null = null;

        const checkCase = () => {
          const expectedArgv = testCase.expectedArgv?.(pathToken) ?? [...testCase.argv];
          if (testCase.mode === "build-plan") {
            const prepared = buildSystemRunApprovalPlan({ command: testCase.argv, cwd: tmp });
            requireSuccess(prepared);
            expect(prepared.plan.argv).toEqual(expectedArgv);
            if (testCase.expectedCmdText) {
              expect(prepared.plan.commandText).toBe(testCase.expectedCmdText);
            }
            if (testCase.checkRawCommandMatchesArgv) {
              expect(prepared.plan.commandText).toBe(formatExecCommand(prepared.plan.argv));
            }
            if ("expectedCommandPreview" in testCase) {
              expect(prepared.plan.commandPreview ?? null).toBe(testCase.expectedCommandPreview);
            }
            return;
          }

          const hardened = hardenApprovedExecutionPaths({
            approvedByAsk: true,
            argv: testCase.argv,
            shellCommand: null,
            cwd: tmp,
          });
          requireSuccess(hardened);
          expect(hardened.argv).toEqual(expectedArgv);
        };

        if (testCase.withPathToken) {
          const binDir = path.join(tmp, "bin");
          fs.mkdirSync(binDir, { recursive: true });
          const link = path.join(binDir, "poccmd");
          fs.symlinkSync("/bin/echo", link);
          pathToken = fs.realpathSync(link);
          return withEnv(
            { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
            checkCase,
          );
        }

        return checkCase();
      });
    }
  });

  const mutableOperandCases = [
    runtimeFixture("python flagged file", ["python3", "-B", "./run.py"], 2, { binName: "python3" }),
    runtimeFixture("lua direct file", ["lua", "./run.lua"], 1, { binName: "lua" }),
    runtimeFixture("versioned node alias file", ["node20", "./run.js"], 1, { binName: "node20" }),
    runtimeFixture("tsx direct file", ["tsx", "./run.ts"], 1, { binName: "tsx" }),
    runtimeFixture("bun run file", ["bun", "run", "./run.ts"], 2, { binName: "bun" }),
    runtimeFixture(
      "deno run file with flags",
      ["deno", "run", "-A", "--allow-read", "--", "./run.ts"],
      5,
      { binName: "deno" },
    ),
    runtimeFixture("pnpm exec tsx file", ["pnpm", "exec", "tsx", "./run.ts"], 3),
    runtimeFixture("pnpm dlx tsx file", ["pnpm", "dlx", "tsx", "./run.ts"], 3),
    runtimeFixture(
      "pnpm reporter dlx package tsx file",
      ["pnpm", "--reporter", "silent", "dlx", "--package", "tsx", "tsx", "./run.ts"],
      7,
    ),
    runtimeFixture(
      "pnpm reporter exec tsx file",
      ["pnpm", "--reporter", "silent", "exec", "tsx", "./run.ts"],
      5,
    ),
    runtimeFixture(
      "pnpm cwd exec tsx file",
      ["pnpm", "-C", "./package", "exec", "tsx", "./run.ts"],
      5,
    ),
    runtimeFixture("pnpm js shim exec tsx file", ["./pnpm.js", "exec", "tsx", "./run.ts"], 3, {
      skipOnWin32: true,
    }),
    runtimeFixture("pnpm exec double-dash tsx file", ["pnpm", "exec", "--", "tsx", "./run.ts"], 4),
    runtimeFixture("pnpm node file", ["pnpm", "node", "./run.js"], 2, {
      binNames: ["pnpm", "node"],
    }),
    runtimeFixture("bunx tsx file", ["bunx", "tsx", "./run.ts"], 2),
    runtimeFixture("npm exec tsx file", ["npm", "exec", "--", "tsx", "./run.ts"], 4),
    runtimeFixture("npm x tsx file", ["npm", "x", "--", "tsx", "./run.ts"], 4),
    runtimeFixture(
      "npm loglevel exec tsx file",
      ["npm", "--loglevel=silent", "exec", "--", "tsx", "./run.ts"],
      5,
    ),
    runtimeFixture(
      "npm cwd exec tsx file",
      ["npm", "-C", "./package", "exec", "--", "tsx", "./run.ts"],
      6,
    ),
  ];
  it("captures mutable runtime operands in approval plans", () => {
    const tmp = createFixtureDir("openclaw-approval-script-plan-");
    withFakeRuntimeBins(uniqueRuntimeBinNames(mutableOperandCases), () => {
      for (const runtimeCase of mutableOperandCases) {
        runNamedCase(runtimeCase.name, () => {
          if (runtimeCase.skipOnWin32 && process.platform === "win32") {
            return;
          }
          const fixture = createScriptOperandFixture(tmp, runtimeCase);
          writeScriptOperandFixture(fixture);
          const executablePath = fixture.command[0];
          if (executablePath?.endsWith("pnpm.js")) {
            const shimPath = path.join(tmp, "pnpm.js");
            fs.writeFileSync(shimPath, "#!/usr/bin/env node\nconsole.log('shim')\n");
            fs.chmodSync(shimPath, 0o755);
          }
          expectMutableFileOperandApprovalPlan(fixture, tmp);
        });
      }
    });
  });

  it("captures mutable shell script operands in approval plans", () => {
    const { fixture, tmp } = makeScriptFixture("openclaw-approval-script-plan-");
    expectMutableFileOperandApprovalPlan(fixture, tmp);
  });

  it("captures the execution host cwd when an approval request omits cwd", () => {
    const hardened = hardenApprovedExecutionPaths({
      approvedByAsk: true,
      argv: [],
      cwd: undefined,
      shellCommand: null,
    });
    requireSuccess(hardened);
    expect(hardened.cwd).toBe(fs.realpathSync(process.cwd()));
  });

  it("handles shell payloads that invoke absolute-path native binaries", () => {
    if (process.platform === "win32") {
      return;
    }
    const binaryPath = resolveNativeBinaryFixturePath();
    const prepared = shellPlan(binaryPath, process.cwd());
    if (canMutateNativeBinaryFixturePath(binaryPath)) {
      expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
      return;
    }
    requireSuccess(prepared);
    expect(prepared.plan.mutableFileOperand).toBeUndefined();
  });

  it("recognizes native binary headers across short positional reads", () => {
    if (process.platform === "win32") {
      return;
    }
    const binaryPath = resolveNativeBinaryFixturePath();
    if (canMutateNativeBinaryFixturePath(binaryPath)) {
      return;
    }
    const realReadSync = fs.readSync.bind(fs);
    let shortReadCalls = 0;
    const readSpy = vi.spyOn(fs, "readSync").mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: fs.ReadPosition | null,
    ) => {
      const cappedLength = typeof position === "number" ? Math.min(length, 1) : length;
      if (cappedLength < length) {
        shortReadCalls += 1;
      }
      return realReadSync(fd, buffer, offset, cappedLength, position);
    }) as typeof fs.readSync);
    try {
      const prepared = shellPlan(binaryPath, process.cwd());

      expect(shortReadCalls).toBeGreaterThan(1);
      requireSuccess(prepared);
      expect(prepared.plan.mutableFileOperand).toBeUndefined();
    } finally {
      readSpy.mockRestore();
    }
  });

  it.each(["relative", "absolute"])(
    "keeps fail-closed behavior for writable %s native-binary shell payloads",
    (kind) => {
      if (process.platform === "win32") {
        return;
      }
      const tmp = createFixtureDir("openclaw-shell-binary-binding-");
      const binary = copyNativeBinary(tmp);
      expect(shellPlan(kind === "relative" ? "./tool" : binary, tmp)).toEqual(
        DENIED_RUNTIME_APPROVAL,
      );
    },
  );

  it("keeps fail-closed behavior for owner-controlled read-only absolute binaries", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmp = createFixtureDir("openclaw-shell-owned-readonly-binding-");
    try {
      const binaryPath = copyNativeBinary(tmp, 0o555);
      fs.chmodSync(tmp, 0o555);
      const prepared = shellPlan(binaryPath, tmp);
      expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
    } finally {
      fs.chmodSync(tmp, 0o755);
    }
  });

  it("keeps fail-closed behavior for symlinked binaries with writable targets", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmp = createFixtureDir("openclaw-shell-symlink-binary-binding-");
    const stableDir = path.join(tmp, "stable");
    const mutableDir = path.join(tmp, "mutable");
    try {
      fs.mkdirSync(stableDir);
      fs.mkdirSync(mutableDir);
      const targetBinaryPath = copyNativeBinary(mutableDir);
      const symlinkPath = path.join(stableDir, "tool");
      fs.symlinkSync(targetBinaryPath, symlinkPath);
      fs.chmodSync(stableDir, 0o555);
      const prepared = shellPlan(symlinkPath, tmp);
      expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
    } finally {
      fs.chmodSync(stableDir, 0o755);
    }
  });

  it("keeps fail-closed behavior for mutable or ambiguous shell payload files", () => {
    for (const [fileName, body] of [
      ["run.sh", "#!/bin/sh\necho SAFE\n"],
      ["empty", ""],
      ["mz-script", "MZ not really a PE file\n"],
      ["nul-script", "SAFE\u0000maybe-binary\n"],
    ] as const) {
      expectShellPayloadApprovalDenied(fileName, body);
    }
  });

  it("keeps fail-closed behavior when the shell payload probe stops seeing a file", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmp = createFixtureDir("openclaw-shell-race-binding-");
    const scriptPath = path.join(tmp, "run.sh");
    fs.writeFileSync(scriptPath, "#!/bin/sh\necho SAFE\n");
    fs.chmodSync(scriptPath, 0o755);
    const realStatSync = fs.statSync;
    let targetStatCalls = 0;
    const statSyncSpy = vi.spyOn(fs, "statSync").mockImplementation((pathLike, options) => {
      const targetPath = typeof pathLike === "string" ? pathLike : pathLike.toString();
      if (targetPath === scriptPath) {
        targetStatCalls += 1;
        if (targetStatCalls === 2) {
          return realStatSync(tmp, options);
        }
      }
      return realStatSync(pathLike, options);
    });
    try {
      const prepared = shellPlan(scriptPath, tmp);
      expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
    } finally {
      statSyncSpy.mockRestore();
    }
  });

  it("rejects unsafe runtime invocation forms", () => {
    withFakeRuntimeBins(
      [...new Set(unsafeRuntimeInvocationCases.map((testCase) => testCase.binName))],
      () => {
        for (const testCase of unsafeRuntimeInvocationCases) {
          runNamedCase(testCase.name, () => {
            const tmp = createFixtureDir("openclaw-unsafe-runtime-");
            writeFiles(tmp, testCase.files);
            expectRuntimeApprovalDenied(testCase.command, tmp);
          });
        }
      },
    );
  });

  it("detects rewritten script operands for pnpm dlx approval plans", () => {
    withFakeRuntimeBins(["pnpm", "tsx"], () => {
      const { fixture, tmp } = makeScriptFixture(
        "openclaw-pnpm-dlx-approval-",
        runtimeFixture("pnpm dlx rewritten script", ["pnpm", "dlx", "tsx", "./run.ts"], 3),
      );
      const prepared = buildSystemRunApprovalPlan({ command: fixture.command, cwd: tmp });
      requireSuccess(prepared);
      const mutableFileOperand = prepared.plan.mutableFileOperand;
      if (mutableFileOperand == null) {
        throw new Error("expected mutable file operand snapshot");
      }
      fs.writeFileSync(fixture.scriptPath, 'console.log("PWNED");\n');
      expect(
        revalidateApprovedMutableFileOperand({
          snapshot: mutableFileOperand,
          argv: prepared.plan.argv,
          cwd: prepared.plan.cwd ?? tmp,
        }),
      ).toBe(false);
    });
  });

  it("does not bind pnpm dlx shell-mode commands to a mutable file operand", () => {
    withFakeRuntimeBins(["pnpm", "tsx"], () => {
      const tmp = createFixtureDir("openclaw-pnpm-dlx-shell-mode-");
      fs.writeFileSync(path.join(tmp, "run.ts"), 'console.log("SAFE");\n');
      expect(
        resolveMutableFileOperandSnapshotSync({
          argv: ["pnpm", "dlx", "--shell-mode", "tsx ./run.ts"],
          cwd: tmp,
          shellCommand: null,
        }),
      ).toEqual({ ok: true, snapshot: null });
    });
  });

  it("allows pnpm dlx package binaries that do not bind mutable local files", () => {
    withFakeRuntimeBins(["pnpm", "eslint"], () => {
      const casesResult = [
        ["cowsay", "hello"],
        ["cowsay", "node"],
        ["cowsay", "node", "hello"],
        ["eslint", "src/index.ts"],
        ["cowsay", "tsx", "./run.ts"],
      ];
      for (const args of casesResult) {
        const tmp = createFixtureDir("openclaw-pnpm-dlx-package-");
        const file = args.at(-1);
        if (file === "src/index.ts" || file === "./run.ts") {
          writeFiles(tmp, [[file, 'console.log("SAFE");\n']]);
        }
        expectApprovalPlanWithoutMutableOperand(["pnpm", "dlx", ...args], tmp);
      }
    });
  });

  it("treats -- as the end of pnpm dlx option parsing", () => {
    withFakeRuntimeBins(["pnpm", "tsx"], () => {
      const { fixture, tmp } = makeScriptFixture(
        "openclaw-pnpm-dlx-double-dash-",
        runtimeFixture("pnpm dlx double dash", ["pnpm", "dlx", "--", "tsx", "./run.ts"], 4),
      );
      expectMutableFileOperandApprovalPlan(fixture, tmp);
    });
  });

  it("captures the real shell script operand after value-taking shell flags", () => {
    const shellOption = (name: string, flag: string, decoyName: string, shell = "/bin/bash") => ({
      name,
      decoyName,
      argv: [shell, flag, decoyName, "./run.sh"],
      expectedArgvIndex: 3,
    });
    const casesValue = [
      shellOption("separate set option", "-o", "errexit"),
      shellOption("combined set option", "-eo", "pipefail"),
      shellOption("combined trace option", "-xo", "errexit"),
      shellOption("combined unset option", "-uo", "nounset"),
      shellOption("plus set option", "+o", "histexpand"),
      shellOption("plus shopt option", "+O", "extglob"),
      shellOption("combined plus set option", "+eo", "pipefail"),
      shellOption("mksh plus set option", "+o", "errexit", "mksh"),
      {
        name: "yash plus interactive option",
        argv: ["yash", "+i", "./run.sh"],
        decoyName: "+i",
        expectedArgvIndex: 2,
      },
    ];

    for (const testCase of casesValue) {
      runNamedCase(testCase.name, () => {
        const tmp = createFixtureDir("openclaw-shell-option-value-");
        const scriptPath = path.join(tmp, "run.sh");
        fs.writeFileSync(scriptPath, "#!/bin/sh\necho SAFE\n");
        fs.writeFileSync(path.join(tmp, testCase.decoyName), "decoy\n");
        expectSnapshotRejectsRewrite(testCase.argv, tmp, scriptPath, testCase.expectedArgvIndex);
      });
    }
  });

  it("does not bind opaque shell command operands as mutable script files", () => {
    const { tmp } = makeScriptFixture("openclaw-opaque-shell-operand-", shellFixture);
    const snapshot = resolveMutableFileOperandSnapshotSync({
      argv: ["nu", "--commands", "./run.sh"],
      cwd: tmp,
      shellCommand: null,
    });
    expect(snapshot).toEqual({ ok: true, snapshot: null });
  });

  it.each(["config", "interactive"])("denies nushell inline payloads hidden by %s", (mode) => {
    const { tmp } = makeScriptFixture("openclaw-nu-hidden-inline-", shellFixture);
    const configPath = path.join(tmp, "config.nu");
    const options =
      mode === "config" ? [`--config=${configPath}`, "--commands"] : ["--interactive", "--execute"];
    if (mode === "config") {
      fs.writeFileSync(configPath, "print hidden\n");
    }
    expectRuntimeApprovalDenied(["nu", ...options, "./run.sh"], tmp);
  });

  it("denies startup-file shell wrappers with inline commands", () => {
    expect(buildSystemRunApprovalPlan({ command: ["tcsh", "-c", "echo SAFE"] })).toEqual(
      DENIED_RUNTIME_APPROVAL,
    );
    expect(
      buildSystemRunApprovalPlan({ command: ["osh", "--rcfile", "/tmp/evil", "-c", "echo SAFE"] }),
    ).toEqual(DENIED_RUNTIME_APPROVAL);
  });

  it("captures fish script operands with plus-prefixed filenames", () => {
    const casesLocal = [
      { name: "plus-prefixed fish script", argv: ["fish", "+setup.fish"] },
      {
        name: "plus-prefixed fish script before script args",
        argv: ["fish", "+setup.fish", "-c", "echo arg"],
      },
    ];

    for (const testCase of casesLocal) {
      runNamedCase(testCase.name, () => {
        const tmp = createFixtureDir("openclaw-fish-plus-script-");
        const scriptPath = path.join(tmp, "+setup.fish");
        fs.writeFileSync(scriptPath, "echo SAFE\n");
        expectSnapshotRejectsRewrite(testCase.argv, tmp, scriptPath, 1);
      });
    }
  });
});
