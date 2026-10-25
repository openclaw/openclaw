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

type ScriptOperandFixture = {
  command: string[];
  scriptPath: string;
  expectedArgvIndex: number;
};

type RuntimeFixture = [argv: string[], expectedArgvIndex: number];

type UnsafeRuntimeInvocationCase = [command: string[], files?: string[], binName?: string];

const shellFixture: RuntimeFixture = [["/bin/sh", "./run.sh"], 1];

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
  const command =
    fixture?.[0] ??
    (process.platform === "win32" ? [process.execPath, "./run.js"] : shellFixture[0]);
  const expectedArgvIndex = fixture?.[1] ?? 1;
  const scriptPath = path.join(tmp, path.basename(command[expectedArgvIndex]!));
  const body = scriptPath.endsWith(".sh")
    ? "#!/bin/sh\necho SAFE\n"
    : /\.(py|lua)$/.test(scriptPath)
      ? 'print("SAFE")\n'
      : 'console.log("SAFE");\n';
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
  return { command, scriptPath, expectedArgvIndex };
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

function writeFiles(tmp: string, files: string[], body = "SAFE\n") {
  for (const name of files) {
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

function expectMutableFileOperandApprovalPlan(fixture: ScriptOperandFixture, cwd: string) {
  const prepared = buildSystemRunApprovalPlan({ command: fixture.command, cwd });
  requireSuccess(prepared);
  expect(prepared.plan.mutableFileOperand).toEqual({
    argvIndex: fixture.expectedArgvIndex,
    path: fs.realpathSync(fixture.scriptPath),
    sha256: sha256FileSync(fixture.scriptPath),
  });
}

function makeScriptFixture(prefix: string, runtime?: RuntimeFixture) {
  const tmp = createFixtureDir(prefix);
  const fixture = createScriptOperandFixture(tmp, runtime);
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

const unsafeRuntimeInvocationCases: UnsafeRuntimeInvocationCase[] = [
  [["bun", "run", "dev"]],
  [["deno", "eval", "console.log('SAFE')"]],
  [["tsx", "--eval", "console.log('SAFE')"]],
  [["busybox", "awk", 'BEGIN{system("id")}'], ["awk"]],
  [["toybox", "awk", 'BEGIN{system("id")}']],
  [
    ["node", "--import=./pre=load.mjs", "./main.mjs"],
    ["main.mjs", "pre=load.mjs"],
  ],
  [["ruby", "-r", "attacker", "./safe.rb"], ["safe.rb"]],
  [["perl", "-MPreload", "./safe.pl"], ["safe.pl"]],
  [["perl", "-Ilib", "./safe.pl"], ["safe.pl"]],
  [["sh", "-lc", "node ./run.js"], ["run.js"], "node"],
  [["pnpm", "dlx", "--future-flag", "tsx", "./run.ts"], ["run.ts"]],
  [["pnpm", "--future-flag", "value", "dlx", "tsx", "./run.ts"], ["run.ts"]],
];

describe("hardenApprovedExecutionPaths", () => {
  it.runIf(process.platform !== "win32")("handles approval hardening cases", () => {
    const tmp = createFixtureDir("openclaw-approval-hardening-");
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir);
    const link = path.join(binDir, "poccmd");
    fs.symlinkSync("/bin/echo", link);
    const pinned = fs.realpathSync(link);
    withEnv({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }, () => {
      const wrapped = ["env", "poccmd", "SAFE"];
      const hardened = hardenApprovedExecutionPaths({
        approvedByAsk: true,
        argv: wrapped,
        shellCommand: null,
        cwd: tmp,
      });
      requireSuccess(hardened);
      expect(hardened.argv).toEqual(wrapped);
      for (const [argv, expectedArgv, commandText, commandPreview] of [
        [
          ["env", "sh", "-c", "echo SAFE"],
          ["env", "sh", "-c", "echo SAFE"],
          'env sh -c "echo SAFE"',
          "echo SAFE",
        ],
        [["poccmd", "hello"], [pinned, "hello"], formatExecCommand([pinned, "hello"]), null],
        [
          ["./env", "sh", "-c", "echo SAFE"],
          ["./env", "sh", "-c", "echo SAFE"],
          './env sh -c "echo SAFE"',
          "echo SAFE",
        ],
      ] satisfies [string[], string[], string, string | null][]) {
        const prepared = buildSystemRunApprovalPlan({ command: argv, cwd: tmp });
        requireSuccess(prepared);
        expect(prepared.plan).toMatchObject({ argv: expectedArgv, commandText, commandPreview });
      }
    });
  });

  const mutableOperandCases: RuntimeFixture[] = [
    [["python3", "-B", "./run.py"], 2],
    [["lua", "./run.lua"], 1],
    [["node20", "./run.js"], 1],
    [["tsx", "./run.ts"], 1],
    [["bun", "run", "./run.ts"], 2],
    [["deno", "run", "-A", "--allow-read", "--", "./run.ts"], 5],
    [["pnpm", "exec", "tsx", "./run.ts"], 3],
    [["pnpm", "dlx", "tsx", "./run.ts"], 3],
    [["pnpm", "--reporter", "silent", "dlx", "--package", "tsx", "tsx", "./run.ts"], 7],
    [["pnpm", "--reporter", "silent", "exec", "tsx", "./run.ts"], 5],
    [["pnpm", "-C", "./package", "exec", "tsx", "./run.ts"], 5],
    [["./pnpm.js", "exec", "tsx", "./run.ts"], 3],
    [["pnpm", "exec", "--", "tsx", "./run.ts"], 4],
    [["pnpm", "node", "./run.js"], 2],
    [["bunx", "tsx", "./run.ts"], 2],
    [["npm", "exec", "--", "tsx", "./run.ts"], 4],
    [["npm", "x", "--", "tsx", "./run.ts"], 4],
    [["npm", "--loglevel=silent", "exec", "--", "tsx", "./run.ts"], 5],
    [["npm", "-C", "./package", "exec", "--", "tsx", "./run.ts"], 6],
    [["pnpm", "dlx", "--", "tsx", "./run.ts"], 4],
  ];
  it("captures mutable runtime operands in approval plans", () => {
    const tmp = createFixtureDir("openclaw-approval-script-plan-");
    withFakeRuntimeBins(
      ["python3", "lua", "node20", "tsx", "bun", "deno", "bunx", "pnpm", "npm", "npx", "node"],
      () => {
        for (const runtimeCase of mutableOperandCases) {
          runNamedCase(JSON.stringify(runtimeCase[0]), () => {
            if (runtimeCase[0][0] === "./pnpm.js" && process.platform === "win32") {
              return;
            }
            const fixture = createScriptOperandFixture(tmp, runtimeCase);
            const executablePath = fixture.command[0];
            if (executablePath?.endsWith("pnpm.js")) {
              const shimPath = path.join(tmp, "pnpm.js");
              fs.writeFileSync(shimPath, "#!/usr/bin/env node\nconsole.log('shim')\n");
              fs.chmodSync(shimPath, 0o755);
            }
            expectMutableFileOperandApprovalPlan(fixture, tmp);
          });
        }
      },
    );
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

  it.runIf(process.platform !== "win32")(
    "keeps fail-closed behavior for mutable or ambiguous shell payload files",
    () => {
      const tmp = createFixtureDir("openclaw-shell-payload-");
      for (const [fileName, body] of [
        ["run.sh", "#!/bin/sh\necho SAFE\n"],
        ["empty", ""],
        ["mz-script", "MZ not really a PE file\n"],
        ["nul-script", "SAFE\u0000maybe-binary\n"],
      ] as const) {
        const scriptPath = path.join(tmp, fileName);
        fs.writeFileSync(scriptPath, body, { mode: 0o755 });
        expect(shellPlan(scriptPath, tmp)).toEqual(DENIED_RUNTIME_APPROVAL);
      }
    },
  );

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
      [
        ...new Set(
          unsafeRuntimeInvocationCases.map(([command, , binName]) => binName ?? command[0]!),
        ),
      ],
      () => {
        for (const [command, files = []] of unsafeRuntimeInvocationCases) {
          runNamedCase(JSON.stringify(command), () => {
            const tmp = createFixtureDir("openclaw-unsafe-runtime-");
            writeFiles(tmp, files);
            expectRuntimeApprovalDenied(command, tmp);
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
        ["eslint", "src/index.ts"],
        ["cowsay", "tsx", "./run.ts"],
      ];
      for (const args of casesResult) {
        const tmp = createFixtureDir("openclaw-pnpm-dlx-package-");
        const file = args.at(-1);
        if (file === "src/index.ts" || file === "./run.ts") {
          writeFiles(tmp, [file], 'console.log("SAFE");\n');
        }
        expectApprovalPlanWithoutMutableOperand(["pnpm", "dlx", ...args], tmp);
      }
    });
  });

  it("captures the real shell script operand after value-taking shell flags", () => {
    const cases: [argv: string[], decoy: string, index: number][] = [
      [["/bin/bash", "-o", "errexit", "./run.sh"], "errexit", 3],
      [["/bin/bash", "-eo", "pipefail", "./run.sh"], "pipefail", 3],
      [["/bin/bash", "+o", "histexpand", "./run.sh"], "histexpand", 3],
      [["/bin/bash", "+O", "extglob", "./run.sh"], "extglob", 3],
      [["/bin/bash", "+eo", "pipefail", "./run.sh"], "pipefail", 3],
      [["mksh", "+o", "errexit", "./run.sh"], "errexit", 3],
      [["yash", "+i", "./run.sh"], "+i", 2],
    ];
    for (const [argv, decoy, index] of cases) {
      runNamedCase(JSON.stringify(argv), () => {
        const tmp = createFixtureDir("openclaw-shell-option-value-");
        const scriptPath = path.join(tmp, "run.sh");
        fs.writeFileSync(scriptPath, "#!/bin/sh\necho SAFE\n");
        fs.writeFileSync(path.join(tmp, decoy), "decoy\n");
        expectSnapshotRejectsRewrite(argv, tmp, scriptPath, index);
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
    const tmp = createFixtureDir("openclaw-fish-plus-script-");
    const scriptPath = path.join(tmp, "+setup.fish");
    fs.writeFileSync(scriptPath, "echo SAFE\n");
    expectSnapshotRejectsRewrite(["fish", "+setup.fish", "-c", "echo arg"], tmp, scriptPath, 1);
  });
});
